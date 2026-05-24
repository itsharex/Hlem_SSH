export interface ApiDocParams {
  port: number;
  apiKey: string;
  sessionId: string;
  sessionName?: string;
  sessionHost?: string;
}

export function buildApiDoc(params: ApiDocParams): string {
  const { port, apiKey, sessionId, sessionName, sessionHost } = params;
  const wsBase = `ws://127.0.0.1:${port}`;
  const httpBase = `http://127.0.0.1:${port}`;
  const sid = sessionId || "<sessionId>";
  const session = sessionName
    ? `会话: ${sessionName}${sessionHost ? ` (${sessionHost})` : ""} | ID: ${sid}`
    : "模式: 全部会话（先发 list-sessions 获取 sessionId）";

  return `# HelM AI API

这是给 AI 客户端使用的本地控制 API。WebSocket 是主通道；上传/下载走 HTTP，但必须先通过 WebSocket 申请一次性 ticket。

## 连接与鉴权

WS: ${wsBase}/api/ws
Auth: Header \`Authorization: Bearer ${apiKey}\`
Browser fallback: \`${wsBase}/api/ws?token=${apiKey}\`
${session}

可选探活: \`GET ${httpBase}/api/auth\`，同样使用 Bearer header。WebSocket 支持自动协商 permessage-deflate，客户端通常无需特殊处理。

## WebSocket 协议

请求统一是 JSON Text frame: \`{ "id": string, "type": string, ...fields }\`
普通结果: \`{ "id": "...", "type": "result", "data": ... }\`
错误: \`{ "id": "...", "type": "error", "error": "..." }\`

| type | fields | result |
| --- | --- | --- |
| ping | - | \`pong\` |
| cancel | \`id\` 取要取消的请求 id | \`cancelled\` |
| list-sessions | - | 会话数组 |
| list-files | \`sessionId,path\` | 文件数组 |
| exec | \`sessionId,command,timeoutMs?,binary?\` | 流式输出，最后 \`done\` |
| issue-ticket | \`sessionId?,purpose:"upload"\\|"download"\` | \`ticket,purpose,expiresIn\` |
| list-tunnels | - | 隧道数组 |
| create-tunnel | \`input:{name,sessionId,forwardType,bindHost,bindPort,targetHost,targetPort}\` | 隧道数组 |
| update-tunnel | \`tunnelId,input:{...}\` | 隧道数组 |
| delete-tunnel | \`tunnelId\` | 隧道数组 |
| start-tunnel | \`tunnelId\` | \`{forwardId,bindHost,bindPort}\` |
| stop-tunnel | \`tunnelId\` | \`{success:true}\` |
| backup-settings | - | 备份设置 |
| update-backup-settings | \`settings\` | 备份设置 |
| backup-records | - | 备份记录数组 |
| run-backup | - | 本次备份结果数组 |
| delete-backup-record | \`recordId,deleteFile?\` | 备份记录数组 |

## 常用消息

\`\`\`jsonc
{ "id": "1", "type": "list-sessions" }
{ "id": "2", "type": "list-files", "sessionId": "${sid}", "path": "/" }
{ "id": "3", "type": "exec", "sessionId": "${sid}", "command": "uname -a", "timeoutMs": 30000 }
{ "id": "3", "type": "stdout", "data": "Linux ...", "binary": false }
{ "id": "3", "type": "done", "exitCode": 0, "timedOut": false, "durationMs": 37, "binary": false }
{ "id": "4", "type": "issue-ticket", "sessionId": "${sid}", "purpose": "download" }
{ "id": "4", "type": "ticket", "ticket": "<ticket>", "purpose": "download", "expiresIn": 60 }
\`\`\`

## 文件传输

HTTP 上传/下载不接受 Authorization header，必须先走 \`issue-ticket\`。ticket 一次性、60 秒过期，并绑定 purpose 与 sessionId；每个 HTTP 请求都要新 ticket。

Upload: \`PUT ${httpBase}/api/upload?ticket=<ticket>&sessionId=${sid}&remotePath=/tmp/foo\`
Body: 文件原始字节流。成功返回 \`{success,remotePath,size}\`。

Download: \`GET ${httpBase}/api/download?ticket=<ticket>&sessionId=${sid}&path=/tmp/foo\`
支持 \`Range: bytes=start-end\`，成功返回文件字节；Range 越界返回 416。

## 规则

- 默认 sessionId: ${sid}
- \`exec.timeoutMs\` 默认 30000；超时通常返回 \`exitCode=124,timedOut=true\`
- \`exec.binary=false\`: stdout/stderr 走 JSON Text frame，字段为 \`data\`
- \`exec.binary=true\`: stdout/stderr 走 Binary frame，格式 \`[u8 stream][u8 id_len][id_bytes][payload]\`，stream 0=stdout、1=stderr；最后仍有 JSON \`done\`
- error 包含"未连接"时，提示用户在 HelM 手动连接，不要自动重试
- 危险命令（rm -rf /usr、shutdown 等）被拒绝
- 服务只监听本机 \`127.0.0.1\`，不要把 API Key 暴露给不可信页面`;
}
