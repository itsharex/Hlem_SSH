import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ClockCircleOutlined,
  DesktopOutlined,
  HddOutlined,
  WifiOutlined,
} from "@ant-design/icons";
import { Progress, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { formatBytes, formatUsage, percent } from "../lib/format";
import { createEmptyTelemetry } from "../lib/remoteDefaults";
import type { DiskMetric, ProcessInfo, RemoteSession } from "../types";
import { useState } from "react";

interface TelemetrySidebarProps {
  session: RemoteSession;
}

const processColumns: ColumnsType<ProcessInfo> = [
  { title: "进程", dataIndex: "name", ellipsis: true, width: 82 },
  {
    title: "CPU",
    dataIndex: "cpu",
    width: 66,
    render: (value: number) => `${value.toFixed(1)}%`,
    sorter: (a, b) => a.cpu - b.cpu,
    defaultSortOrder: "descend",
  },
  {
    title: "内存",
    dataIndex: "memory",
    width: 52,
    render: (value: number) => `${value.toFixed(0)}M`,
  },
];

const diskColumns: ColumnsType<DiskMetric> = [
  { title: "挂载点", dataIndex: "mount", ellipsis: true, width: 74 },
  {
    title: "可用 / 总计",
    width: 116,
    render: (_, item) => `${formatBytes(item.total - item.used)} / ${formatBytes(item.total)}`,
  },
];

function formatNetworkRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 K/s";
  const units = ["K/s", "M/s", "G/s", "T/s", "P/s"];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
  return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
}

export function TelemetrySidebar({
  session,
}: TelemetrySidebarProps) {
  const [copied, setCopied] = useState(false);
  const isConnected = session.state === "connected";
  const state = session.state;
  const telemetry = isConnected ? session.telemetry : createEmptyTelemetry(session.host);
  const uptimeText = isConnected ? telemetry.uptime : "";
  const interfaceText = isConnected ? telemetry.network.interfaceName : "网络";
  const latencyText = isConnected ? `${telemetry.network.latencyMs} ms` : "";

  return (
    <aside className="telemetrySidebar">
      <section className="statusSummaryPanel">
        <div className="statusSummaryHeader">
          <span className="statusSummaryState">
            <span className={`stateDot stateDot-${state}`} />
            <strong>{isConnected ? "已连接" : "未连接"}</strong>
          </span>
          {isConnected && telemetry.ip && (
            <button
              type="button"
              className="statusSummaryIp"
              title={telemetry.ip}
              onClick={() => {
                void navigator.clipboard.writeText(telemetry.ip);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 900);
              }}
            >
              {copied ? "已复制" : telemetry.ip}
            </button>
          )}
        </div>
        <div className="statusSummaryGrid">
          <span className="statusSummaryTile">
            <span className="statusSummaryTileLabel" title="运行时间">
              <ClockCircleOutlined />
              <span>运行时间</span>
            </span>
            <strong title={uptimeText || undefined}>{uptimeText}</strong>
          </span>
          <span className="statusSummaryTile">
            <span className="statusSummaryTileLabel" title={interfaceText}>
              <WifiOutlined />
              <span>{interfaceText}</span>
            </span>
            <strong title={latencyText || undefined}>{latencyText}</strong>
          </span>
        </div>
        <div className="networkStats">
          <span>
            <ArrowUpOutlined /> {formatNetworkRate(isConnected ? telemetry.network.uploadKbps : 0)}
          </span>
          <span>
            <ArrowDownOutlined /> {formatNetworkRate(isConnected ? telemetry.network.downloadKbps : 0)}
          </span>
        </div>
      </section>

      {isConnected && (
        <section className="resourcePanel">
          <div className="sectionTitle">
            <DesktopOutlined />
            <span>资源</span>
          </div>
          <MetricBar label="CPU" value={telemetry.cpu} statusColor="var(--accent)" />
          <MetricBar
            label="内存"
            value={percent(telemetry.memory)}
            text={formatUsage(telemetry.memory)}
            statusColor="var(--orange)"
          />
          <MetricBar
            label="交换"
            value={percent(telemetry.swap)}
            text={formatUsage(telemetry.swap)}
            statusColor="var(--success)"
          />
        </section>
      )}

      {isConnected && (
        <section className="sidebarSection">
          <div className="sectionTitle">
            <DesktopOutlined />
            <span>进程</span>
          </div>
          <Table
            rowKey="pid"
            size="small"
            pagination={false}
            columns={processColumns}
            dataSource={telemetry.processes}
            scroll={{ y: 130 }}
            locale={{ emptyText: "暂无进程数据" }}
          />
        </section>
      )}

      {isConnected && (
        <section className="sidebarSection">
          <div className="sectionTitle">
            <HddOutlined />
            <span>磁盘</span>
          </div>
          <Table
            rowKey="mount"
            size="small"
            pagination={false}
            columns={diskColumns}
            dataSource={telemetry.disks}
            locale={{ emptyText: "暂无磁盘数据" }}
          />
        </section>
      )}
    </aside>
  );
}

function MetricBar({
  label,
  value,
  text,
  statusColor,
}: {
  label: string;
  value: number;
  text?: string;
  statusColor: string;
}) {
  return (
    <div className="metricBar">
      <div className="metricBarLabel">
        <span>{label}</span>
        <span>{text ?? `${value}%`}</span>
      </div>
      <Progress percent={value} showInfo={false} strokeColor={statusColor} trailColor="#e4e9ef" size="small" />
    </div>
  );
}
