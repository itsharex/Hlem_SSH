import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, BackupSettings, ConfigSnapshot, GroupInput, SessionInput, SshOptions, TunnelConfig, TunnelInput, VaultData } from "../types";
import { isTauriRuntime } from "./runtime";

const BROWSER_VAULT_KEY = "helm.browserVault";

export const vaultApi = {
  needsMigration: () => call<boolean>("vault_needs_migration", () => false),
  migrate: (oldPassword: string) =>
    call<ConfigSnapshot>("vault_migrate", () => { throw new Error("浏览器环境无需迁移"); }, { oldPassword }),
  skipMigration: () =>
    call<ConfigSnapshot>("vault_skip_migration", browserSkipMigration),
  snapshot: () => call<ConfigSnapshot>("config_snapshot", browserSnapshot),
  backupExport: (path: string) => call<void>("vault_backup_export", () => browserUnavailable("备份导出"), { path }),
  backupImport: (path: string) =>
    call<ConfigSnapshot>("vault_backup_import", () => browserUnavailable("备份恢复"), { path }),
  backupRunNow: () => call<ConfigSnapshot>("backup_run_now", browserBackupRunNow),
  backupRecordRestore: (recordId: string) =>
    call<ConfigSnapshot>("backup_record_restore", () => browserUnavailable("备份记录恢复"), { recordId }),
  backupRecordDelete: (recordId: string, deleteFile = false) =>
    call<ConfigSnapshot>("backup_record_delete", () => browserBackupRecordDelete(recordId), { recordId, deleteFile }),
  backupRecordsClear: () =>
    call<ConfigSnapshot>("backup_records_clear", browserBackupRecordsClear),
  settingsUpdate: (settings: AppSettings) =>
    call<ConfigSnapshot>("settings_update", () => browserSettingsUpdate(settings), { settings }),
  groupCreate: (input: GroupInput) => call<ConfigSnapshot>("group_create", () => browserGroupCreate(input), { input }),
  groupUpdate: (groupId: string, input: GroupInput) =>
    call<ConfigSnapshot>("group_update", () => browserGroupUpdate(groupId, input), { groupId, input }),
  groupDelete: (groupId: string) => call<ConfigSnapshot>("group_delete", () => browserGroupDelete(groupId), { groupId }),
  sessionCreate: (input: SessionInput) =>
    call<ConfigSnapshot>("session_create", () => browserSessionCreate(input), { input }),
  sessionUpdate: (sessionId: string, input: SessionInput) =>
    call<ConfigSnapshot>("session_update", () => browserSessionUpdate(sessionId, input), { sessionId, input }),
  sessionDelete: (sessionId: string) =>
    call<ConfigSnapshot>("session_delete", () => browserSessionDelete(sessionId), { sessionId }),
  sessionDuplicate: (sessionId: string) =>
    call<ConfigSnapshot>("session_duplicate", () => browserSessionDuplicate(sessionId), { sessionId }),
  tunnelCreate: (input: TunnelInput) => call<ConfigSnapshot>("tunnel_create", () => browserTunnelCreate(input), { input }),
  tunnelUpdate: (tunnelId: string, input: TunnelInput) =>
    call<ConfigSnapshot>("tunnel_update", () => browserTunnelUpdate(tunnelId, input), { tunnelId, input }),
  tunnelDelete: (tunnelId: string) =>
    call<ConfigSnapshot>("tunnel_delete", () => browserTunnelDelete(tunnelId), { tunnelId }),
  tunnelList: () => call<TunnelConfig[]>("tunnel_list", () => browserSnapshot().data.tunnels),
};

function call<T>(command: string, browserFallback: () => T | Promise<T>, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    return invoke<T>(command, args);
  }
  return Promise.resolve(browserFallback());
}

let browserUnlocked: ConfigSnapshot | null = null;

function browserSkipMigration(): ConfigSnapshot {
  // In browser mode, just reset to fresh state
  localStorage.removeItem(BROWSER_VAULT_KEY);
  browserUnlocked = null;
  return requireBrowserUnlocked();
}

function browserSnapshot(): ConfigSnapshot {
  return requireBrowserUnlocked();
}

function browserUnavailable(capability: string): never {
  throw new Error(`浏览器环境无法使用：${capability}`);
}

