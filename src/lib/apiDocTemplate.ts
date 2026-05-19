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
  const sid = sessionId || "<sessionId>";
  const session = sessionName
    ? `会话: ${sessionName}${sessionHost ? ` (${sessionHost})` : ""} | ID: ${sid}`
    : "模式: 全部会话（先发 list-sessions 获取 sessionId）";

  return `# HelM AI API

HTTP 仅用于鉴权验证和文件上传/下载，所有其他操作通过 WebSocket 完成。

## 连接

WS: ${wsBase}/api/ws
Header: Authorization: Bearer ${apiKey}
${session}

## HTTP（仅文件传输）

GET  /api/auth     — 验证 Key（返回 {"authenticated":true}）
POST /api/upload   — 上传文件（multipart: sessionId, remotePath, file）
GET  /api/download — 下载文件（?sessionId=&path= → 二进制流）

## WebSocket 请求类型

| type | 说明 | 字段 |
|------|------|------|
| exec | 执行命令（流式） | sessionId, command, timeoutMs?, binary? |
| list-sessions | 已连接会话 | — |
| list-files | 浏览目录 | sessionId, path |
| list-tunnels | 隧道列表 | — |
| create-tunnel | 新建隧道 | input:{name,sessionId,forwardType,bindHost,bindPort,targetHost,targetPort} |
| update-tunnel | 编辑隧道 | tunnelId, input:{...} |
| delete-tunnel | 删除隧道 | tunnelId |
| start-tunnel | 启动隧道 | tunnelId |
| stop-tunnel | 停止隧道 | tunnelId |
| backup-settings | 备份配置 | — |
| update-backup-settings | 更新备份配置 | settings:{...} |
| backup-records | 备份记录 | — |
| run-backup | 立即备份 | — |
| delete-backup-record | 删除记录 | recordId, deleteFile? |
| cancel | 取消请求 | id(同目标请求) |
| ping | 保活 | — |

## 请求/响应示例

\`\`\`jsonc
// 请求
{ "id": "1", "type": "exec", "sessionId": "${sid}", "command": "uname -a" }
// 响应
{ "id": "1", "type": "stdout", "data": "Linux ...", "binary": false }
{ "id": "1", "type": "done", "exitCode": 0, "timedOut": false, "durationMs": 37 }
\`\`\`

## 规则

- sessionId: ${sid}
- binary=true 时 data 为 base64，默认 false（UTF-8）
- timeoutMs 默认 30000，超时返回 exitCode=124
- error 含"未连接"→ 提示用户在 HelM 手动连接，不要自动重试
- 危险命令（rm -rf /usr、shutdown 等）被拒绝
- 文件传输走 HTTP，WS 不传文件
- 服务端 30s 心跳 Ping，客户端需回 Pong（库通常自动处理）`;
}
