import { useEffect, useRef } from "react";
import { appEvents } from "../api/appEvents";

type UseTrayActionsOptions = {
  appReady: boolean;
  onOpenSettings: () => void;
  onOpenBackup: () => void;
  onRunBackup: () => void;
};

export function useTrayActions(options: UseTrayActionsOptions) {
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!options.appReady) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void appEvents.onTrayAction((action) => {
      const handlers = optionsRef.current;
      if (action === "settings") handlers.onOpenSettings();
      if (action === "backup") handlers.onOpenBackup();
      if (action === "backupNow") handlers.onRunBackup();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [options.appReady]);
}
