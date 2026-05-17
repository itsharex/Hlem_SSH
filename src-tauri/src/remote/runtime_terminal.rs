use super::*;

/// 周期性 PTY keepalive 间隔。bash 的 TMOUT 计时器在 stdin 上 select()，
/// 任何字节到达都会重置；常见 TMOUT 设置 ≥60s，所以 30s 一次的 NUL 注入
/// 留足了余量。
const TERMINAL_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// xterm "alternate screen" 切换序列。vim/less/top/htop/man 等全屏程序进入
/// 时发 `\x1b[?1049h`，退出时发 `\x1b[?1049l`；老版本可能用 47 / 1047。
const ALT_SCREEN_ENTER: &[&[u8]] = &[b"\x1b[?1049h", b"\x1b[?1047h", b"\x1b[?47h"];
const ALT_SCREEN_LEAVE: &[&[u8]] = &[b"\x1b[?1049l", b"\x1b[?1047l", b"\x1b[?47l"];

fn update_alt_screen_state(data: &[u8], in_alt_screen: &AtomicBool) {
    // 简单线性扫描；每个输出 chunk 上 O(n*k)，k 是 6 个模式，单字节比较，
    // 实际开销可忽略。跨 chunk 边界的极少数情况会漏一次，但全屏程序通常
    // 会重复发送（如 vim 重绘）所以状态最终一致。
    for pat in ALT_SCREEN_ENTER {
        if data.windows(pat.len()).any(|w| w == *pat) {
            in_alt_screen.store(true, Ordering::Relaxed);
        }
    }
    for pat in ALT_SCREEN_LEAVE {
        if data.windows(pat.len()).any(|w| w == *pat) {
            in_alt_screen.store(false, Ordering::Relaxed);
        }
    }
}

