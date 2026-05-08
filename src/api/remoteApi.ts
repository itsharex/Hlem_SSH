import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConfigSnapshot,
  ConnectionInfo,
  ExecResult,
  ForwardInfo,
  ForwardStatusEvent,
  HostKeyVerification,
  RemoteFileEntry,
  ServerTelemetry,
  SftpChangedEvent,
  SftpInfo,
  TelemetryJobInfo,
  TerminalClosedEvent,
  TelemetrySnapshotEvent,
  TerminalInfo,
  TerminalOutputEvent,
  TransferInfo,
} from "../types";
import { isTauriRuntime } from "./runtime";

type Unlisten = () => void;

const EVENT_NAMES = {
  sshStatus: "ssh://status",
  terminalOutput: "terminal://output",
  terminalClosed: "terminal://closed",
  sftpChanged: "sftp://changed",
  telemetrySnapshot: "telemetry://snapshot",
  transferProgress: "transfer://progress",
  transferCompleted: "transfer://completed",
  transferFailed: "transfer://failed",
  hostKeyVerify: "host-key://verify",
  forwardStatus: "forward://status",
} as const;

export const remoteApi = {
  connect: (sessionId: string) =>
    call<ConnectionInfo>("ssh_connect", () => browserUnavailable("SSH 连接"), { sessionId }),
  disconnect: (connectionId: string) => call<void>("ssh_disconnect", () => undefined, { connectionId }),
  trustHostKey: (sessionId: string, algorithm: string, fingerprint: string) =>
    call<ConfigSnapshot>("ssh_trust_host_key", () => browserTrustHostKey(), { sessionId, algorithm, fingerprint }),
  openTerminal: (connectionId: string, cols = 100, rows = 30) =>
    call<TerminalInfo>("terminal_open", () => browserUnavailable("终端"), { connectionId, cols, rows }),
  writeTerminal: (terminalId: string, data: string) => call<void>("terminal_write", () => undefined, { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    call<void>("terminal_resize", () => undefined, { terminalId, cols, rows }),
  closeTerminal: (terminalId: string) => call<void>("terminal_close", () => undefined, { terminalId }),
  exec: (sessionId: string, command: string, timeoutMs = 20000) =>
    call<ExecResult>("ssh_exec", () => browserUnavailable("SSH 命令"), { sessionId, command, timeoutMs }),
  execOnConnection: (connectionId: string, command: string, timeoutMs = 20000) =>
    call<ExecResult>("ssh_exec_on_connection", () => browserUnavailable("SSH 命令"), {
      connectionId,
      command,
      timeoutMs,
    }),
  openSftp: (connectionId: string) => call<SftpInfo>("sftp_open", () => browserUnavailable("SFTP"), { connectionId }),
  listFiles: (sftpId: string, path: string) => call<RemoteFileEntry[]>("sftp_list", () => [], { sftpId, path }),
  searchFile: (sftpId: string, basePath: string, query: string) =>
    call<string | null>("sftp_search", () => null, { sftpId, basePath, query }),
  mkdir: (sftpId: string, path: string) => call<void>("sftp_mkdir", () => undefined, { sftpId, path }),
  createFile: (sftpId: string, path: string) =>
    call<void>("sftp_create_file", () => browserUnavailable("文件创建"), { sftpId, path }),
  delete: (sftpId: string, path: string, recursive = false) =>
    call<void>("sftp_delete", () => undefined, { sftpId, path, recursive }),
  rename: (sftpId: string, from: string, to: string) => call<void>("sftp_rename", () => undefined, { sftpId, from, to }),
  copy: (sftpId: string, from: string, to: string) => call<void>("sftp_copy", () => undefined, { sftpId, from, to }),
  readText: (sftpId: string, path: string) =>
    call<string>("sftp_read_text", () => browserUnavailable("文件读取"), { sftpId, path }),
  writeText: (sftpId: string, path: string, content: string) =>
    call<void>("sftp_write_text", () => browserUnavailable("文件保存"), { sftpId, path, content }),
  upload: (
    sftpId: string,
    localPath: string,
    remotePath: string,
    overwrite = false,
    accelerated = false,
    resume = false,
  ) =>
    call<TransferInfo>("transfer_upload", () => browserUnavailable("文件上传"), {
      sftpId,
      localPath,
      remotePath,
      overwrite,
      accelerated,
      resume,
    }),
  download: (sftpId: string, remotePath: string, localPath: string, overwrite = false) =>
    call<TransferInfo>("transfer_download", () => browserUnavailable("文件下载"), {
      sftpId,
      remotePath,
      localPath,
      overwrite,
    }),
  cancelTransfer: (transferId: string) => call<void>("transfer_cancel", () => undefined, { transferId }),
  pauseTransfer: (transferId: string) =>
    call<TransferInfo>("transfer_pause", () => browserUnavailable("传输暂停"), { transferId }),
  resumeTransfer: (transferId: string) =>
    call<TransferInfo>("transfer_resume", () => browserUnavailable("传输恢复"), { transferId }),
  removeTransfer: (transferId: string) => call<void>("transfer_remove", () => undefined, { transferId }),
  retryTransfer: (transferId: string) =>
    call<TransferInfo>("transfer_retry", () => browserUnavailable("传输重试"), { transferId }),
  startTelemetry: (connectionId: string, sessionId: string, intervalMs = 5000) =>
    call<TelemetryJobInfo>("telemetry_start", () => browserUnavailable("监控"), { connectionId, sessionId, intervalMs }),
  stopTelemetry: (jobId: string) => call<void>("telemetry_stop", () => undefined, { jobId }),
  telemetrySnapshot: (connectionId: string) =>
    call<ServerTelemetry>("telemetry_snapshot", () => browserUnavailable("监控"), { connectionId }),
  startLocalForward: (
    sessionId: string,
    bindHost: string,
    bindPort: number,
    remoteHost: string,
    remotePort: number,
  ) =>
    call<ForwardInfo>(
      "forward_start_local",
      () => browserUnavailable("本地端口转发"),
      { sessionId, bindHost, bindPort, remoteHost, remotePort },
    ),
  startRemoteForward: (
    sessionId: string,
    remoteBindHost: string,
    remoteBindPort: number,
    localHost: string,
    localPort: number,
  ) =>
    call<ForwardInfo>(
      "forward_start_remote",
      () => browserUnavailable("远端端口转发"),
      { sessionId, remoteBindHost, remoteBindPort, localHost, localPort },
    ),
  startDynamicForward: (sessionId: string, bindHost: string, bindPort: number) =>
    call<ForwardInfo>("forward_start_dynamic", () => browserUnavailable("动态端口转发"), {
      sessionId,
      bindHost,
      bindPort,
    }),
  stopForward: (forwardId: string) => call<void>("forward_stop", () => undefined, { forwardId }),
  listForwards: () => call<ForwardInfo[]>("forward_list", () => [], undefined),
  onForwardStatus: (handler: (payload: ForwardStatusEvent) => void) => listenEvent(EVENT_NAMES.forwardStatus, handler),
  onSshStatus: (handler: (payload: ConnectionInfo) => void) => listenEvent(EVENT_NAMES.sshStatus, handler),
  onSftpChanged: (handler: (payload: SftpChangedEvent) => void) => listenEvent(EVENT_NAMES.sftpChanged, handler),
  onTerminalOutput: (handler: (payload: TerminalOutputEvent) => void) => listenEvent(EVENT_NAMES.terminalOutput, handler),
  onTerminalClosed: (handler: (payload: TerminalClosedEvent) => void) => listenEvent(EVENT_NAMES.terminalClosed, handler),
  onTelemetrySnapshot: (handler: (payload: TelemetrySnapshotEvent) => void) =>
    listenEvent(EVENT_NAMES.telemetrySnapshot, handler),
  onTransferProgress: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferProgress, handler),
  onTransferCompleted: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferCompleted, handler),
  onTransferFailed: (handler: (payload: TransferInfo) => void) => listenEvent(EVENT_NAMES.transferFailed, handler),
  onHostKeyVerify: (handler: (payload: HostKeyVerification) => void) => listenEvent(EVENT_NAMES.hostKeyVerify, handler),
};

function call<T>(command: string, browserFallback: () => T | Promise<T>, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) return invoke<T>(command, args);
  return Promise.resolve(browserFallback());
}

async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (!isTauriRuntime()) return () => undefined;
  return listen<T>(event, (message) => handler(message.payload));
}

function browserUnavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new Error(`浏览器环境无法使用：${capability}`));
}

function browserTrustHostKey(): ConfigSnapshot {
  throw new Error("浏览器环境无法保存 SSH 主机密钥");
}
