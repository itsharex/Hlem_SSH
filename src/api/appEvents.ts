import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";

type TrayAction = "lock" | "settings" | "backup" | "backupNow";
type Unlisten = () => void;

export const appEvents = {
  onTrayAction: async (handler: (action: TrayAction) => void): Promise<Unlisten> => {
    if (!isTauriRuntime()) return () => undefined;
    return listen<TrayAction>("tray://action", (event) => handler(event.payload));
  },
};
