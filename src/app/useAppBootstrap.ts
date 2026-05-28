import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appApi } from "../api/appApi";
import { isTauriRuntime } from "../api/runtime";
import { vaultApi } from "../api/vaultApi";
import { getErrorMessage } from "../lib/configMapping";
import type { AppInfo, ConfigSnapshot } from "../types";

type UseAppBootstrapOptions = {
  applySnapshot: (snapshot: ConfigSnapshot, preferredSessionId?: string, preserveRuntime?: boolean) => void;
  initializeApiServerRuntime: () => Promise<void>;
};

export function useAppBootstrap({ applySnapshot, initializeApiServerRuntime }: UseAppBootstrapOptions) {
  const [appReady, setAppReady] = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string>();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void initializeApp();
  }, []);

  async function initializeApp() {
    try {
      const needsMigration = await vaultApi.needsMigration();
      if (needsMigration) {
        setMigrationNeeded(true);
        return;
      }
      applySnapshot(await vaultApi.snapshot());
      setAppReady(true);
    } catch (error) {
      console.error("[helm] Failed to load config snapshot:", error);
    } finally {
      signalFrontendReady();
      void initializeAppMetadata();
    }
  }

  async function handleMigrate(oldPassword: string) {
    await runMigration(() => vaultApi.migrate(oldPassword));
  }

  async function handleSkipMigration() {
    await runMigration(() => vaultApi.skipMigration());
  }

  async function runMigration(action: () => Promise<ConfigSnapshot>) {
    setMigrationBusy(true);
    setMigrationError(undefined);
    try {
      const snapshot = await action();
      setMigrationNeeded(false);
      applySnapshot(snapshot);
      setAppReady(true);
      void initializeAppMetadata();
    } catch (error) {
      setMigrationError(getErrorMessage(error));
    } finally {
      setMigrationBusy(false);
    }
  }

  async function initializeAppMetadata() {
    try {
      setAppInfo(await appApi.info());
    } catch {
      // 版本信息失败不影响主流程。
    }
    await initializeApiServerRuntime();
  }

  function signalFrontendReady() {
    if (!isTauriRuntime()) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void invoke("frontend_ready").catch(() => undefined);
      });
    });
  }

  return {
    appReady,
    migrationNeeded,
    migrationBusy,
    migrationError,
    appInfo,
    setAppInfo,
    handleMigrate,
    handleSkipMigration,
  };
}