impl RemoteRuntime {
    pub async fn open_terminal(
        &self,
        app: &AppHandle,
        connection_id: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<TerminalInfo> {
        let connection = self.connection(connection_id).await?;
        let channel = {
            let handle = connection.handle.lock().await;
            handle.channel_open_session().await.map_err(remote_error)?
        };
        let (mut read_half, write_half) = channel.split();
        write_half
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(remote_error)?;

        let terminal_id = Uuid::new_v4().to_string();
        // Inherit the friendly session label from the parent connection so "terminal not
        // found" logs show the session name instead of a UUID.
        if let Some(label) = crate::errors::resource_label(connection_id) {
            crate::errors::register_resource_label(&terminal_id, &label);
        }
        let writer = Arc::new(Mutex::new(write_half));
        let in_alt_screen = Arc::new(AtomicBool::new(false));
        let info = TerminalInfo {
            terminal_id: terminal_id.clone(),
            connection_id: connection_id.to_string(),
            cols,
            rows,
            opened_at: now(),
        };

        // 尝试通过 SSH 协议层把 TMOUT 置空（zero echo，shell 启动前生效）。
        // 多数 sshd 因 AcceptEnv 白名单会拒绝，失败静默忽略 —— 真正兜底的是
        // 后面 spawn 的 PTY keepalive 任务。
        {
            let writer = writer.lock().await;
            let _ = writer.set_env(false, "TMOUT", "").await;
        }

        // Request shell BEFORE spawning the reader task to avoid a race where
        // the reader sees EOF (channel rejected) and removes the terminal from
        // the registry before we even register it.
        {
            let writer = writer.lock().await;
            writer.request_shell(true).await.map_err(remote_error)?;
        }

        self.terminals.write().await.insert(
            terminal_id.clone(),
            TerminalRecord {
                info: info.clone(),
                writer: writer.clone(),
            },
        );

        let app_handle = app.clone();
        let terminals = self.terminals.clone();
        let closed_terminal_id = terminal_id.clone();
        let reader_connection_id = connection_id.to_string();
        let reader_handle = connection.handle.clone();
        let reader_runtime = self.clone();
        let reader_alt_screen = in_alt_screen.clone();
        tokio::spawn(async move {
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        update_alt_screen_state(&data, &reader_alt_screen);
                        emit_terminal_output(&app_handle, &closed_terminal_id, "output", &data)
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        emit_terminal_output(&app_handle, &closed_terminal_id, "error", &data)
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        events::emit(
                            &app_handle,
                            events::TERMINAL_OUTPUT,
                            TerminalOutputPayload {
                                terminal_id: closed_terminal_id.clone(),
                                kind: "system".to_string(),
                                data: format!("进程退出，状态码 {exit_status}"),
                                data_base64: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            let removed = terminals
                .write()
                .await
                .remove(&closed_terminal_id)
                .is_some();
            if removed {
                emit_terminal_closed(&app_handle, closed_terminal_id);
            }

            // 终端 reader 退出后，判断 SSH handle 是否也已经死亡（被 russh 内部
            // 的 keepalive_max 机制标记关闭）。如果是，主动清理整个连接并发
            // Disconnected 事件，前端就能显示"重新连接"按钮。
            // 仅当 shell 正常退出（如用户 `exit`）时 handle 仍存活，此时只清
            // 理终端，不动连接。
            let ssh_dead = match reader_handle.try_lock() {
                Ok(guard) => guard.is_closed(),
                Err(_) => false,
            };
            if ssh_dead {
                let removed_record = reader_runtime
                    .connections
                    .write()
                    .await
                    .remove(&reader_connection_id);
                if let Some(record) = removed_record {
                    reader_runtime
                        .close_children_for_connection(&app_handle, &record)
                        .await;
                    let mut info = record.info;
                    info.status = RuntimeStatus::Disconnected;
                    events::emit(&app_handle, events::SSH_STATUS, info);
                    crate::errors::forget_resource_label(&reader_connection_id);
                }
            }
        });

        // PTY keepalive：周期性向 PTY 注入 NUL 字节 (\x00) 重置远端 bash 的
        // TMOUT 计时器。TMOUT 在 read() 上用 select() 实现，任何字节到达都
        // 会重置等待；bash readline 收到 NUL 时默认绑定到 set-mark，对用户
        // 不可见、不进入命令缓冲、不进 history。
        //
        // 当终端进入"备用屏幕"（vim/less/top/htop/man 等）时暂停注入，避免
        // 干扰这些程序的输入流（例如 vim insert 模式的 Ctrl-@ 行为）。
        {
            let keepalive_terminal_id = terminal_id.clone();
            let keepalive_writer = writer.clone();
            let keepalive_terminals = self.terminals.clone();
            let keepalive_alt_screen = in_alt_screen.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(TERMINAL_KEEPALIVE_INTERVAL);
                ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
                // 跳过第一次立即触发的 tick，避免 shell 还在启动期就注入。
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    if !keepalive_terminals
                        .read()
                        .await
                        .contains_key(&keepalive_terminal_id)
                    {
                        break;
                    }
                    if keepalive_alt_screen.load(Ordering::Relaxed) {
                        continue;
                    }
                    let writer = keepalive_writer.lock().await;
                    let mut stream = writer.make_writer();
                    if stream.write_all(b"\x00").await.is_err() {
                        break;
                    }
                    let _ = stream.flush().await;
                }
            });
        }

        Ok(info)
    }

    pub async fn terminal_write(&self, terminal_id: &str, data: String) -> AppResult<()> {
        let writer = self.terminal_writer(terminal_id).await?;
        let writer = writer.lock().await;
        let mut stream = writer.make_writer();
        stream
            .write_all(data.as_bytes())
            .await
            .map_err(remote_error)?;
        stream.flush().await.map_err(remote_error)?;
        Ok(())
    }

    pub async fn terminal_resize(&self, terminal_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let record = self
            .terminals
            .read()
            .await
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AppError::missing_terminal(terminal_id))?;
        if record.info.cols == cols && record.info.rows == rows {
            return Ok(());
        }
        let result = {
            let writer = record.writer.lock().await;
            writer.window_change(cols as u32, rows as u32, 0, 0).await
        };
        result.map_err(remote_error)?;

        if let Some(record) = self.terminals.write().await.get_mut(terminal_id) {
            record.info.cols = cols;
            record.info.rows = rows;
        }
        Ok(())
    }

    pub async fn terminal_close(&self, app: &AppHandle, terminal_id: &str) -> AppResult<()> {
        let record = self
            .terminals
            .write()
            .await
            .remove(terminal_id)
            .ok_or_else(|| AppError::missing_terminal(terminal_id))?;
        close_terminal_record(record).await?;
        emit_terminal_closed(app, terminal_id.to_string());
        Ok(())
    }

    pub async fn exec_on_connection(
        &self,
        connection_id: &str,
        command: String,
        timeout_ms: Option<u64>,
    ) -> AppResult<ExecResult> {
        let connection = self.connection(connection_id).await?;
        exec_with_handle(
            &connection.handle,
            command,
            timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS),
        )
        .await
    }
}
