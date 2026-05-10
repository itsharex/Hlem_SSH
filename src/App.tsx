import { Modal } from "antd";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { appApi } from "./api/appApi";
import { appEvents } from "./api/appEvents";
import { remoteApi } from "./api/remoteApi";
import { defaultBackupSettings, vaultApi } from "./api/vaultApi";
import {
  BackupModal,
  FileManager,
  SettingsModal,
  SessionConfigModal,
  SplitPane,
  TelemetrySidebar,
  TerminalPanel,
  TopBar,
  TransferCenter,
  TunnelDrawer,
} from "./app/lazyComponents";
import type { SessionModalState, VaultMode } from "./app/appTypes";
import {
  appendTerminalStreamEntries,
  createNextSessionName,
  extractPromptCwd,
  getHostKeyPayload,
  hasTelemetryData,
  remoteSessionPath,
  resolveSftpOperationTarget,
  runUploadQueue,
  sessionConfigToInput,
  sftpUnavailableMessage,
  shouldRunAutoBackup,
  shouldSkipTerminalEntry,
  stripCwdMarkers,
  uploadConcurrency,
} from "./app/appHelpers";
import type { FileOperation } from "./components/FileManager";
import { AppLoadingFallback } from "./components/shared/AppLoadingFallback";
import { AppProviders } from "./components/shared/AppProviders";
import { VaultGate } from "./components/VaultGate";
import { configToRemoteSession, createDefaultSessionInput, defaultRemoteHomePath, getErrorCode, getErrorMessage, initialRemotePath } from "./lib/configMapping";
import {
  getBaseName as getRemoteBaseName,
  getParentPath as getRemoteParentPath,
  joinPath as joinRemotePath,
  normalizePath as normalizeRemotePath,
} from "./lib/path";
import { createEmptyTelemetry } from "./lib/remoteDefaults";
import { createTerminalEntry } from "./lib/session";
import type {
  ConfigSnapshot,
  AppSettings,
  AppInfo,
  FileSaveRecord,
  ForwardInfo,
  ForwardStatusEvent,
  RemoteSession,
  SessionInput,
  SftpChangedEvent,
  TerminalEntry,
  TerminalClosedEvent,
  TerminalOutputEvent,
  TunnelConfig,
  TunnelInput,
  TransferInfo,
  UpdateInfo,
} from "./types";

type TransferHistorySnapshot = {
  version: 1;
  savedAt: string;
  transfers: TransferInfo[];
  transferSessionIds: Record<string, string>;
};

const TRANSFER_HISTORY_STORAGE_KEY = "helm:transferHistory:v1";
const TRANSFER_HISTORY_LIMIT = 100;