function browserSettingsUpdate(settings: AppSettings): ConfigSnapshot {
  return browserMutate((data) => {
    settings.backup ??= defaultBackupSettings();
    settings.quickCommands ??= [];
    data.settings = settings;
  });
}

function browserBackupRunNow(): ConfigSnapshot {
  return browserMutate((data) => {
    const bjt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const fileName = `HelM-backup-${bjt.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-BJT.zip`;
    const settings = data.settings.backup ?? defaultBackupSettings();
    const records = [];
    if (!settings.cloud.enabled && settings.localDirectory) {
      records.push({
        id: crypto.randomUUID(),
        fileName,
        targetKind: "local" as const,
        targetPath: `${settings.localDirectory.replace(/[\\/]+$/, "")}/${fileName}`,
        size: 1024,
        status: "success" as const,
        error: null,
        createdAt: now(),
      });
    }
    if (settings.cloud.enabled) {
      records.push({
        id: crypto.randomUUID(),
        fileName,
        targetKind: settings.cloud.kind,
        targetPath: settings.cloud.kind === "webdav" ? settings.cloud.webdav.endpoint : `s3://${settings.cloud.s3.bucket}/${settings.cloud.s3.prefix}`,
        size: 1024,
        status: "success" as const,
        error: null,
        createdAt: now(),
      });
    }
    if (records.length === 0) throw new Error("请先配置本地备份目录或启用云端备份");
    data.backupRecords = [...records, ...(data.backupRecords ?? [])].slice(0, settings.retentionCount || 10);
  });
}

function browserBackupRecordDelete(recordId: string): ConfigSnapshot {
  return browserMutate((data) => {
    data.backupRecords = (data.backupRecords ?? []).filter((record) => record.id !== recordId);
  });
}

function browserBackupRecordsClear(): ConfigSnapshot {
  return browserMutate((data) => {
    data.backupRecords = [];
  });
}

function browserGroupCreate(input: GroupInput): ConfigSnapshot {
  return browserMutate((data) => {
    data.groups.push({
      id: crypto.randomUUID(),
      name: input.name,
      parentId: input.parentId ?? null,
      sortOrder: data.groups.length,
      createdAt: now(),
      updatedAt: now(),
    });
  });
}

function browserGroupUpdate(groupId: string, input: GroupInput): ConfigSnapshot {
  return browserMutate((data) => {
    const group = data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("分组不存在");
    group.name = input.name;
    group.parentId = input.parentId ?? null;
    group.updatedAt = now();
  });
}

function browserGroupDelete(groupId: string): ConfigSnapshot {
  return browserMutate((data) => {
    data.groups = data.groups.filter((group) => group.id !== groupId);
    data.sessions = data.sessions.map((session) =>
      session.groupId === groupId ? { ...session, groupId: null, updatedAt: now() } : session,
    );
  });
}

function browserSessionCreate(input: SessionInput): ConfigSnapshot {
  return browserMutate((data) => {
    data.sessions.push({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    });
  });
}

function browserSessionUpdate(sessionId: string, input: SessionInput): ConfigSnapshot {
  return browserMutate((data) => {
    data.sessions = data.sessions.map((session) =>
      session.id === sessionId ? { ...session, ...input, updatedAt: now() } : session,
    );
  });
}

function browserSessionDelete(sessionId: string): ConfigSnapshot {
  return browserMutate((data) => {
    data.sessions = data.sessions.filter((session) => session.id !== sessionId);
  });
}

function browserSessionDuplicate(sessionId: string): ConfigSnapshot {
  return browserMutate((data) => {
    const session = data.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("会话不存在");
    data.sessions.push({
      ...session,
      id: crypto.randomUUID(),
      name: `${session.name} 副本`,
      createdAt: now(),
      updatedAt: now(),
    });
  });
}

function browserTunnelCreate(input: TunnelInput): ConfigSnapshot {
  return browserMutate((data) => {
    data.tunnels.push({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    });
  });
}

function browserTunnelUpdate(tunnelId: string, input: TunnelInput): ConfigSnapshot {
  return browserMutate((data) => {
    data.tunnels = data.tunnels.map((tunnel) =>
      tunnel.id === tunnelId ? { ...tunnel, ...input, updatedAt: now() } : tunnel,
    );
  });
}

