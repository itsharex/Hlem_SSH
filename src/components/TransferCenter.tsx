import {
  ClearOutlined,
  CloseOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Empty, Progress, Space, Tooltip } from "antd";
import { formatBytes } from "../lib/format";
import type { BackupRecord, FileSaveRecord, RemoteSession, TransferInfo } from "../types";

interface TransferCenterProps {
  open: boolean;
  transfers: TransferInfo[];
  sessions: RemoteSession[];
  transferSessionIds: Record<string, string>;
  saveRecords: FileSaveRecord[];
  backupRecords: BackupRecord[];
  canUpload: boolean;
  onClose: () => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onOpenDir: (path: string) => void;
  onCancel: (transferId: string) => void;
  onRetry: (transferId: string) => void;
  onRemove: (transferId: string) => void;
  onRetrySave: (recordId: string) => void;
  onRemoveSave: (recordId: string) => void;
  onRestoreBackup: (recordId: string) => void;
  onRemoveBackup: (recordId: string) => void;
  onClear: () => void;
  onUploadFiles: (localPaths: string[]) => void;
}

export function TransferCenter({
  open,
  transfers,
  sessions,
  transferSessionIds,
  saveRecords,
  backupRecords,
  canUpload,
  onClose,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
  onRetrySave,
  onRemoveSave,
  onRestoreBackup,
  onRemoveBackup,
  onClear,
  onUploadFiles,
  onOpenDir,
}: TransferCenterProps) {
  const total = transfers.length + saveRecords.length + backupRecords.length;

  async function handleFileSelect() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ title: "选择上传文件", multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length > 0) onUploadFiles(paths);
  }

  return (
    <Drawer
      open={open}
      title={`任务记录${total ? ` · ${total} 条` : ""}`}
      placement="right"
      size={430}
      closable={false}
      className="transferDrawer"
      extra={
        <Space size={4}>
          <Tooltip title="上传文件">
            <Button
              aria-label="上传文件"
              icon={<UploadOutlined />}
              size="small"
              type="text"
              disabled={!canUpload}
              onClick={handleFileSelect}
            />
          </Tooltip>
          <Tooltip title="清空记录">
            <Button
              aria-label="清空记录"
              icon={<ClearOutlined />}
              size="small"
              type="text"
              disabled={total === 0}
              onClick={onClear}
            />
          </Tooltip>
          <Tooltip title="关闭">
            <Button
              aria-label="关闭"
              icon={<CloseOutlined />}
              size="small"
              type="text"
              onClick={onClose}
            />
          </Tooltip>
        </Space>
      }
      onClose={onClose}
    >
      {total === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务记录" />
      ) : (
        <div className="transferList">
          {renderAllRecords({
            transfers,
            saveRecords,
            backupRecords,
            sessions,
            transferSessionIds,
            onPause,
            onResume,
            onCancel,
            onRetry,
            onRemove,
            onRetrySave,
            onRemoveSave,
            onRestoreBackup,
            onRemoveBackup,
            onOpenDir,
          })}
        </div>
      )}
    </Drawer>
  );
}

interface RenderAllRecordsProps {
  transfers: TransferInfo[];
  saveRecords: FileSaveRecord[];
  backupRecords: BackupRecord[];
  sessions: RemoteSession[];
  transferSessionIds: Record<string, string>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenDir: (path: string) => void;
  onRetrySave: (id: string) => void;
  onRemoveSave: (id: string) => void;
  onRestoreBackup: (id: string) => void;
  onRemoveBackup: (id: string) => void;
}

type UnifiedRecord =
  | { type: "backup"; timestamp: number; record: BackupRecord }
  | { type: "save"; timestamp: number; record: FileSaveRecord }
  | { type: "transfer"; timestamp: number; record: TransferInfo };

