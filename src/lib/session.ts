import type { TerminalEntry } from "../types";

export function createTerminalEntry(kind: TerminalEntry["kind"], content: string): TerminalEntry {
  return {
    id: crypto.randomUUID(),
    kind,
    content,
    timestamp: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  };
}