function browserTunnelDelete(tunnelId: string): ConfigSnapshot {
  return browserMutate((data) => {
    data.tunnels = data.tunnels.filter((tunnel) => tunnel.id !== tunnelId);
  });
}

function browserMutate(update: (data: VaultData) => void): ConfigSnapshot {
  const snapshot = structuredClone(requireBrowserUnlocked());
  update(snapshot.data);
  snapshot.data.updatedAt = now();
  browserUnlocked = snapshot;
  writeBrowserRecord(snapshot);
  return snapshot;
}

function requireBrowserUnlocked(): ConfigSnapshot {
  if (!browserUnlocked) {
    // Auto-initialize browser vault
    const stored = readBrowserRecord();
    if (stored) {
      browserUnlocked = stored;
    } else {
      browserUnlocked = { data: createDefaultVaultData() };
      writeBrowserRecord(browserUnlocked);
    }
  }
  return browserUnlocked;
}

function readBrowserRecord(): ConfigSnapshot | null {
  const content = localStorage.getItem(BROWSER_VAULT_KEY);
  if (!content) return null;
  const record = JSON.parse(content) as ConfigSnapshot | { masterPassword: string; snapshot: ConfigSnapshot };
  // Handle legacy format with masterPassword wrapper
  const snapshot = "snapshot" in record ? record.snapshot : record;
  normalizeBrowserSnapshot(snapshot);
  return snapshot;
}

function writeBrowserRecord(snapshot: ConfigSnapshot) {
  normalizeBrowserSnapshot(snapshot);
  localStorage.setItem(BROWSER_VAULT_KEY, JSON.stringify(snapshot));
}

function normalizeBrowserSnapshot(snapshot: ConfigSnapshot) {
  snapshot.data.knownHosts ??= [];
  snapshot.data.settings ??= { proxy: null, backup: defaultBackupSettings() };
  snapshot.data.settings.backup ??= defaultBackupSettings();
  snapshot.data.settings.quickCommands ??= [];
  snapshot.data.settings.ignoredUpdateVersions ??= [];
  snapshot.data.tunnels ??= [];
  snapshot.data.backupRecords ??= [];
  snapshot.data.sessions = snapshot.data.sessions.map((session) => ({
    ...session,
    ssh: session.ssh ?? defaultSshOptions(),
  }));
}

function createDefaultVaultData(): VaultData {
  const timestamp = now();
  const groupId = crypto.randomUUID();
  return {
    version: 1,
    updatedAt: timestamp,
    knownHosts: [],
    settings: { proxy: null, backup: defaultBackupSettings(), quickCommands: [], ignoredUpdateVersions: [] },
    tunnels: [],
    backupRecords: [],
    groups: [
      {
        id: groupId,
        name: "默认分组",
        parentId: null,
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    sessions: [],
  };
}

export function emptyPasswordAuth() {
  return {
    method: "password" as const,
    password: null,
    privateKeyPath: null,
    importedPrivateKey: null,
    privateKeyPassphrase: null,
  };
}

export function defaultTerminalOptions() {
  return {
    encoding: "utf-8",
    theme: "default",
    keepaliveIntervalSec: 15,
  };
}

export function defaultSshOptions(): SshOptions {
  return {
    connectTimeoutMs: 10000,
    keepaliveIntervalSec: 15,
    hostKeyFingerprint: null,
    proxy: null,
  };
}

export function defaultSftpOptions() {
  return {
    defaultPath: "",
    showHidden: false,
  };
}

export function defaultBackupSettings(): BackupSettings {
  return {
    localDirectory: null,
    autoEnabled: false,
    frequency: "daily",
    retentionCount: 10,
    retentionDays: 30,
    cloud: {
      enabled: false,
      kind: "webdav",
      webdav: {
        endpoint: "",
        username: "",
        password: "",
        remotePath: "",
      },
      s3: {
        endpoint: "",
        region: "us-east-1",
        bucket: "",
        accessKeyId: "",
        secretAccessKey: "",
        prefix: "helm",
        pathStyle: true,
      },
    },
  };
}

function now(): string {
  return new Date().toISOString();
}
