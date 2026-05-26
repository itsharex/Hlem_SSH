export interface ApiDocParams {
  port: number;
  apiKey: string;
  sessionId: string;
  sessionName?: string;
  sessionHost?: string;
}

export function buildApiDoc(params: ApiDocParams): string {
  const { port, apiKey, sessionId, sessionName, sessionHost } = params;
  const sid = sessionId || "<sessionId>";
  const sessionLine = sessionName
    ? `会话: ${sessionName}${sessionHost ? ` (${sessionHost})` : ""} | ID: ${sid} （下文 \`<sid>\` 替换为此 ID）`
    : "模式: 全部会话（下文 `<sid>` 为占位，先用 GET /api/sessions 获取实际值）";

  return `# HelM AI API

本地 SSH/SFTP 网关。**默认走 HTTP REST，curl 一行直用**；WebSocket 仅给需要边跑边收输出 / 中途取消的高级场景。

## 接入

- Base: \`http://127.0.0.1:${port}\` （下文记作 \`<base>\`）
- Auth: header \`Authorization: Bearer ${apiKey}\`（HTTP 与 WS 统一）
- ${sessionLine}

## REST 端点

所有端点用 \`Authorization: Bearer\` 鉴权。POST/PUT/PATCH 请求 body 为 JSON（\`Content-Type: application/json\`）。

**会话**
- \`GET <base>/api/sessions\` → 已连接会话数组
- \`POST <base>/api/connect\` \`{sessionId}\` → ConnectionInfo（幂等，已连即返）
- \`POST <base>/api/disconnect\` \`{sessionId}\` → \`{success}\`

**操作**
- \`POST <base>/api/exec\` \`{sessionId, command, timeoutMs?}\` → \`{stdout, stderr, exitStatus, durationMs, timedOut}\`
- \`GET <base>/api/files?sessionId=&path=\` → 文件数组

**文件传输**
- \`PUT <base>/api/upload?sessionId=&remotePath=\` body 是字节流 → \`{success, remotePath, size}\`
- \`GET <base>/api/download?sessionId=&path=\` 支持 \`Range: bytes=start-end\`，越界返回 416

**隧道**（CRUD + start/stop）
- \`GET <base>/api/tunnels\` → 隧道数组
- \`POST <base>/api/tunnels\` \`{input}\` → 创建后返回隧道数组
- \`PATCH <base>/api/tunnels/{id}\` \`{input}\` → 更新后返回隧道数组
- \`DELETE <base>/api/tunnels/{id}\` → 删除后返回隧道数组
- \`POST <base>/api/tunnels/{id}/start\` → \`{forwardId, bindHost, bindPort}\`
- \`POST <base>/api/tunnels/{id}/stop\` → \`{success}\`

input: \`{name, sessionId, forwardType:"local"|"remote"|"dynamic", bindHost, bindPort, targetHost, targetPort}\`

**备份**
- \`GET <base>/api/backup/settings\` → 备份设置
- \`PUT <base>/api/backup/settings\` body: BackupSettings → 备份设置
- \`GET <base>/api/backup/records\` → 备份记录数组
- \`POST <base>/api/backup/run\` → 本次执行的结果数组
- \`DELETE <base>/api/backup/records/{id}?deleteFile=true\` → 剩余记录数组

## curl 速查

\`\`\`bash
KEY="${apiKey}"
BASE="http://127.0.0.1:${port}"
SID="${sid}"

# 连接 + 跑命令
curl -sH "Authorization: Bearer $KEY" -H content-type:application/json \\
  -XPOST $BASE/api/connect -d "{\\"sessionId\\":\\"$SID\\"}"
curl -sH "Authorization: Bearer $KEY" -H content-type:application/json \\
  -XPOST $BASE/api/exec -d "{\\"sessionId\\":\\"$SID\\",\\"command\\":\\"uname -a\\"}"

# 文件
curl -sH "Authorization: Bearer $KEY" "$BASE/api/files?sessionId=$SID&path=/"
curl -sH "Authorization: Bearer $KEY" -T ./local.tar \\
  "$BASE/api/upload?sessionId=$SID&remotePath=/tmp/r.tar"
curl -sH "Authorization: Bearer $KEY" -o ./out.tar \\
  "$BASE/api/download?sessionId=$SID&path=/tmp/r.tar"

# 隧道（启动一条已存在的隧道）
curl -sH "Authorization: Bearer $KEY" $BASE/api/tunnels
curl -sH "Authorization: Bearer $KEY" -XPOST $BASE/api/tunnels/<tunnelId>/start

# 备份（立即跑一次）
curl -sH "Authorization: Bearer $KEY" -XPOST $BASE/api/backup/run
\`\`\`

## WebSocket（仅流式 / 可取消场景）

如果只是跑普通命令，**忽略本节**。用 REST 即可。

WS endpoint: \`ws://127.0.0.1:${port}/api/ws\`，握手时带同一个 \`Authorization: Bearer\` header。请求 \`{id, type, ...}\`，响应共享 id。

WS 只保留三个命令：

- \`exec {sessionId, command, timeoutMs?, binary?}\` → 流式 \`stdout\` / \`stderr\` 帧 + \`done {exitCode, timedOut, durationMs}\`
- \`cancel {id}\` 中止指定 id 的进行中任务
- \`ping\` → \`pong\`

适合 WS 而不是 REST 的场景：
- 想边跑边收 stdout（如 \`tail -f\`、长时间编译输出）
- 中途要 \`cancel\` 进行中的任务
- 单连接复用降低开销

\`binary=true\` 时输出走 Binary frame（默认 false 即可，二进制场景才需要，详见 \`api_server/ws.rs\` 帧头说明）。

## 规则

- 操作前先 \`POST /api/connect\`（幂等）。错误中含"未连接"时先调它再重试。它顺手开 SFTP，无需额外步骤。
- 未知主机密钥不会自动信任，\`/api/connect\` 会直接报错，由用户在 HelM 主窗口确认指纹。
- \`exec\` 默认 30s 超时；超时返回 \`exitStatus=124\` 加 \`timedOut=true\`。
- 危险命令（\`rm -rf /\`、\`shutdown\` 等）一律被拒绝，不要尝试规避。

按状态码分流：

| 状态码 | 含义 | AI 应做 |
| --- | --- | --- |
| 200 / 206 | 成功 | 解析 body |
| 400 | 参数缺失或非法 | 检查请求字段 |
| 401 | API key 无效 | 不重试，停手 |
| 403 | 危险命令 / 无权访问该会话 | 不重试，换命令或换会话 |
| 404 | 资源不存在（如未知 tunnelId） | 检查 ID |
| 416 | Range 越界 | 调整 Range 重试 |
| 503 | 目标会话未连接 | 先 \`POST /api/connect\` 再重试 |
| 500 | 远端 / 内部错误 | 把 \`error\` 字段展示给用户 |`;
}