function App() {
  const [vaultMode, setVaultMode] = useState<VaultMode>("loading");
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string>();
  const [configSnapshot, setConfigSnapshot] = useState<ConfigSnapshot>();
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [connectingSessionId, setConnectingSessionId] = useState<string | null>(null);
  const [sessionModal, setSessionModal] = useState<SessionModalState | null>(null);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const [returnToSessionListOnCancel, setReturnToSessionListOnCancel] = useState(false);
  const initialTransferHistory = useMemo(loadTransferHistory, []);
  const [transfers, setTransfers] = useState<TransferInfo[]>(initialTransferHistory.transfers);
  const [transferSessionIds, setTransferSessionIds] = useState<Record<string, string>>(initialTransferHistory.transferSessionIds);
  const [fileSaveRecords, setFileSaveRecords] = useState<FileSaveRecord[]>([]);
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tunnelOpen, setTunnelOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);
  const [fileLoadingSessionIds, setFileLoadingSessionIds] = useState<Set<string>>(new Set());
  const sessionsRef = useRef<RemoteSession[]>([]);
  const transfersRef = useRef<TransferInfo[]>([]);
  const transferSessionIdsRef = useRef<Record<string, string>>({});
  const transferHistoryPersistTimerRef = useRef<number | null>(null);
  const terminalSessionMapRef = useRef<Map<string, string>>(new Map());
  const pendingTerminalEntriesRef = useRef<Map<string, TerminalEntry[]>>(new Map());
  const terminalOutputBuffersRef = useRef<Map<string, TerminalEntry[]>>(new Map());
  const terminalOutputFlushRef = useRef<number | null>(null);
  const vaultModeRef = useRef(vaultMode);
  const configSnapshotRef = useRef<ConfigSnapshot | undefined>(configSnapshot);
  const autoBackupRunningRef = useRef(false);
  const inputHistorySaveTimerRef = useRef<number | null>(null);
  const autoUpdateTimerRef = useRef<number | null>(null);
  const pendingConnectionIdsRef = useRef<Map<string, string>>(new Map());
  const abortedConnectSessionsRef = useRef<Set<string>>(new Set());
  const openSessions = useMemo(
    () => openSessionIds.map((id) => sessions.find((session) => session.id === id)).filter(Boolean) as RemoteSession[],
    [openSessionIds, sessions],
  );
  const activeSession = useMemo(
    () => openSessions.find((session) => session.id === activeSessionId) ?? openSessions[0],
    [activeSessionId, openSessions],
  );

  useEffect(() => {
    initializeVault();
    void initializeAppInfo();
    return () => {
      if (autoUpdateTimerRef.current !== null) {
        window.clearTimeout(autoUpdateTimerRef.current);
      }
      if (transferHistoryPersistTimerRef.current !== null) {
        window.clearTimeout(transferHistoryPersistTimerRef.current);
      }
      if (inputHistorySaveTimerRef.current !== null) {
        window.clearTimeout(inputHistorySaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  useEffect(() => {
    transferSessionIdsRef.current = transferSessionIds;
  }, [transferSessionIds]);

  useEffect(() => {
    vaultModeRef.current = vaultMode;
  }, [vaultMode]);

  useEffect(() => {
    configSnapshotRef.current = configSnapshot;
  }, [configSnapshot]);

  useEffect(() => {
    let disposed = false;
    let cleanups: Array<() => void> = [];
    void Promise.all([
      remoteApi.onSshStatus(handleSshStatus),
      remoteApi.onSftpChanged(handleSftpChanged),
      remoteApi.onTerminalOutput(handleTerminalOutput),
      remoteApi.onTerminalClosed(handleTerminalClosed),
      remoteApi.onTelemetrySnapshot((payload) => {
        if (!payload.snapshot) return;
        setSessions((current) =>
          current.map((session) =>
            session.id === payload.sessionId
              ? { ...session, telemetry: payload.snapshot }
              : session,
          ),
        );
      }),
      remoteApi.onTransferProgress(upsertTransfer),
      remoteApi.onTransferCompleted((payload) => {
        upsertTransfer(payload);
        void refreshFilesForTransfer(payload);
      }),
      remoteApi.onTransferFailed(upsertTransfer),
      remoteApi.onForwardStatus(upsertForward),
      remoteApi.onHostKeyVerify((payload) => {
        appendTerminal(payload.sessionId, "system", `主机密钥待确认：${payload.fingerprint}`);
      }),
    ]).then((items) => {
      if (disposed) {
        items.forEach((cleanup) => cleanup());
        return;
      }
      cleanups = items;
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void appEvents.onTrayAction((action) => {
      if (action === "lock") {
        if (vaultModeRef.current === "ready") void lockVault();
        return;
      }
      if (vaultModeRef.current !== "ready") return;
      if (action === "settings") setSettingsOpen(true);
      if (action === "backup") setBackupOpen(true);
      if (action === "backupNow") void runConfiguredBackup();
    }).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (vaultMode !== "ready") return;
    void remoteApi.listForwards().then(setForwards).catch(() => undefined);
  }, [vaultMode]);

  useEffect(() => {
    if (vaultMode !== "ready") return;
    if (sessionModal || activeSession) return;
    if (openSessionIds.length > 0) return;
    setSessionListOpen(true);
  }, [vaultMode, sessionModal, activeSession, openSessionIds.length]);

  useEffect(() => {
    const snapshot = configSnapshot;
    if (vaultMode !== "ready" || !snapshot) return;
    const backup = snapshot.data.settings?.backup ?? defaultBackupSettings();
    if (!backup.autoEnabled || backup.frequency === "manual") return;
    const check = () => {
      const current = configSnapshotRef.current;
      if (!current || autoBackupRunningRef.current) return;
      if (shouldRunAutoBackup(backup, current.data.backupRecords ?? [])) {
        void runConfiguredBackup(false);
      }
    };
    const startupTimer = window.setTimeout(check, 3000);
    const interval = window.setInterval(check, 60_000);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
    };
  }, [configSnapshot?.data.settings?.backup, configSnapshot?.data.backupRecords, vaultMode]);

  async function initializeVault() {
    try {
      const status = await vaultApi.status();
      if (!status.exists) {
        setVaultMode("create");
        return;
      }
      if (!status.unlocked) {
        setVaultMode("unlock");
        return;
      }
      applySnapshot(await vaultApi.snapshot());
    } catch (error) {
      setVaultError(getErrorMessage(error));
      setVaultMode("unlock");
    }
  }

  async function initializeAppInfo() {
    try {
      const info = await appApi.info();
      setAppInfo(info);
      scheduleAutoUpdateCheck(info);
    } catch {
      // 版本信息失败不影响主流程。
    }
  }

  function scheduleAutoUpdateCheck(info: AppInfo) {
    if (autoUpdateTimerRef.current !== null) return;
    autoUpdateTimerRef.current = window.setTimeout(() => {
      autoUpdateTimerRef.current = null;
      runWhenBrowserIdle(() => void checkForUpdate(false, info));
    }, 8000);
  }

  function runWhenBrowserIdle(task: () => void) {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(task, { timeout: 15_000 });
      return;
    }
    window.setTimeout(task, 0);
  }

  async function checkForUpdate(manual = true, knownInfo = appInfo) {
    const info = knownInfo ?? (await appApi.info());
    setAppInfo(info);
    if (!appApi.updateRepo()) {
      if (manual) Modal.warning({ title: "未配置更新源", content: "发布版会由 GitHub Actions 自动写入更新仓库地址。" });
      return;
    }
    if (manual) setUpdateChecking(true);
    if (manual) setUpdateError(null);
    try {
      const next = await appApi.checkUpdate(info.version, info.arch);
      setUpdateInfo(next);
      if (!next) return;
      if (next.hasUpdate) {
        if (!manual) return;
        Modal.confirm({
          title: `发现新版本 ${next.tagName}`,
          content: next.asset ? `当前版本 ${info.version}，是否下载 ${next.asset.name}？` : "当前 Release 没有找到 Windows 安装包。",
          okText: "下载更新",
          cancelText: "稍后",
          okButtonProps: { disabled: !next.asset },
          onOk: () => downloadUpdate(next),
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (manual) setUpdateError(message);
      if (!manual) console.warn("[helm] auto update check failed:", message);
      if (manual) Modal.error({ title: "检查更新失败", content: message });
    } finally {
      if (manual) setUpdateChecking(false);
    }
  }

  async function downloadUpdate(target = updateInfo) {
    if (!target?.asset) return;
    setUpdateDownloading(true);
    try {
      const path = await appApi.downloadSignedUpdate(target.asset.downloadUrl, target.asset.name, target.asset.sha256);
      setDownloadedUpdatePath(path);
      Modal.success({ title: "更新包已下载", content: path });
    } catch (error) {
      Modal.error({ title: "下载更新失败", content: getErrorMessage(error) });
    } finally {
      setUpdateDownloading(false);
    }
  }

  async function openDatabaseDir() {
    try {
      await appApi.openDatabaseDir();
    } catch (error) {
      Modal.error({ title: "打开数据库目录失败", content: getErrorMessage(error) });
    }
  }

  async function openExternalUrl(url: string) {
    try {
      await appApi.openExternalUrl(url);
    } catch (error) {
      Modal.error({ title: "打开链接失败", content: getErrorMessage(error) });
    }
  }

  async function createVault(masterPassword: string) {
    await runVaultAction(async () => {
      applySnapshot(await vaultApi.create(masterPassword));
    });
  }

  async function unlockVault(masterPassword: string) {
    await runVaultAction(async () => {
      applySnapshot(await vaultApi.unlock(masterPassword));
    });
  }

  async function lockVault() {
    await runVaultAction(async () => {
      await vaultApi.lock();
      resetWorkspaceState();
      setVaultMode("unlock");
    });
  }

  function resetWorkspaceState() {
    setConfigSnapshot(undefined);
    setSessions([]);
    setOpenSessionIds([]);
    setActiveSessionId("");
    setConnectingSessionId(null);
    setSessionModal(null);
    setSessionListOpen(false);
    setTransferCenterOpen(false);
    setTransfers([]);
    setFileSaveRecords([]);
    setForwards([]);
    setBackupOpen(false);
    setSettingsOpen(false);
    setTunnelOpen(false);
    setFileLoadingSessionIds(new Set());
    terminalSessionMapRef.current.clear();
    pendingTerminalEntriesRef.current.clear();
    clearTerminalOutputBuffers();
    if (inputHistorySaveTimerRef.current !== null) {
      window.clearTimeout(inputHistorySaveTimerRef.current);
      inputHistorySaveTimerRef.current = null;
    }
  }

  async function runVaultAction(action: () => Promise<void>) {
    setVaultBusy(true);
    setVaultError(undefined);
    try {
      await action();
    } catch (error) {
      setVaultError(getErrorMessage(error));
    } finally {
      setVaultBusy(false);
    }
  }

  function applySnapshot(snapshot: ConfigSnapshot, preferredSessionId?: string) {
    const mappedSessions = snapshot.data.sessions.map(configToRemoteSession);
    const mappedIds = mappedSessions.map((session) => session.id);
    const preferredId = preferredSessionId && mappedIds.includes(preferredSessionId) ? preferredSessionId : "";
    setConfigSnapshot(snapshot);
    setSessions(mappedSessions);
    setOpenSessionIds((current) => {
      const validIds = current.filter((id) => mappedIds.includes(id));
      if (preferredId && !validIds.includes(preferredId)) validIds.push(preferredId);
      return validIds;
    });
    setActiveSessionId((current) => (preferredId || (mappedIds.includes(current) ? current : "")));
    setVaultMode("ready");
  }

  function activateSession(id: string) {
    setOpenSessionIds((current) => (current.includes(id) ? current : [...current, id]));
    setActiveSessionId(id);
  }

  async function addSession(returnToListOnCancel = false) {
    if (!configSnapshot) return;
    setReturnToSessionListOnCancel(returnToListOnCancel);
    setSessionModal({
      mode: "create",
      input: createDefaultSessionInput(configSnapshot.data.sessions.length + 1, configSnapshot.data.groups[0]?.id),
    });
  }

  function editSession(id = activeSessionId, returnToListOnCancel = false) {
    const config = configSnapshot?.data.sessions.find((session) => session.id === id);
    if (!config) return;
    setReturnToSessionListOnCancel(returnToListOnCancel);
    setSessionModal({ mode: "edit", sessionId: id, input: sessionConfigToInput(config) });
  }

  async function saveSessionConfig(input: SessionInput) {
    if (!configSnapshot || !sessionModal) return;
    const namedInput = {
      ...input,
      name: input.name.trim() || createNextSessionName(configSnapshot.data.sessions, sessionModal.mode === "edit" ? sessionModal.sessionId : undefined),
    };
    if (sessionModal.mode === "create") {
      const snapshot = await vaultApi.sessionCreate(namedInput);
      const createdId = snapshot.data.sessions[snapshot.data.sessions.length - 1]?.id;
      applySnapshot(snapshot, createdId);
    } else {
      const snapshot = await vaultApi.sessionUpdate(sessionModal.sessionId, namedInput);
      applySnapshot(snapshot, sessionModal.sessionId);
    }
    setSessionModal(null);
    setReturnToSessionListOnCancel(false);
  }

  function closeSessionConfigModal() {
    setSessionModal(null);
    setReturnToSessionListOnCancel(false);
  }

  function backToSessionListFromConfig() {
    setSessionModal(null);
    setReturnToSessionListOnCancel(false);
    setSessionListOpen(true);
  }

  async function closeSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (connectingSessionId === id) {
      abortedConnectSessionsRef.current.add(id);
      const pendingConnectionId = pendingConnectionIdsRef.current.get(id);
      if (pendingConnectionId) {
        pendingConnectionIdsRef.current.delete(id);
        await remoteApi.disconnect(pendingConnectionId).catch(() => undefined);
      }
      setConnectingSessionId((current) => (current === id ? null : current));
      if (session) {
        updateSession(id, (item) => ({
          ...item,
          state: "disconnected",
          connectionId: null,
          terminalId: null,
          sftpId: null,
          telemetryJobId: null,
        }));
      }
    } else if (session?.connectionId) {
      await teardownSession(session);
    }
    setOpenSessionIds((current) => {
      const nextIds = current.filter((item) => item !== id);
      if (activeSessionId === id) setActiveSessionId(nextIds[0] ?? "");
      return nextIds;
    });
  }

  async function disconnectSession(session = activeSession) {
    if (!session?.connectionId) return;
    await teardownSession(session);
  }

  async function teardownSession(session: RemoteSession) {
    if (!session.connectionId) return;
    try {
      await remoteApi.disconnect(session.connectionId);
      updateSession(session.id, (item) => ({
        ...item,
        state: "disconnected",
        connectionId: null,
        terminalId: null,
        sftpId: null,
        telemetryJobId: null,
        telemetry: createEmptyTelemetry(item.host),
        files: [],
        terminal: [...item.terminal, createTerminalEntry("system", "连接已断开")],
      }));
    } catch (error) {
      appendTerminal(session.id, "error", formatSessionError(error, session));
    }
  }

  function updateSession(sessionId: string, updater: (session: RemoteSession) => RemoteSession) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  }

  function updateActiveSession(updater: (session: RemoteSession) => RemoteSession) {
    if (!activeSession) return;
    updateSession(activeSession.id, updater);
  }

  function formatSessionError(error: unknown, session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">): string {
    let message = getErrorMessage(error);
    for (const id of [session.connectionId, session.terminalId, session.sftpId]) {
      if (id) message = message.split(id).join(session.name);
    }
    return message;
  }

  function appendTerminal(sessionId: string, kind: TerminalOutputEvent["kind"] | "input", content: string) {
    const entry = createTerminalEntry(kind, content);
    if (!entry.content) return;
    updateSession(sessionId, (session) => ({
      ...session,
      terminal: shouldSkipTerminalEntry(session.terminal, entry) ? session.terminal : [...session.terminal, entry],
    }));
  }

  function setSessionFilesLoading(sessionId: string, loading: boolean) {
    setFileLoadingSessionIds((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  function setPersistedTransfers(updater: TransferInfo[] | ((current: TransferInfo[]) => TransferInfo[])) {
    const rawNext = typeof updater === "function" ? updater(transfersRef.current) : updater;
    const next = limitTransferHistory(rawNext);
    transfersRef.current = next;
    setTransfers(next);
    scheduleTransferHistoryPersist(next, transferSessionIdsRef.current);
  }

  function setPersistedTransferSessionIds(
    updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>),
  ) {
    const next = typeof updater === "function" ? updater(transferSessionIdsRef.current) : updater;
    transferSessionIdsRef.current = next;
    setTransferSessionIds(next);
    scheduleTransferHistoryPersist(transfersRef.current, next);
  }

  function scheduleTransferHistoryPersist(nextTransfers: TransferInfo[], nextSessionIds: Record<string, string>) {
    if (transferHistoryPersistTimerRef.current !== null) {
      window.clearTimeout(transferHistoryPersistTimerRef.current);
    }
    const transfersToSave = limitTransferHistory(nextTransfers);
    const sessionIdsToSave = sanitizeTransferSessionIds(
      nextSessionIds,
      new Set(transfersToSave.map((transfer) => transfer.sftpId)),
    );
    transferHistoryPersistTimerRef.current = window.setTimeout(() => {
      transferHistoryPersistTimerRef.current = null;
      if (transfersToSave.length === 0) {
        removeTransferHistory();
        return;
      }
      persistTransferHistory(transfersToSave, sessionIdsToSave);
    }, 0);
  }

  function clearFinishedTransferHistory() {
    const keptTransfers = limitTransferHistory(transfersRef.current.filter(shouldKeepTransferOnClear));
    const keptSessionIds = sanitizeTransferSessionIds(
      transferSessionIdsRef.current,
      new Set(keptTransfers.map((transfer) => transfer.sftpId)),
    );
    transfersRef.current = keptTransfers;
    transferSessionIdsRef.current = keptSessionIds;
    setTransfers(keptTransfers);
    setTransferSessionIds(keptSessionIds);
    scheduleTransferHistoryPersist(keptTransfers, keptSessionIds);
  }

  function upsertTransfer(payload: TransferInfo) {
    const ownerSessionId = sessionsRef.current.find((session) => session.sftpId === payload.sftpId)?.id;
    if (ownerSessionId) rememberTransferTarget(payload.sftpId, ownerSessionId);
    setPersistedTransfers((current) => {
      const existing = current.findIndex((transfer) => transfer.transferId === payload.transferId);
      if (existing === -1) return [payload, ...current];
      const next = [...current];
      next[existing] = payload;
      return next;
    });
  }

  function rememberTransferTarget(sftpId: string, sessionId: string) {
    setPersistedTransferSessionIds((current) => {
      if (current[sftpId] === sessionId) return current;
      return { ...current, [sftpId]: sessionId };
    });
  }

  function sessionForTransfer(transfer: TransferInfo) {
    return (
      sessionsRef.current.find((session) => session.sftpId === transfer.sftpId) ??
      sessionsRef.current.find((session) => session.id === transferSessionIdsRef.current[transfer.sftpId]) ??
      null
    );
  }

  function upsertForward(payload: ForwardStatusEvent) {
    setForwards((current) => {
      if (payload.status === "canceled" || payload.status === "completed") {
        return current.filter((forward) => forward.forwardId !== payload.forwardId);
      }
      const existing = current.findIndex((forward) => forward.forwardId === payload.forwardId);
      if (existing === -1) return [payload, ...current];
      const next = [...current];
      next[existing] = payload;
      return next;
    });
  }

  async function pauseTransfer(transferId: string) {
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "paused", speedKbps: 0 } : transfer,
      ),
    );
    try {
      upsertTransfer(await remoteApi.pauseTransfer(transferId));
    } catch (error) {
      appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function resumeTransfer(transferId: string) {
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "running" } : transfer,
      ),
    );
    try {
      upsertTransfer(await remoteApi.resumeTransfer(transferId));
    } catch (error) {
      appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function cancelTransfer(transferId: string) {
    try {
      await remoteApi.cancelTransfer(transferId);
    } catch (error) {
      appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function retryTransfer(transferId: string) {
    const transfer = transfersRef.current.find((item) => item.transferId === transferId);
    if (!transfer) return;
    const targetSession = sessionForTransfer(transfer);
    if (!targetSession?.sftpId || targetSession.state !== "connected") {
      appendTerminal(targetSession?.id ?? activeSessionId, "error", "目标终端未连接，无法重试传输");
      return;
    }
    try {
      const next =
        targetSession.sftpId === transfer.sftpId
          ? await retryExistingTransfer(transfer)
          : await restartTransferOnSession(transfer, targetSession.sftpId);
      rememberTransferTarget(next.sftpId, targetSession.id);
      setPersistedTransfers((current) => [next, ...current.filter((transfer) => transfer.transferId !== transferId)]);
    } catch (error) {
      appendTerminal(targetSession.id, "error", getErrorMessage(error));
    }
  }

  async function retryExistingTransfer(transfer: TransferInfo) {
    try {
      return await remoteApi.retryTransfer(transfer.transferId);
    } catch (error) {
      if (!isMissingTransferError(error)) throw error;
      const targetSession = sessionForTransfer(transfer);
      if (!targetSession?.sftpId) throw error;
      return restartTransferOnSession(transfer, targetSession.sftpId);
    }
  }

  function restartTransferOnSession(transfer: TransferInfo, sftpId: string) {
    return transfer.direction === "upload"
      ? remoteApi.upload(sftpId, transfer.localPath, transfer.remotePath, true, true, true)
      : remoteApi.download(sftpId, transfer.remotePath, transfer.localPath, true);
  }

  function isMissingTransferError(error: unknown) {
    return getErrorCode(error) === "notFound" && /传输任务/.test(getErrorMessage(error));
  }

  async function removeTransfer(transferId: string) {
    try {
      await remoteApi.removeTransfer(transferId);
    } catch {
      // 本地删除不应被后端清理失败阻断。
    } finally {
      setPersistedTransfers((current) => current.filter((transfer) => transfer.transferId !== transferId));
    }
  }

  async function refreshFilesForTransfer(payload: TransferInfo) {
    const directory = getRemoteParentPath(payload.remotePath);
    try {
      const files = await remoteApi.listFiles(payload.sftpId, directory);
      setSessions((current) =>
        current.map((session) =>
          session.sftpId === payload.sftpId && normalizeRemotePath(remoteSessionPath(session)) === directory
            ? { ...session, files }
            : session,
        ),
      );
    } catch {
      // 传输完成后的刷新失败不影响传输结果展示。
    }
  }

  function handleSshStatus(payload: Awaited<ReturnType<typeof remoteApi.connect>>) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== payload.sessionId) return session;
        if (payload.status === "disconnected") {
          return {
            ...session,
            state: "disconnected",
            connectionId: null,
            terminalId: null,
            sftpId: null,
            telemetryJobId: null,
            files: [],
            telemetry: createEmptyTelemetry(session.host),
          };
        }
        return {
          ...session,
          state: payload.status,
          connectionId: payload.connectionId,
        };
      }),
    );
  }

  function handleSftpChanged(payload: SftpChangedEvent) {
    const affected = sessionsRef.current.filter((session) => session.sftpId === payload.sftpId);
    for (const session of affected) {
      void refreshFiles(payload.sftpId, remoteSessionPath(session), session.id);
    }
  }

  function handleTerminalOutput(payload: TerminalOutputEvent) {
    const { data, cwd } = stripCwdMarkers(payload.data);
    const promptCwd = extractTerminalPromptCwd(payload.terminalId, data);
    if (cwd || promptCwd) updateTerminalCwd(payload.terminalId, cwd ?? promptCwd ?? "");
  }

  function extractTerminalPromptCwd(terminalId: string, data: string) {
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session) return null;
    return extractPromptCwd(data, session.username);
  }

  function enqueueTerminalOutput(terminalId: string, entry: TerminalEntry) {
    const buffer = terminalOutputBuffersRef.current.get(terminalId);
    if (buffer) {
      buffer.push(entry);
    } else {
      terminalOutputBuffersRef.current.set(terminalId, [entry]);
    }
    if (terminalOutputFlushRef.current !== null) return;
    terminalOutputFlushRef.current = window.requestAnimationFrame(flushTerminalOutput);
  }

  function flushTerminalOutput() {
    terminalOutputFlushRef.current = null;
    if (terminalOutputBuffersRef.current.size === 0) return;
    const batch = terminalOutputBuffersRef.current;
    terminalOutputBuffersRef.current = new Map();
    const matchedTerminalIds = new Set<string>();
    setSessions((current) =>
      current.map((session) => {
        let nextEntries = session.terminal;
        for (const [terminalId, entries] of batch) {
          const mappedSessionId = terminalSessionMapRef.current.get(terminalId);
          if (session.terminalId !== terminalId && session.id !== mappedSessionId) continue;
          matchedTerminalIds.add(terminalId);
          nextEntries = appendTerminalStreamEntries(nextEntries, entries);
        }
        return nextEntries === session.terminal ? session : { ...session, terminal: nextEntries };
      }),
    );
    for (const [terminalId, entries] of batch) {
      if (matchedTerminalIds.has(terminalId)) continue;
      const pending = pendingTerminalEntriesRef.current.get(terminalId) ?? [];
      pendingTerminalEntriesRef.current.set(terminalId, appendTerminalStreamEntries(pending, entries));
    }
    pruneStalePendingTerminals();
  }

  function pruneStalePendingTerminals() {
    if (pendingTerminalEntriesRef.current.size === 0) return;
    const live = new Set<string>(terminalSessionMapRef.current.keys());
    for (const terminalId of pendingTerminalEntriesRef.current.keys()) {
      if (!live.has(terminalId)) {
        pendingTerminalEntriesRef.current.delete(terminalId);
      }
    }
  }

  function clearTerminalOutputBuffers() {
    if (terminalOutputFlushRef.current !== null) {
      window.cancelAnimationFrame(terminalOutputFlushRef.current);
      terminalOutputFlushRef.current = null;
    }
    terminalOutputBuffersRef.current.clear();
  }

  function handleTerminalClosed(payload: TerminalClosedEvent) {
    terminalSessionMapRef.current.delete(payload.terminalId);
    pendingTerminalEntriesRef.current.delete(payload.terminalId);
    setSessions((current) =>
      current.map((session) =>
        session.terminalId === payload.terminalId
          ? {
              ...session,
              terminalId: null,
              terminal: [
                ...session.terminal,
                createTerminalEntry("system", "终端通道已关闭"),
              ],
            }
          : session,
      ),
    );
  }

  function updateTerminalCwd(terminalId: string, cwd: string) {
    const rawPath = cwd.trim();
    if (!rawPath.startsWith("/") || rawPath.includes("\n") || rawPath.includes("\r")) return;
    const nextPath = normalizeRemotePath(rawPath);
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session || session.currentPath === nextPath) return;
    updateSession(session.id, (item) => ({ ...item, currentPath: nextPath }));
    if (!session.sftpId) return;
    setSessionFilesLoading(session.id, true);
    void remoteApi
      .listFiles(session.sftpId, nextPath)
      .then((files) => {
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id && normalizeRemotePath(item.currentPath) === nextPath ? { ...item, files } : item,
          ),
        );
      })
      .catch(() => undefined)
      .finally(() => setSessionFilesLoading(session.id, false));
  }

  async function connectSession(session = activeSession) {
    if (!session || connectingSessionId === session.id) return;
    abortedConnectSessionsRef.current.delete(session.id);
    setConnectingSessionId(session.id);
    updateSession(session.id, (item) => ({ ...item, state: "connecting" }));
    let connection: Awaited<ReturnType<typeof remoteApi.connect>> | null = null;
    try {
      connection = await remoteApi.connect(session.id);
      const connectionId = connection.connectionId;
      pendingConnectionIdsRef.current.set(session.id, connectionId);
      if (abortedConnectSessionsRef.current.has(session.id)) {
        pendingConnectionIdsRef.current.delete(session.id);
        await remoteApi.disconnect(connectionId).catch(() => undefined);
        return;
      }
      const warnings: string[] = [];
      const initialPath = initialRemotePath(session.username, session.currentPath);

      // Open terminal first (fast) - show connected state immediately once terminal is ready
      const terminalResult = await remoteApi
        .openTerminal(connectionId, 100, 30)
        .then((value) => ({ value, error: null as unknown }))
        .catch((error: unknown) => ({ value: null, error }));

      if (abortedConnectSessionsRef.current.has(session.id)) {
        pendingConnectionIdsRef.current.delete(session.id);
        await remoteApi.disconnect(connectionId).catch(() => undefined);
        return;
      }

      const terminal = terminalResult.value;
      if (terminal) {
        terminalSessionMapRef.current.set(terminal.terminalId, session.id);
        const pendingTerminalEntries = pendingTerminalEntriesRef.current.get(terminal.terminalId);
        if (pendingTerminalEntries?.length) {
          pendingTerminalEntriesRef.current.delete(terminal.terminalId);
          updateSession(session.id, (item) => ({
            ...item,
            terminal: [...item.terminal, ...pendingTerminalEntries],
          }));
        }
      }

      // Mark as connected immediately with terminal ready - SFTP loads in background
      pendingConnectionIdsRef.current.delete(session.id);
      updateSession(session.id, (item) => ({
        ...item,
        state: "connected",
        currentPath: initialPath,
        connectionId,
        terminalId: terminal?.terminalId ?? null,
        sftpId: null,
        telemetryJobId: null,
        files: [],
        terminal: [
          ...item.terminal,
          ...(terminalResult.error ? [createTerminalEntry("error", `终端不可用：${getErrorMessage(terminalResult.error)}`)] : []),
        ],
      }));
      setConnectingSessionId(null);

      // Open SFTP in background - don't block the user from using the terminal
      openSftpWithFiles(connectionId, initialPath, session.username).then((sftpResult) => {
        if (abortedConnectSessionsRef.current.has(session.id)) return;
        const sftp = sftpResult.sftp;
        if (sftp) rememberTransferTarget(sftp.sftpId, session.id);
        updateSession(session.id, (item) => ({
          ...item,
          currentPath: sftp ? sftpResult.path : item.currentPath,
          sftpId: sftp?.sftpId ?? null,
          files: sftpResult.files.length > 0 ? sftpResult.files : item.files,
          terminal: sftpResult.error
            ? [...item.terminal, createTerminalEntry("error", `SFTP 不可用：${sftpUnavailableMessage(sftpResult.error)}`)]
            : item.terminal,
        }));
      });

      // Start telemetry in background
      Promise.all([
        remoteApi.startTelemetry(connectionId, session.id, 5000).catch(() => null),
        remoteApi.telemetrySnapshot(connectionId).catch(() => null),
      ]).then(([telemetryJob, initialTelemetry]) => {
        if (abortedConnectSessionsRef.current.has(session.id)) return;
        updateSession(session.id, (item) => ({
          ...item,
          telemetryJobId: telemetryJob?.jobId ?? item.telemetryJobId,
          telemetry: initialTelemetry && hasTelemetryData(initialTelemetry) ? initialTelemetry : item.telemetry,
        }));
      });

      if (!terminal) {
        throw new Error("SSH 已连接，但远端拒绝打开终端通道");
      }
    } catch (error) {
      if (connection?.connectionId) {
        await remoteApi.disconnect(connection.connectionId).catch(() => undefined);
      }
      pendingConnectionIdsRef.current.delete(session.id);
      if (abortedConnectSessionsRef.current.has(session.id)) {
        return;
      }
      updateSession(session.id, (item) => ({ ...item, state: "failed" }));
      const hostKey = getHostKeyPayload(error);
      if (hostKey) {
        Modal.confirm({
          title: hostKey.expectedFingerprint ? "主机密钥已变化" : "确认主机密钥",
          content: `${hostKey.host}:${hostKey.port} ${hostKey.algorithm} ${hostKey.fingerprint}`,
          okText: "信任并连接",
          cancelText: "取消",
          onOk: async () => {
            const snapshot = await remoteApi.trustHostKey(hostKey.sessionId, hostKey.algorithm, hostKey.fingerprint);
            setConfigSnapshot(snapshot);
            await connectSession(session);
          },
        });
      } else {
        appendTerminal(session.id, "error", formatSessionError(error, session));
      }
    } finally {
      abortedConnectSessionsRef.current.delete(session.id);
      setConnectingSessionId((current) => (current === session.id ? null : current));
    }
  }

  async function openSftpWithFiles(connectionId: string, initialPath: string, username: string) {
    try {
      const sftp = await remoteApi.openSftp(connectionId);
      try {
        const files = await remoteApi.listFiles(sftp.sftpId, initialPath);
        return { sftp, path: initialPath, files, error: null as unknown };
      } catch (error) {
        const homePath = defaultRemoteHomePath(username);
        if (normalizeRemotePath(initialPath) === homePath) throw error;
        const files = await remoteApi.listFiles(sftp.sftpId, homePath);
        return { sftp, path: homePath, files, error: null as unknown };
      }
    } catch (error) {
      return { sftp: null, path: initialPath, files: [] as RemoteSession["files"], error };
    }
  }

  async function sendTerminalData(data: string) {
    if (!activeSession?.terminalId) return;
    try {
      await remoteApi.writeTerminal(activeSession.terminalId, data);
    } catch (error) {
      appendTerminal(activeSession.id, "error", formatSessionError(error, activeSession));
    }
  }

  async function sendTerminalCommand(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    await sendTerminalData(`${trimmed}\r`);
  }

  async function resizeTerminal(terminalId: string | null | undefined, cols: number, rows: number) {
    if (!terminalId) return;
    try {
      await remoteApi.resizeTerminal(terminalId, cols, rows);
    } catch {
      // resize 是交互优化，失败不打断当前终端。
    }
  }

  function clearActiveTerminal() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({ ...session, terminal: [] }));
  }

  async function changePath(path: string) {
    const session = activeSession;
    updateActiveSession((item) => ({ ...item, currentPath: path }));
    if (!session?.sftpId) return;
    setSessionFilesLoading(session.id, true);
    try {
      await refreshFiles(session.sftpId, path, session.id);
    } finally {
      setSessionFilesLoading(session.id, false);
    }
  }

  async function refreshActiveFiles() {
    const session = activeSession;
    if (!session) return;
    setSessionFilesLoading(session.id, true);
    try {
      if (session.sftpId) {
        await refreshFiles(session.sftpId, session.currentPath, session.id);
        return;
      }
      if (session.state !== "connected" || !session.connectionId) return;

      appendTerminal(session.id, "system", "正在连接 SFTP...");
      const sftpResult = await openSftpWithFiles(
        session.connectionId,
        initialRemotePath(session.username, session.currentPath),
        session.username,
      );
      if (!sftpResult.sftp) {
        appendTerminal(session.id, "error", `SFTP 不可用：${sftpUnavailableMessage(sftpResult.error)}`);
        return;
      }
      updateSession(session.id, (item) =>
        item.connectionId === session.connectionId
          ? {
              ...item,
              currentPath: sftpResult.path,
              sftpId: sftpResult.sftp.sftpId,
              files: sftpResult.files,
              terminal: [...item.terminal, createTerminalEntry("system", "SFTP 已连接")],
            }
          : item,
      );
    } finally {
      setSessionFilesLoading(session.id, false);
    }
  }

  async function runFileOperation(operation: FileOperation) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前连接不可用");
    const sftpId = session.sftpId;
    switch (operation.kind) {
      case "create":
        if (operation.entryType === "directory") {
          await remoteApi.mkdir(sftpId, operation.path);
        } else {
          await remoteApi.createFile(sftpId, operation.path);
        }
        break;
      case "rename":
        await remoteApi.rename(sftpId, operation.sourcePath, operation.targetPath);
        break;
      case "copy":
        await remoteApi.copy(
          sftpId,
          operation.sourcePath,
          await resolveSftpOperationTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
        );
        break;
      case "move":
        await remoteApi.rename(
          sftpId,
          operation.sourcePath,
          await resolveSftpOperationTarget(sftpId, remoteSessionPath(session), operation.sourcePath, operation.targetPath),
        );
        break;
      case "delete":
        if (normalizeRemotePath(operation.sourcePath) === "/") throw new Error("不能删除根目录");
        await remoteApi.delete(sftpId, operation.sourcePath, true);
        break;
    }
    const latestSession = sessionsRef.current.find((item) => item.id === session.id);
    if (latestSession?.sftpId === sftpId) {
      await refreshFiles(sftpId, remoteSessionPath(latestSession), latestSession.id);
    }
  }

  async function uploadLocalFiles(localPaths: string[], targetDirectory: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    // 单文件上传走单连接 + 大缓冲（accelerated）；多文件走并发 + 普通缓冲，避免内存峰值。
    const accelerated = localPaths.length === 1;
    const queuedTransfers = await runUploadQueue(
      localPaths,
      accelerated ? 1 : uploadConcurrency(localPaths.length),
      (localPath) => {
        const name = localPath.split(/[\\/]/).filter(Boolean).pop();
        if (!name) return Promise.resolve(null);
        return remoteApi.upload(session.sftpId!, localPath, joinRemotePath(targetDirectory, name), true, accelerated);
      },
    );
    queuedTransfers.filter(Boolean).forEach((transfer) => upsertTransfer(transfer as TransferInfo));
    if (queuedTransfers.filter(Boolean).length > 1) setTransferCenterOpen(true);
  }

  async function downloadRemoteFile(remotePath: string, fileName: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const localPath = await save({
      title: "下载文件",
      defaultPath: fileName,
    });
    if (!localPath) return;
    upsertTransfer(await remoteApi.download(session.sftpId, remotePath, localPath, true));
    setTransferCenterOpen(true);
  }

  async function readRemoteText(path: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return remoteApi.readText(session.sftpId, path);
  }

  async function writeRemoteText(path: string, content: string) {
    const recordId = crypto.randomUUID();
    upsertFileSaveRecord({
      id: recordId,
      path,
      directory: getRemoteParentPath(path),
      name: getRemoteBaseName(path),
      content,
      status: "saving",
      error: null,
      savedAt: new Date().toISOString(),
    });
    try {
      await writeRemoteTextRaw(path, content);
      updateFileSaveRecord(recordId, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      updateFileSaveRecord(recordId, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
      setTransferCenterOpen(true);
      throw error;
    }
  }

  async function writeRemoteTextRaw(path: string, content: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    await remoteApi.writeText(session.sftpId, path, content);
    await refreshFiles(session.sftpId, remoteSessionPath(session), session.id);
  }

  function upsertFileSaveRecord(record: FileSaveRecord) {
    setFileSaveRecords((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 30));
  }

  function updateFileSaveRecord(recordId: string, patch: Partial<FileSaveRecord>) {
    setFileSaveRecords((current) => current.map((record) => (record.id === recordId ? { ...record, ...patch } : record)));
  }

  async function retryFileSaveRecord(recordId: string) {
    const record = fileSaveRecords.find((item) => item.id === recordId);
    if (!record) return;
    updateFileSaveRecord(recordId, { status: "saving", error: null, savedAt: new Date().toISOString() });
    try {
      await writeRemoteTextRaw(record.path, record.content);
      updateFileSaveRecord(recordId, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      updateFileSaveRecord(recordId, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
    }
  }

  async function refreshFiles(sftpId: string, path: string, sessionId: string) {
    try {
      const files = await remoteApi.listFiles(sftpId, path);
      updateSession(sessionId, (session) => ({ ...session, files }));
    } catch (error) {
      const session = sessionsRef.current.find((item) => item.id === sessionId || item.sftpId === sftpId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
    }
  }

  async function searchRemoteFile(query: string) {
    const session = activeSession;
    if (!session?.sftpId) return null;
    const targetPath = await remoteApi.searchFile(session.sftpId, remoteSessionPath(session), query);
    if (!targetPath) return null;
    const directory = getRemoteParentPath(targetPath);
    setSessionFilesLoading(session.id, true);
    try {
      const files = await remoteApi.listFiles(session.sftpId, directory);
      updateSession(session.id, (item) => ({
        ...item,
        currentPath: directory,
        files,
      }));
    } finally {
      setSessionFilesLoading(session.id, false);
    }
    return targetPath;
  }

  async function listRemoteDirectory(path: string) {
    const session = activeSession;
    if (!session?.sftpId) throw new Error("当前 SFTP 不可用");
    return remoteApi.listFiles(session.sftpId, path);
  }

  async function exportBackup(path: string) {
    setBackupBusy(true);
    try {
      await vaultApi.backupExport(path);
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup(path: string) {
    await loadBackupSnapshot(() => vaultApi.backupImport(path));
  }

  async function restoreBackupRecord(recordId: string) {
    await loadBackupSnapshot(() => vaultApi.backupRecordRestore(recordId));
  }

  async function loadBackupSnapshot(loader: () => Promise<ConfigSnapshot>) {
    setBackupBusy(true);
    try {
      const snapshot = await loader();
      terminalSessionMapRef.current.clear();
      pendingTerminalEntriesRef.current.clear();
      clearTerminalOutputBuffers();
      setTransfers([]);
      setForwards([]);
      setFileLoadingSessionIds(new Set());
      setConnectingSessionId(null);
      applySnapshot(snapshot);
      setBackupOpen(false);
    } finally {
      setBackupBusy(false);
    }
  }

  async function saveSettings(settings: AppSettings) {
    const snapshot = await vaultApi.settingsUpdate(settings);
    setConfigSnapshot(snapshot);
    setSettingsOpen(false);
  }

  async function saveBackupSettings(settings: AppSettings) {
    const snapshot = await vaultApi.settingsUpdate(settings);
    setConfigSnapshot(snapshot);
  }

  async function saveQuickCommands(nextCommands: AppSettings["quickCommands"]) {
    if (!configSnapshot) return;
    const snapshot = await vaultApi.settingsUpdate({
      ...configSnapshot.data.settings,
      backup: configSnapshot.data.settings.backup ?? defaultBackupSettings(),
      quickCommands: nextCommands ?? [],
    });
    setConfigSnapshot(snapshot);
  }

  function saveTerminalInputHistory(history: AppSettings["terminalInputHistory"]) {
    // 防抖 800ms，避免每次按键都写 vault
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
      }).then(setConfigSnapshot).catch(() => undefined);
    }, 800);
  }

  async function runConfiguredBackup(showBusy = true) {
    if (autoBackupRunningRef.current) return;
    autoBackupRunningRef.current = true;
    if (showBusy) setBackupBusy(true);
    try {
      const snapshot = await vaultApi.backupRunNow();
      setConfigSnapshot(snapshot);
    } finally {
      autoBackupRunningRef.current = false;
      if (showBusy) setBackupBusy(false);
    }
  }

  async function deleteBackupRecord(recordId: string, deleteFile: boolean) {
    const snapshot = await vaultApi.backupRecordDelete(recordId, deleteFile);
    setConfigSnapshot(snapshot);
  }

  async function createTunnel(input: TunnelInput) {
    const snapshot = await vaultApi.tunnelCreate(input);
    setConfigSnapshot(snapshot);
  }

  async function updateTunnel(tunnelId: string, input: TunnelInput) {
    const snapshot = await vaultApi.tunnelUpdate(tunnelId, input);
    setConfigSnapshot(snapshot);
  }

  async function deleteTunnel(tunnelId: string) {
    const snapshot = await vaultApi.tunnelDelete(tunnelId);
    setConfigSnapshot(snapshot);
  }

  async function startTunnel(tunnel: TunnelConfig) {
    const started =
      tunnel.forwardType === "local"
        ? await remoteApi.startLocalForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort)
        : tunnel.forwardType === "remote"
          ? await remoteApi.startRemoteForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort, tunnel.targetHost, tunnel.targetPort)
          : await remoteApi.startDynamicForward(tunnel.sessionId, tunnel.bindHost, tunnel.bindPort);
    upsertForward(started);
  }

  async function stopTunnel(forwardId: string) {
    await remoteApi.stopForward(forwardId);
    setForwards((current) => current.filter((forward) => forward.forwardId !== forwardId));
  }

  const isVaultOpen = vaultMode !== "ready";

  return (
    <AppProviders>
      {/* 主界面始终渲染 */}
      <div className="appShell">
          {vaultMode === "ready" ? (
            <Suspense fallback={<AppLoadingFallback />}>
              <>
                <TopBar
                  sessions={sessions}
                  tabSessions={openSessions}
                  activeSessionId={activeSession?.id ?? ""}
                  onActivate={activateSession}
                  onAdd={() => void addSession(true)}
                  onClose={closeSession}
                  onEdit={(id) => editSession(id, true)}
                  onConnect={(session) => void connectSession(session)}
                  onDisconnect={(session) => void disconnectSession(session)}
                  onLock={lockVault}
                  onTransferOpen={() => setTransferCenterOpen(true)}
                  onSettingsOpen={() => setSettingsOpen(true)}
                  connectingSessionId={connectingSessionId}
                  transfers={transfers}
                  sessionListOpen={sessionListOpen}
                  onSessionListOpenChange={setSessionListOpen}
                />
                {activeSession ? (
                  <main className="workspace">
                    <TelemetrySidebar session={activeSession} />
                    <section className="mainSurface">
                      <SplitPane
                        minTop={240}
                        minBottom={220}
                        top={
                          <TerminalPanel
                            session={activeSession}
                            inputHistory={configSnapshot?.data.settings.terminalInputHistory ?? []}
                            onSendData={(data) => void sendTerminalData(data)}
                            onSendCommand={(command) => void sendTerminalCommand(command)}
                            onResize={(cols, rows) => void resizeTerminal(activeSession.terminalId, cols, rows)}
                            onClear={clearActiveTerminal}
                            onInputHistoryChange={saveTerminalInputHistory}
                          />
                        }
                        bottom={
                          <FileManager
                            session={activeSession}
                            onPathChange={(path) => void changePath(path)}
                            onRefresh={refreshActiveFiles}
                            onRemoteSearch={searchRemoteFile}
                            onListDirectory={listRemoteDirectory}
                            onFileOperation={runFileOperation}
                            onUploadFiles={uploadLocalFiles}
                            onDownloadFile={downloadRemoteFile}
                            onReadText={readRemoteText}
                            onWriteText={writeRemoteText}
                            onSendCommand={sendTerminalCommand}
                            quickCommands={configSnapshot?.data.settings.quickCommands ?? []}
                            onQuickCommandsChange={saveQuickCommands}
                            filesLoading={fileLoadingSessionIds.has(activeSession.id)}
                          />
                        }
                      />
                    </section>
                  </main>
                ) : null}
              </>
            </Suspense>
          ) : (
            <div className="appPlaceholder" />
          )}
      </div>

      {/* Vault 弹窗叠加 */}
      <VaultGate
          open={isVaultOpen}
          mode={vaultMode === "create" ? "create" : vaultMode === "loading" ? "loading" : "unlock"}
          loading={vaultBusy || vaultMode === "loading"}
          error={vaultError}
          onCreate={createVault}
          onUnlock={unlockVault}
        />
      {vaultMode === "ready" && (
          <Suspense fallback={null}>
            <TransferCenter
              open={transferCenterOpen}
              transfers={transfers}
              sessions={sessions}
              transferSessionIds={transferSessionIds}
              saveRecords={fileSaveRecords}
              backupRecords={configSnapshot?.data.backupRecords ?? []}
              canUpload={Boolean(activeSession?.sftpId)}
              onClose={() => setTransferCenterOpen(false)}
              onPause={(id) => void pauseTransfer(id)}
              onResume={(id) => void resumeTransfer(id)}
              onCancel={(id) => void cancelTransfer(id)}
              onRetry={(id) => void retryTransfer(id)}
              onRemove={(id) => void removeTransfer(id)}
              onRetrySave={(id) => void retryFileSaveRecord(id)}
              onRemoveSave={(id) => setFileSaveRecords((current) => current.filter((record) => record.id !== id))}
              onRestoreBackup={(id) => void restoreBackupRecord(id)}
              onRemoveBackup={(id) => void deleteBackupRecord(id, false)}
              onClear={() => {
                clearFinishedTransferHistory();
                setFileSaveRecords([]);
                void vaultApi.backupRecordsClear().then(setConfigSnapshot);
              }}
              onUploadFiles={(paths) => void uploadLocalFiles(paths, activeSession?.currentPath ?? "/")}
            />
          </Suspense>
      )}
      {configSnapshot && (
          <Suspense fallback={null}>
            <BackupModal
              open={backupOpen}
              busy={backupBusy}
              settings={configSnapshot.data.settings ?? { proxy: null, backup: defaultBackupSettings(), quickCommands: [] }}
              records={configSnapshot.data.backupRecords ?? []}
              onClose={() => setBackupOpen(false)}
              onExport={exportBackup}
              onImport={importBackup}
              onSettingsSave={saveBackupSettings}
              onRunNow={() => runConfiguredBackup()}
              onRestoreRecord={restoreBackupRecord}
              onDeleteRecord={deleteBackupRecord}
            />
            <SettingsModal
              open={settingsOpen}
              initialValue={configSnapshot.data.settings ?? { proxy: null, backup: defaultBackupSettings(), quickCommands: [] }}
              onClose={() => setSettingsOpen(false)}
              onSubmit={saveSettings}
              onBackupOpen={() => setBackupOpen(true)}
              onTunnelOpen={() => setTunnelOpen(true)}
              appInfo={appInfo}
              updateInfo={updateInfo}
              updateError={updateError}
              updateChecking={updateChecking}
              updateDownloading={updateDownloading}
              downloadedUpdatePath={downloadedUpdatePath}
              updateRepo={appApi.updateRepo()}
              onCheckUpdate={checkForUpdate}
              onDownloadUpdate={downloadUpdate}
              onOpenDatabaseDir={openDatabaseDir}
              onOpenExternalUrl={openExternalUrl}
            />
            <TunnelDrawer
              open={tunnelOpen}
              sessions={sessions}
              tunnels={configSnapshot.data.tunnels ?? []}
              forwards={forwards}
              onClose={() => setTunnelOpen(false)}
              onCreate={createTunnel}
              onUpdate={updateTunnel}
              onDelete={deleteTunnel}
              onStart={startTunnel}
              onStop={stopTunnel}
            />
          </Suspense>
      )}
      {configSnapshot && sessionModal && (
          <Suspense fallback={null}>
            <SessionConfigModal
              open
              mode={sessionModal.mode}
              initialValue={sessionModal.input}
              groups={configSnapshot.data.groups}
              onCancel={closeSessionConfigModal}
              onCancelButton={returnToSessionListOnCancel ? backToSessionListFromConfig : undefined}
              onSubmit={saveSessionConfig}
            />
          </Suspense>
      )}
    </AppProviders>
  );
}

