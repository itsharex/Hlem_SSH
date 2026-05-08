import {
  ClearOutlined,
  CloseOutlined,
  DeleteOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Empty, Progress, Space, Tooltip } from "antd";
import { formatBytes } from "../lib/format";
import type { FileSaveRecord, RemoteSession, TransferInfo } from "../types";

interface TransferCenterProps {
  open: boolean;
  transfers: TransferInfo[];
  sessions: RemoteSession[];
  transferSessionIds: Record<string, string>;
  saveRecords: FileSaveRecord[];
  onClose: () => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onCancel: (transferId: string) => void;
  onRetry: (transferId: string) => void;
  onRemove: (transferId: string) => void;
  onRetrySave: (recordId: string) => void;
  onRemoveSave: (recordId: string) => void;
  onClear: () => void;
}

export function TransferCenter({
  open,
  transfers,
  sessions,
  transferSessionIds,
  saveRecords,
  onClose,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
  onRetrySave,
  onRemoveSave,
  onClear,
}: TransferCenterProps) {
  const total = transfers.length + saveRecords.length;
  return (
    <Drawer
      open={open}
      title={`任务记录${total ? ` · ${total} 条` : ""}`}
      placement="right"
      width={430}
      closeIcon={<CloseOutlined />}
      className="transferDrawer"
      extra={
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
      }
      onClose={onClose}
    >
      {total === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务记录" />
      ) : (
        <div className="transferList">
          {saveRecords.map((record) => {
            const retryable = record.status === "failed";
            return (
              <article className="transferListItem saveRecordItem" key={record.id}>
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
                          onClick={() => onRetrySave(record.id)}
                        />
                      </Tooltip>
                    )}
                    <Tooltip title="删除记录">
                      <Button
                        aria-label="删除保存记录"
                        icon={<DeleteOutlined />}
                        size="small"
                        onClick={() => onRemoveSave(record.id)}
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
          })}
          {transfers.map((transfer) => {
            const percent = transfer.bytesTotal
              ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
              : 0;
            const running = transfer.status === "queued" || transfer.status === "running";
            const paused = transfer.status === "paused";
            const retryable = transfer.status === "failed" || transfer.status === "canceled";
            const targetSession = sessionForTransfer(transfer, sessions, transferSessionIds);
            const targetConnected = Boolean(targetSession?.state === "connected" && targetSession.sftpId);
            const retryDisabled = retryable && !targetConnected;
            const retryTitle = retryDisabled ? "目标终端未连接" : "重试";
            const detailTooltip = transferDetailTooltip(transfer, targetSession, targetConnected);

            return (
              <Tooltip
                key={transfer.transferId}
                title={detailTooltip}
                placement="left"
                overlayClassName="detailHoverTooltip transferDetailHoverTooltip"
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
                            onClick={() => onPause(transfer.transferId)}
                          />
                        </Tooltip>
                      )}
                      {paused && (
                        <Tooltip title="继续">
                          <Button
                            aria-label="继续传输"
                            icon={<PlayCircleOutlined />}
                            size="small"
                            onClick={() => onResume(transfer.transferId)}
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
                            onClick={() => onRetry(transfer.transferId)}
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
                            onClick={() => onCancel(transfer.transferId)}
                          />
                        </Tooltip>
                      )}
                      <Tooltip title="删除">
                        <Button
                          aria-label="删除传输"
                          icon={<DeleteOutlined />}
                          size="small"
                          onClick={() => onRemove(transfer.transferId)}
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
                    <span>目标：{targetPath(transfer)}</span>
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
                  {transfer.error && <div className="transferListError">{transfer.error}</div>}
                </article>
              </Tooltip>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

function saveStatusText(status: FileSaveRecord["status"]) {
  if (status === "saving") return "保存中";
  if (status === "success") return "保存成功";
  return "保存失败";
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

function sessionTitle(session: RemoteSession) {
  return `${session.name} · ${session.username}@${session.host}`;
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

function statusText(transfer: TransferInfo) {
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
  if (transfer.status === "completed") return "success";
  if (transfer.status === "failed" || transfer.status === "canceled") return "failed";
  return "warning";
}

function progressStatus(transfer: TransferInfo) {
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
        <span>目标</span>
        <strong>{targetPath(transfer)}</strong>
        <span>大小</span>
        <strong>{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}</strong>
        <span>创建时间</span>
        <strong>{formatBeijingTime(transfer.createdAt)}</strong>
        <span>更新时间</span>
        <strong>{formatBeijingTime(transfer.updatedAt)}</strong>
        {transfer.error && (
          <>
            <span>错误</span>
            <strong className="detailHoverError">{transfer.error}</strong>
          </>
        )}
      </div>
    </div>
  );
}
