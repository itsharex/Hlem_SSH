import type { RemoteFileEntry, UsageMetric } from "../types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

type ByteFormatOptions = {
  zeroText?: string;
  invalidText?: string;
};

export function formatBytes(bytes: number, options: ByteFormatOptions = {}): string {
  if (!Number.isFinite(bytes)) return options.invalidText ?? "0 B";
  if (bytes <= 0) return options.zeroText ?? "0 B";
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatUsage(metric: UsageMetric): string {
  return `${formatBytes(metric.used)} / ${formatBytes(metric.total)}`;
}

export function percent(metric: UsageMetric): number {
  if (metric.total === 0) return 0;
  return Math.round((metric.used / metric.total) * 100);
}

export function formatFileSize(entry: RemoteFileEntry): string {
  return entry.fileType === "directory" ? "-" : formatBytes(entry.size);
}

export function formatBeijingDateTime(value: string, fallback = value): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
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

export function formatBeijingDate(value: string, fallback = value): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatBeijingCompactTimestamp(date = new Date()): string {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijing.getUTCDate()).padStart(2, "0");
  const hour = String(beijing.getUTCHours()).padStart(2, "0");
  const minute = String(beijing.getUTCMinutes()).padStart(2, "0");
  const second = String(beijing.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}
