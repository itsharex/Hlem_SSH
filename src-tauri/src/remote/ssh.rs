use super::*;

pub(super) async fn authenticate(
    handle: &mut RawSshHandle,
    session: &SessionConfig,
) -> AppResult<()> {
    let authenticated = match session.auth.method {
        AuthMethod::Password => {
            let password = session
                .auth
                .password
                .as_deref()
                .ok_or_else(|| AppError::InvalidInput("密码认证缺少密码".to_string()))?;
            handle
                .authenticate_password(session.username.clone(), password)
                .await
                .map_err(remote_error)?
                .success()
        }
        AuthMethod::PrivateKey => {
            let passphrase = session.auth.private_key_passphrase.as_deref();
            let key = if let Some(imported) = session.auth.imported_private_key.as_deref() {
                decode_secret_key(imported, passphrase).map_err(remote_error)?
            } else {
                let path =
                    session.auth.private_key_path.as_deref().ok_or_else(|| {
                        AppError::InvalidInput("私钥认证缺少私钥路径".to_string())
                    })?;
                load_secret_key(Path::new(path), passphrase).map_err(remote_error)?
            };
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(remote_error)?
                .flatten();
            handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(remote_error)?
                .success()
        }
    };

    if authenticated {
        Ok(())
    } else {
        Err(AppError::Remote("SSH 认证失败".to_string()))
    }
}

pub(super) async fn exec_with_handle(
    handle: &SshHandle,
    command: String,
    timeout_ms: u64,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let mut channel = {
        let handle = handle.lock().await;
        handle.channel_open_session().await.map_err(remote_error)?
    };
    channel.exec(true, command).await.map_err(remote_error)?;

    let future = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                _ => {}
            }
        }
        (stdout, stderr, exit_status)
    };

    match timeout(Duration::from_millis(timeout_ms.max(1)), future).await {
        Ok((stdout, stderr, exit_status)) => Ok(ExecResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_status,
            duration_ms: started.elapsed().as_millis(),
            timed_out: false,
        }),
        Err(_) => Ok(ExecResult {
            stdout: String::new(),
            stderr: "命令执行超时".to_string(),
            exit_status: None,
            duration_ms: started.elapsed().as_millis(),
            timed_out: true,
        }),
    }
}