function renderAllRecords(props: RenderAllRecordsProps) {
  const unified: UnifiedRecord[] = [];

  for (const record of props.backupRecords) {
    unified.push({ type: "backup", timestamp: new Date(record.createdAt).getTime() || 0, record });
  }
  for (const record of props.saveRecords) {
    unified.push({ type: "save", timestamp: new Date(record.savedAt).getTime() || 0, record });
  }
  for (const record of props.transfers) {
    unified.push({ type: "transfer", timestamp: new Date(record.createdAt).getTime() || 0, record });
  }

  // Active transfers first, then sort by time descending
  unified.sort((a, b) => {
    const aActive = isActiveRecord(a);
    const bActive = isActiveRecord(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  return unified.map((item) => {
    switch (item.type) {
      case "backup":
        return renderBackupRecord(item.record, props);
      case "save":
        return renderSaveRecord(item.record, props);
      case "transfer":
        return renderTransferRecord(item.record, props);
    }
  });
}

function isActiveRecord(item: UnifiedRecord): boolean {
  if (item.type === "transfer") {
    const status = item.record.status;
    return status === "queued" || status === "running" || status === "paused";
  }
  if (item.type === "save") {
    return item.record.status === "saving";
  }
  return false;
}

function renderBackupRecord(record: BackupRecord, props: RenderAllRecordsProps) {
  const restorable = record.status === "success";
  return (
    <article className="transferListItem backupRecordItem" key={`backup-${record.id}`}>
      <div className="transferListHeader">
        <div className="transferListTitle">
          <strong title={record.fileName}>{record.fileName}</strong>
          <span>
            {backupKindText(record.targetKind)} 备份 ·{" "}
            <span className={`saveRecordInlineStatus saveRecordInlineStatus-${record.status}`}>
              {backupStatusText(record.status)}
            </span>
          </span>
        </div>
        <Space size={4}>
          {restorable && (
            <Tooltip title="恢复此备份">
              <Button
                aria-label="恢复备份"
                icon={<ReloadOutlined />}
                size="small"
                onClick={() => props.onRestoreBackup(record.id)}
              />
            </Tooltip>
          )}
          <Tooltip title="删除记录">
            <Button
              aria-label="删除备份记录"
              icon={<DeleteOutlined />}
              size="small"
              onClick={() => props.onRemoveBackup(record.id)}
            />
          </Tooltip>
        </Space>
      </div>
      <div className="transferListPaths">
        <span title={record.targetPath}>位置：{record.targetPath}</span>
        <span>大小：{formatBytes(record.size)}</span>
        <span>时间：{formatBeijingTime(record.createdAt)}</span>
      </div>
      {record.error && <div className="transferListError">{record.error}</div>}
    </article>
  );
}

function renderSaveRecord(record: FileSaveRecord, props: RenderAllRecordsProps) {
  const retryable = record.status === "failed";
  return (
    <article className="transferListItem saveRecordItem" key={`save-${record.id}`}>
      <div className="transferListHeader">
        <div className="transferListTitle">
          <strong title={record.path}>{record.name}</strong>
          <span>
            编辑保存 · <span className={`saveRecordInlineStatus saveRecordInlineStatus-${record.status}`}>{saveStatusText(record.status)}</span>
          </span>
        </div>
        <Space size={4}>
          {retryable && (
            <Tooltip title="重试保存">
              <Button
                aria-label="重试保存"
                icon={<ReloadOutlined />}
                size="small"
                onClick={() => props.onRetrySave(record.id)}
              />
            </Tooltip>
          )}
          <Tooltip title="删除记录">
            <Button
              aria-label="删除保存记录"
              icon={<DeleteOutlined />}
              size="small"
              onClick={() => props.onRemoveSave(record.id)}
            />
          </Tooltip>
        </Space>
      </div>
      <div className="transferListPaths">
        <span title={record.directory}>目录：{record.directory}</span>
        <span>时间：{formatBeijingTime(record.savedAt)}</span>
      </div>
      {record.error && <div className="transferListError">{record.error}</div>}
    </article>
  );
}

function renderTransferRecord(transfer: TransferInfo, props: RenderAllRecordsProps) {
  const percent = transfer.bytesTotal
    ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
    : 0;
  const running = transfer.status === "queued" || transfer.status === "running";
  const paused = transfer.status === "paused";
  const retryable = transfer.status === "failed" || transfer.status === "canceled";
  const targetSession = sessionForTransfer(transfer, props.sessions, props.transferSessionIds);
  const targetConnected = Boolean(targetSession?.state === "connected" && targetSession.sftpId);
  const retryDisabled = retryable && !targetConnected;
  const retryTitle = retryDisabled ? "目标终端未连接" : transfer.direction === "upload" ? "重试上传" : "重新下载";
  const detailTooltip = transferDetailTooltip(transfer, targetSession, targetConnected);

  return (
    <Tooltip
      key={`transfer-${transfer.transferId}`}
      title={detailTooltip}
      placement="left"
      color="#ffffff"
      classNames={{ root: "detailHoverTooltip transferDetailHoverTooltip" }}
    >
      <article className="transferListItem">
        <div className="transferListHeader">
          <div className="transferListTitle">
            <strong>{transferName(transfer)}</strong>
            <span>
              {transfer.direction === "upload" ? "上传" : "下载"} ·{" "}
              <span className={`transferInlineStatus transferInlineStatus-${statusTone(transfer)}`}>
                {statusText(transfer)}
              </span>
            </span>
          </div>
          <Space size={4}>
            {running && (
              <Tooltip title="暂停">
                <Button
                  aria-label="暂停传输"
                  icon={<PauseOutlined />}
                  size="small"
                  onClick={() => props.onPause(transfer.transferId)}
                />
              </Tooltip>
            )}
            {paused && (
              <Tooltip title="继续">
                <Button
                  aria-label="继续传输"
                  icon={<PlayCircleOutlined />}
                  size="small"
                  onClick={() => props.onResume(transfer.transferId)}
                />
              </Tooltip>
            )}
            {retryable && (
              <Tooltip title={retryTitle}>
                <Button
                  aria-label="重试传输"
                  icon={<ReloadOutlined />}
                  size="small"
                  disabled={retryDisabled}
                  onClick={() => props.onRetry(transfer.transferId)}
                />
              </Tooltip>
            )}
            {(running || paused) && (
              <Tooltip title="停止">
                <Button
                  aria-label="停止传输"
                  icon={<StopOutlined />}
                  size="small"
                  danger
                  onClick={() => props.onCancel(transfer.transferId)}
                />
              </Tooltip>
            )}
            {transfer.direction === "download" && (
              <Tooltip title="打开文件夹">
                <Button
                  aria-label="打开文件夹"
                  icon={<FolderOpenOutlined />}
                  size="small"
                  onClick={() => props.onOpenDir(targetPath(transfer))}
                />
              </Tooltip>
            )}
            <Tooltip title="删除">
              <Button
                aria-label="删除传输"
                icon={<DeleteOutlined />}
                size="small"
                onClick={() => props.onRemove(transfer.transferId)}
              />
            </Tooltip>
          </Space>
        </div>
        <div className="transferListPaths">
          <span>
            {transfer.direction === "upload" ? "目标终端" : "来源终端"}：{targetSession?.name ?? "未知终端"}
            {targetSession ? ` · ${targetConnected ? "已连接" : "未连接"}` : ""}
          </span>
          <span>来源：{sourcePath(transfer)}</span>
          <span>{transfer.direction === "upload" ? "目标" : "保存"}：{targetPath(transfer)}</span>
        </div>
        <Progress
          percent={percent}
          size="small"
          status={progressStatus(transfer)}
          showInfo={false}
        />
        <div className="transferListMeta">
          <span>{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}</span>
          <span>{formatSpeed(transfer)}</span>
        </div>
        {transfer.error && !isTransferDone(transfer) && <div className="transferListError">{transfer.error}</div>}
      </article>
    </Tooltip>
  );
}

function saveStatusText(status: FileSaveRecord["status"]) {
  if (status === "saving") return "保存中";
  if (status === "success") return "保存成功";
  return "保存失败";
}

function backupStatusText(status: BackupRecord["status"]) {
  if (status === "success") return "备份成功";
  return "备份失败";
}

function backupKindText(kind: BackupRecord["targetKind"]) {
  if (kind === "local") return "本地";
  if (kind === "webdav") return "WebDAV";
  if (kind === "s3") return "S3";
  if (kind === "cloud") return "云端";
  return kind;
}

function formatBeijingTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function transferName(transfer: TransferInfo) {
  return transfer.localPath.split(/[\\/]/).pop() || transfer.remotePath.split("/").pop() || transfer.remotePath;
}

function sessionForTransfer(
  transfer: TransferInfo,
  sessions: RemoteSession[],
  transferSessionIds: Record<string, string>,
) {
  return (
    sessions.find((session) => session.sftpId === transfer.sftpId) ??
    sessions.find((session) => session.id === transferSessionIds[transfer.sftpId]) ??
    null
  );
}

function sourcePath(transfer: TransferInfo) {
  return transfer.direction === "upload" ? parentPath(transfer.localPath) : parentPath(transfer.remotePath);
}

function targetPath(transfer: TransferInfo) {
  return transfer.direction === "upload" ? parentPath(transfer.remotePath) : parentPath(transfer.localPath);
}

function parentPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized || "/";
  if (/^[A-Za-z]:$/.test(normalized.slice(0, index))) return `${normalized.slice(0, index)}/`;
  return normalized.slice(0, index);
}

function isTransferDone(transfer: TransferInfo) {
  return transfer.bytesTotal > 0 && transfer.bytesDone >= transfer.bytesTotal;
}

function statusText(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "已完成";
  const map: Record<TransferInfo["status"], string> = {
    queued: "等待中",
    running: "传输中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    canceled: "已停止",
  };
  return map[transfer.status];
}

function statusTone(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "success";
  if (transfer.status === "failed" || transfer.status === "canceled") return "failed";
  return "warning";
}

function progressStatus(transfer: TransferInfo) {
  if (isTransferDone(transfer)) return "success";
  if (transfer.status === "failed" || transfer.status === "canceled") return "exception";
  if (transfer.status === "completed") return "success";
  return "active";
}

function formatSpeed(transfer: TransferInfo) {
  if (transfer.status !== "running" || transfer.speedKbps <= 0) return "0 KB/s";
  return `${formatBytes(transfer.speedKbps * 1024)}/s`;
}

function transferDetailTooltip(
  transfer: TransferInfo,
  targetSession: RemoteSession | null,
  targetConnected: boolean,
) {
  return (
    <div className="detailHoverPanel transferDetailHoverPanel">
      <div className="detailHoverHeader">
        <div className="detailHoverTitle">{transferName(transfer)}</div>
        <div className={`detailHoverBadge detailHoverBadge-${statusTone(transfer)}`}>
          {transfer.direction === "upload" ? "上传" : "下载"} · {statusText(transfer)}
        </div>
      </div>
      <div className="detailHoverGrid">
        <span>终端</span>
        <strong>{targetSession?.name ?? "未知终端"}</strong>
        <span>来源</span>
        <strong>{sourcePath(transfer)}</strong>
        <span>{transfer.direction === "upload" ? "目标" : "保存"}</span>
        <strong>{targetPath(transfer)}</strong>
        <span>大小</span>
        <strong>{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}</strong>
        <span>创建时间</span>
        <strong>{formatBeijingTime(transfer.createdAt)}</strong>
        <span>更新时间</span>
        <strong>{formatBeijingTime(transfer.updatedAt)}</strong>
        {transfer.error && !isTransferDone(transfer) && (
          <>
            <span>错误</span>
            <strong className="detailHoverError">{transfer.error}</strong>
          </>
        )}
      </div>
    </div>
  );
}
