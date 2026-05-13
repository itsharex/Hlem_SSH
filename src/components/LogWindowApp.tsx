import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Empty, Tooltip, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState } from "react";
import { appApi, type ApiLogEntry } from "../api/appApi";

export function LogWindowApp() {
  const [logs, setLogs] = useState<ApiLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

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
      return `[${log.timestamp}] [${status}] ${log.action} | ${log.detail} | ${log.durationMs}ms`;
    });
    const text = lines.join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copySingleLog(log: ApiLogEntry, index: number) {
    const status = log.success ? "OK" : "ERR";
    const text = `[${log.timestamp}] [${status}] ${log.action} | ${log.detail} | ${log.durationMs}ms`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    });
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
        <div className="logWindowBody">
          {reversed.length === 0 ? (
            <div className="logWindowEmpty">
              <Empty description="暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <div className="logWindowList">
              {reversed.map((log, i) => (
                <div key={i} className={`aiApiLogItem aiApiLogItem-${log.success ? "ok" : "err"}`}>
                  <span className="aiApiLogTime">{log.timestamp.slice(11)}</span>
                  <span className={`aiApiLogAction aiApiLogAction-${log.action}`}>{log.action}</span>
                  <span className="aiApiLogDetail" title={log.detail}>{log.detail}</span>
                  <span className="aiApiLogDuration">{log.durationMs}ms</span>
                  <span
                    className={`aiApiLogCopy${copiedIndex === i ? " aiApiLogCopy-done" : ""}`}
                    role="button"
                    tabIndex={0}
                    title="复制此条"
                    onClick={() => copySingleLog(log, i)}
                    onKeyDown={(e) => { if (e.key === "Enter") copySingleLog(log, i); }}
                  >
                    {copiedIndex === i ? <CheckOutlined /> : <CopyOutlined />}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ConfigProvider>
  );
}