function loadTransferHistory(): Pick<TransferHistorySnapshot, "transfers" | "transferSessionIds"> {
  const empty = { transfers: [] as TransferInfo[], transferSessionIds: {} as Record<string, string> };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(TRANSFER_HISTORY_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<TransferHistorySnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.transfers)) return empty;
    const transfers = limitTransferHistory(parsed.transfers.filter(isTransferInfo).map(normalizePersistedTransfer));
    const transferSessionIds = sanitizeTransferSessionIds(parsed.transferSessionIds);
    return { transfers, transferSessionIds };
  } catch {
    return empty;
  }
}

function persistTransferHistory(transfers: TransferInfo[], transferSessionIds: Record<string, string>) {
  if (typeof window === "undefined") return;
  const limitedTransfers = limitTransferHistory(transfers);
  const snapshot: TransferHistorySnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    transfers: limitedTransfers,
    transferSessionIds: sanitizeTransferSessionIds(transferSessionIds, new Set(limitedTransfers.map((transfer) => transfer.sftpId))),
  };
  try {
    window.localStorage.setItem(TRANSFER_HISTORY_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage 可能不可用或超额，传输记录持久化失败不阻断主流程。
  }
}

function removeTransferHistory() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TRANSFER_HISTORY_STORAGE_KEY);
  } catch {
    // 忽略本地存储清理失败。
  }
}

