import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";
import type { ApiLogEntry } from "./appApi";

type TrayAction = "lock" | "settings" | "backup" | "backupNow";
type Unlisten = () => void;

export const appEvents = {
  onTrayAction: async (handler: (action: TrayAction) => void): Promise<Unlisten> => {
    if (!isTauriRuntime()) return () => undefined;
    return listen<TrayAction>("tray://action", (event) => handler(event.payload));
  },
  /**
   * 后端 push_log 时实时推送的单条日志。订阅它代替原来 500ms 轮询 apiServerLogs()，
   * 既不抢 Tokio Mutex，也避免空轮询时仍消耗后端 CPU/锁。
   */
  onApiLog: async (handler: (entry: ApiLogEntry) => void): Promise<Unlisten> => {
    if (!isTauriRuntime()) return () => undefined;
    return listen<ApiLogEntry>("api://log", (event) => handler(event.payload));
  },
};
