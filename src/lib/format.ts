import type { RemoteFileEntry, UsageMetric } from "../types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
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
