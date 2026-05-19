import { CheckOutlined, CloseOutlined, CopyOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Empty, Tooltip, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import { appApi, type ApiLogEntry } from "../api/appApi";
import { appEvents } from "../api/appEvents";

export function LogWindowApp() {
  const [logs, setLogs] = useState<ApiLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [detailCopied, setDetailCopied] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ApiLogEntry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 启动时拉取一次全量历史；之后通过 api://log 事件增量推送。
    // 加 5s fallback 轮询兜底（子窗口可能因 capabilities 限制收不到 emit 事件）。
    const load = () => void appApi.apiServerLogs().then(setLogs).catch(() => undefined);
    load();
    let mounted = true;
    let unlisten: (() => void) | null = null;
    let fallbackTimer: number | null = null;
    void appEvents.onApiLog((entry) => {
      if (!mounted) return;
      // 收到推送说明事件通道正常，停掉 fallback 轮询
      if (fallbackTimer !== null) { clearInterval(fallbackTimer); fallbackTimer = null; }
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    }).then((u) => {
      if (!mounted) { u(); return; }
      unlisten = u;
      // 注册成功后启动 fallback：如果 5s 内没收到任何事件，开始轮询
      fallbackTimer = window.setInterval(load, 5000);
    }).catch(() => {
      // listen 失败，直接用轮询
      if (mounted) fallbackTimer = window.setInterval(load, 3000);
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
      if (fallbackTimer !== null) clearInterval(fallbackTimer);
    };
  }, []);

  const reversed = [...logs].reverse();

  function copyLogs() {
    if (logs.length === 0) return;
    const text = reversed.map((log) => {
      const lines = [
        `[${formatLogTime(log.timestamp)}] ${log.success ? "OK" : "ERR"} ${log.action} | ${log.detail} (${log.durationMs}ms)`,
        ...(log.response ? [log.response] : []),
      ];
      return lines.join("\n");
    }).join("\n\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copySingleLog(log: ApiLogEntry, index: number) {
    const lines = [
      `时间: ${formatLogTime(log.timestamp)}`,
      `状态: ${log.success ? "成功" : "失败"}`,
      `类型: ${log.action}`,
      `命令: ${log.detail}`,
      `耗时: ${log.durationMs}ms`,
      ...(log.response ? [`\n--- 响应 ---\n${log.response}`] : []),
    ];
    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    });
  }

  function handleClick(log: ApiLogEntry) {
    setSelectedLog(log);
  }

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
                  onClick={() => handleClick(log)}
                  style={{ cursor: "pointer" }}
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
          {selectedLog && (
            <div className="logDetailModal-overlay" onClick={() => { setSelectedLog(null); setDetailCopied(false); }}>
              <div className="logDetailModal" onClick={(e) => e.stopPropagation()}>
                <div className="logDetailModalHeader">
                  <span className="logDetailModalTitle">日志详情</span>
                  <span
                    className="logDetailModalClose"
                    role="button"
                    tabIndex={0}
                    title="关闭"
                    onClick={() => { setSelectedLog(null); setDetailCopied(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelectedLog(null); setDetailCopied(false); } }}
                  >
                    <CloseOutlined />
                  </span>
                </div>
                <div className="logDetailSection">
                  <div className="logDetailLabelRow">
                    <span className="logDetailLabel">命令</span>
                    <span
                      className={`aiApiLogCopy${detailCopied ? " aiApiLogCopy-done" : ""}`}
                      role="button"
                      tabIndex={0}
                      title="复制此条"
                      style={{ opacity: 1 }}
                      onClick={() => {
                        const lines = [
                          `时间: ${formatLogTime(selectedLog.timestamp)}`,
                          `状态: ${selectedLog.success ? "成功" : "失败"}`,
                          `类型: ${selectedLog.action}`,
                          `命令: ${selectedLog.detail}`,
                          `耗时: ${selectedLog.durationMs}ms`,
                          ...(selectedLog.response ? [`\n--- 响应 ---\n${selectedLog.response}`] : []),
                        ];
                        void navigator.clipboard.writeText(lines.join("\n")).then(() => {
                          setDetailCopied(true);
                          setTimeout(() => setDetailCopied(false), 1500);
                        });
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.click(); }}
                    >
                      {detailCopied ? <CheckOutlined /> : <CopyOutlined />}
                    </span>
                  </div>
                  <pre className="logDetailCommand">{selectedLog.detail}</pre>
                </div>
                {selectedLog.response && (
                  <div className="logDetailSection">
                    <span className="logDetailLabel">响应</span>
                    <pre className="logDetailResponse">{selectedLog.response}</pre>
                  </div>
                )}
                <div className="logDetailMeta">
                  <span>{formatLogTime(selectedLog.timestamp)}</span>
                  <span>{selectedLog.durationMs}ms</span>
                  <span className={selectedLog.success ? "logDetailMetaOk" : "logDetailMetaErr"}>
                    {selectedLog.success ? "成功" : "失败"}
                  </span>
                </div>
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
