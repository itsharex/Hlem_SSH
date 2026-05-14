import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Empty, Tooltip, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import { appApi, type ApiLogEntry } from "../api/appApi";

export function LogWindowApp() {
  const [logs, setLogs] = useState<ApiLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const poll = () => void appApi.apiServerLogs().then(setLogs).catch(() => undefined);
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, []);

  const reversed = [...logs].reverse();

  function copyLogs() {
    if (logs.length === 0) return;
    const lines = reversed.map((log) => {
      const status = log.success ? "OK" : "ERR";
      return `[${formatLogTime(log.timestamp)}] [${status}] ${log.action} | ${log.detail} | ${log.durationMs}ms`;
    });
    const text = lines.join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copySingleLog(log: ApiLogEntry, index: number) {
    const status = log.success ? "OK" : "ERR";
    const text = `[${formatLogTime(log.timestamp)}] [${status}] ${log.action} | ${log.detail} | ${log.durationMs}ms${log.response ? "\n" + log.response : ""}`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    });
  }

  function handleMouseEnter(index: number, event: React.MouseEvent) {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const listRect = listRef.current?.getBoundingClientRect();
    const top = rect.bottom - (listRect?.top ?? 0) + 4;
    const left = 12;
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverIndex(index);
      setPopoverPos({ top, left });
    }, 300);
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverIndex(null);
    setPopoverPos(null);
  }

  const hoveredLog = hoverIndex !== null ? reversed[hoverIndex] : null;

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <div className="logWindow">
        <header className="logWindowHeader">
          <span className="logWindowTitle">操作日志</span>
          <div className="logWindowHeaderRight">
            <span className="logWindowCount">{logs.length} 条记录</span>
            <Tooltip title={copied ? "已复制" : "复制日志"}>
              <Button
                size="small"
                type="text"
                icon={copied ? <CheckOutlined style={{ color: "#10b981" }} /> : <CopyOutlined />}
                disabled={logs.length === 0}
                onClick={copyLogs}
              />
            </Tooltip>
          </div>
        </header>
        <div className="logWindowBody" ref={listRef} style={{ position: "relative" }}>
          {reversed.length === 0 ? (
            <div className="logWindowEmpty">
              <Empty description="暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <div className="logWindowList">
              {reversed.map((log, i) => (
                <div
                  key={i}
                  className={`aiApiLogItem aiApiLogItem-${log.success ? "ok" : "err"}`}
                  onMouseEnter={(e) => handleMouseEnter(i, e)}
                  onMouseLeave={handleMouseLeave}
                >
                  <span className="aiApiLogTime">{formatLogTime(log.timestamp)}</span>
                  <span className={`aiApiLogAction aiApiLogAction-${log.action}`}>{log.action.toUpperCase()}</span>
                  <span className="aiApiLogDetail">{log.detail}</span>
                  <span className="aiApiLogDuration">{log.durationMs}ms</span>
                  <span
                    className={`aiApiLogCopy${copiedIndex === i ? " aiApiLogCopy-done" : ""}`}
                    role="button"
                    tabIndex={0}
                    title="复制此条"
                    onClick={(e) => { e.stopPropagation(); copySingleLog(log, i); }}
                    onKeyDown={(e) => { if (e.key === "Enter") copySingleLog(log, i); }}
                  >
                    {copiedIndex === i ? <CheckOutlined /> : <CopyOutlined />}
                  </span>
                </div>
              ))}
            </div>
          )}
          {hoveredLog && popoverPos && (
            <div
              className="logDetailPopover"
              style={{ top: popoverPos.top, left: popoverPos.left }}
              onMouseEnter={() => { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); }}
              onMouseLeave={handleMouseLeave}
            >
              <div className="logDetailSection">
                <span className="logDetailLabel">命令</span>
                <pre className="logDetailCommand">{hoveredLog.detail}</pre>
              </div>
              {hoveredLog.response && (
                <div className="logDetailSection">
                  <span className="logDetailLabel">响应</span>
                  <pre className="logDetailResponse">{hoveredLog.response}</pre>
                </div>
              )}
              <div className="logDetailMeta">
                <span>{formatLogTime(hoveredLog.timestamp)}</span>
                <span>{hoveredLog.durationMs}ms</span>
                <span className={hoveredLog.success ? "logDetailMetaOk" : "logDetailMetaErr"}>
                  {hoveredLog.success ? "成功" : "失败"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </ConfigProvider>
  );
}

/** 将 UTC 时间戳转为北京时间，格式：05-14 15:40:43 */
function formatLogTime(timestamp: string): string {
  // 后端格式: "2025-05-14 07:40:43" (UTC)
  // 加 Z 后缀让 Date 识别为 UTC
  const normalized = timestamp.includes("T") || timestamp.includes("Z") ? timestamp : timestamp + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return timestamp;
  // 转北京时间 (UTC+8)
  const bjt = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const mm = String(bjt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bjt.getUTCDate()).padStart(2, "0");
  const hh = String(bjt.getUTCHours()).padStart(2, "0");
  const mi = String(bjt.getUTCMinutes()).padStart(2, "0");
  const ss = String(bjt.getUTCSeconds()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}
