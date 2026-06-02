import { useEffect, useRef } from "react";
import { defaultBackupSettings, vaultApi } from "../api/vaultApi";
import { useMountedRef } from "../lib/reactLifecycle";
import type { MutableRefObject } from "react";
import type { AppSettings, ConfigSnapshot } from "../types";

type UseSettingsPersistenceOptions = {
  configSnapshot: ConfigSnapshot | undefined;
  configSnapshotRef: MutableRefObject<ConfigSnapshot | undefined>;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
  onSettingsSaved: () => void;
};

export function useSettingsPersistence({
  configSnapshot,
  configSnapshotRef,
  applyConfigSnapshot,
  onSettingsSaved,
}: UseSettingsPersistenceOptions) {
  const inputHistorySaveTimerRef = useRef<number | null>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    return () => {
      if (inputHistorySaveTimerRef.current !== null) {
        window.clearTimeout(inputHistorySaveTimerRef.current);
      }
    };
  }, []);

  async function saveSettings(settings: AppSettings) {
    const snapshot = await vaultApi.settingsUpdate(settings);
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
    onSettingsSaved();
  }

  async function saveQuickCommands(nextCommands: AppSettings["quickCommands"]) {
    if (!configSnapshot) return;
    const snapshot = await vaultApi.settingsUpdate({
      ...configSnapshot.data.settings,
      backup: configSnapshot.data.settings.backup ?? defaultBackupSettings(),
      quickCommands: nextCommands ?? [],
    });
    if (!mountedRef.current) return;
    applyConfigSnapshot(snapshot);
  }

  function saveTerminalInputHistory(history: AppSettings["terminalInputHistory"]) {
    if (inputHistorySaveTimerRef.current !== null) {
      window.clearTimeout(inputHistorySaveTimerRef.current);
    }
    inputHistorySaveTimerRef.current = window.setTimeout(() => {
      inputHistorySaveTimerRef.current = null;
      const snapshot = configSnapshotRef.current;
      if (!snapshot) return;
      void vaultApi.settingsUpdate({
        ...snapshot.data.settings,
        backup: snapshot.data.settings.backup ?? defaultBackupSettings(),
        terminalInputHistory: history ?? [],
      }).then((snapshot) => {
        if (mountedRef.current) applyConfigSnapshot(snapshot);
      }).catch(() => undefined);
    }, 800);
  }

  return {
    saveSettings,
    saveQuickCommands,
    saveTerminalInputHistory,
  };
}