function limitTransferHistory(transfers: TransferInfo[]) {
  return [...transfers]
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))
    .slice(0, TRANSFER_HISTORY_LIMIT);
}

function normalizePersistedTransfer(transfer: TransferInfo): TransferInfo {
  if (transfer.status !== "queued" && transfer.status !== "running" && transfer.status !== "paused") {
    return { ...transfer, speedKbps: transfer.status === "completed" ? 0 : transfer.speedKbps };
  }
  return {
    ...transfer,
    status: "canceled",
    speedKbps: 0,
    error: transfer.error ?? "程序已关闭，传输已停止",
    updatedAt: new Date().toISOString(),
  };
}

function shouldKeepTransferOnClear(transfer: TransferInfo) {
  return transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused";
}

function sanitizeTransferSessionIds(value: unknown, allowedSftpIds?: Set<string>): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && (!allowedSftpIds || allowedSftpIds.has(entry[0])),
    ),
  );
}

function isTransferInfo(value: unknown): value is TransferInfo {
  if (!value || typeof value !== "object") return false;
  const transfer = value as Partial<TransferInfo>;
  return (
    typeof transfer.transferId === "string" &&
    typeof transfer.sftpId === "string" &&
    (transfer.direction === "upload" || transfer.direction === "download") &&
    typeof transfer.localPath === "string" &&
    typeof transfer.remotePath === "string" &&
    isTransferStatus(transfer.status) &&
    typeof transfer.bytesDone === "number" &&
    typeof transfer.bytesTotal === "number" &&
    typeof transfer.speedKbps === "number" &&
    typeof transfer.createdAt === "string" &&
    typeof transfer.updatedAt === "string"
  );
}

function isTransferStatus(status: unknown): status is TransferInfo["status"] {
  return (
    status === "queued" ||
    status === "running" ||
    status === "paused" ||
    status === "completed" ||
    status === "failed" ||
    status === "canceled"
  );
}

export default App;
