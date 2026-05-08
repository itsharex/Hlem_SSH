# HelM

一个基于 **Tauri 2** + **React** + **TypeScript** 构建的 SSH/SFTP 桌面工作站。

## 功能特性

- SSH 终端 —— 多会话管理、实时连接状态、xterm.js 终端模拟
- SFTP 文件管理 —— 远程文件浏览、上传/下载、拖拽操作、断点续传
- 端口转发 —— 本地/远程/动态转发配置与管理
- 数据备份 —— 自动备份、手动备份、备份恢复
- 工作区加密 —— 主密码保护，敏感数据本地加密存储
- 系统托盘 —— 最小化到托盘、托盘菜单快捷操作

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, TypeScript, Ant Design 5, CodeMirror 6, xterm.js |
| 后端 | Tauri 2, Rust, russh, russh-sftp, tokio |
| 构建 | Vite, Cargo |

## 开发环境

### 前置要求

- Node.js >= 18
- Rust (stable)
- pnpm / npm / yarn

### 启动开发服务器

```powershell
# 安装依赖
npm install

# 启动开发模式 (热重载)
npm run tauri:dev
```

### 生产编译

```powershell
# 使用交互式脚本
.\build.ps1

# 或直接运行
npm run tauri:build
```

`build.ps1` 提供:
- **LTO 编译** —— 体积更小，编译更慢
- **普通编译** —— 速度快
- **清理缓存** —— 清除 target 目录

## 项目结构

```
Helm/
├── src/                    # React 前端源码
│   ├── api/                # Tauri 命令调用封装
│   ├── app/                # 应用状态与主题
│   ├── components/         # UI 组件
│   ├── lib/                # 工具函数
│   └── styles/             # CSS 样式
├── src-tauri/              # Rust 后端源码
│   ├── src/
│   │   ├── remote/         # SSH/SFTP 连接管理
│   │   ├── commands.rs     # Tauri 命令定义
│   │   ├── vault.rs        # 加密存储
│   │   └── ...
│   └── tauri.conf.json     # Tauri 配置
├── build.ps1               # Windows 编译脚本
└── package.json
```

## 安全说明

- 所有敏感数据（密码、私钥等）使用 **ChaCha20-Poly1305** 加密存储
- 主密码由用户设置，不存储于任何地方
- 连接信息可通过数据备份功能导出/导入

## License

MIT
