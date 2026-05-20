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

WebSocket 是主通道（一次鉴权，长连接），上传/下载走 HTTP 但需先在 WS 上申请一次性票据（ticket）。
HTTP /api/auth 仅用于在打开 WS 之前测试 API Key 是否有效。

## 连接

WS: ${wsBase}/api/ws
Header: Authorization: Bearer ${apiKey}
（浏览器无法设置 header 时改用 \`?token=${apiKey}\` 查询参数）
${session}

## HTTP 端点

GET  /api/auth     — 验证 API Key（Header: Bearer ${apiKey}，可选探活）
POST /api/upload   — 上传文件（?ticket=... + multipart: sessionId, remotePath, file）
GET  /api/download — 下载文件（?ticket=&sessionId=&path= → 二进制流）

> upload/download 不再接受 Authorization header；必须先通过 WS issue-ticket 拿票，
> 票据 60 秒过期、一次性、与 sessionId 和用途（upload / download）绑定。

## WebSocket 请求类型

| type | 说明 | 字段 |
|------|------|------|
| issue-ticket | 申请上传/下载票 | sessionId?, purpose:"upload"\\|"download" |
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
// 1) 执行命令
{ "id": "1", "type": "exec", "sessionId": "${sid}", "command": "uname -a" }
{ "id": "1", "type": "stdout", "data": "Linux ...", "binary": false }
{ "id": "1", "type": "done", "exitCode": 0, "timedOut": false, "durationMs": 37 }

// 2) 申请上传/下载票，再走 HTTP（purpose 决定走哪个端点）
{ "id": "2", "type": "issue-ticket", "sessionId": "${sid}", "purpose": "download" }  // 或 "upload"
{ "id": "2", "type": "ticket", "ticket": "<60s 一次性>", "purpose": "download", "expiresIn": 60 }

// purpose=download → GET /api/download?ticket=<...>&sessionId=${sid}&path=/etc/hostname
// purpose=upload   → POST /api/upload?ticket=<...>
//                    multipart 字段顺序：sessionId → remotePath → file
\`\`\`

## 规则

- sessionId: ${sid}
- binary=true 时 data 为 base64，默认 false（UTF-8）
- timeoutMs 默认 30000，超时返回 exitCode=124
- error 含"未连接"→ 提示用户在 HelM 手动连接，不要自动重试
- 危险命令（rm -rf /usr、shutdown 等）被拒绝
- ticket 一次性、60s 过期、绑定 sessionId 和 purpose；不可跨用途重用
- multipart 上传时 \`sessionId\` 必须排在 \`file\` 之前（服务端在读 file 之前会先消费 ticket）`;
}
