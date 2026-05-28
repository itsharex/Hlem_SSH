import { useEffect, useRef, useState } from "react";
import { readJsonStorage, removeStorage, writeJsonStorage } from "../lib/storage";
import { isActiveTransfer } from "../lib/transferRecords";
import type { TransferInfo } from "../types";

type TransferHistorySnapshot = {
  version: 1;
  savedAt: string;
  transfers: TransferInfo[];
  transferSessionIds: Record<string, string>;
};

type TransferHistoryState = Pick<TransferHistorySnapshot, "transfers" | "transferSessionIds">;

const TRANSFER_HISTORY_STORAGE_KEY = "helm:transferHistory:v1";
const TRANSFER_HISTORY_LIMIT = 100;

export function useTransferHistory() {
  const initialRef = useRef<TransferHistoryState | null>(null);
  if (!initialRef.current) initialRef.current = loadTransferHistory();

  const [transfers, setTransfersState] = useState<TransferInfo[]>(initialRef.current.transfers);
  const [transferSessionIds, setTransferSessionIdsState] = useState<Record<string, string>>(
    initialRef.current.transferSessionIds,
  );
  const transfersRef = useRef(transfers);
  const transferSessionIdsRef = useRef(transferSessionIds);
  const persistTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, []);

  function setPersistedTransfers(updater: TransferInfo[] | ((current: TransferInfo[]) => TransferInfo[])) {
    const rawNext = typeof updater === "function" ? updater(transfersRef.current) : updater;
    const next = limitTransferHistory(rawNext);
    transfersRef.current = next;
    setTransfersState(next);
    schedulePersist(next, transferSessionIdsRef.current);
  }

  function setPersistedTransferSessionIds(
    updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>),
  ) {
    const next = typeof updater === "function" ? updater(transferSessionIdsRef.current) : updater;
    transferSessionIdsRef.current = next;
    setTransferSessionIdsState(next);
    schedulePersist(transfersRef.current, next);
  }

  function resetTransferHistory(nextTransfers: TransferInfo[] = [], nextSessionIds: Record<string, string> = {}) {
    const limited = limitTransferHistory(nextTransfers);
    const sessionIds = sanitizeTransferSessionIds(nextSessionIds, new Set(limited.map((transfer) => transfer.sftpId)));
    transfersRef.current = limited;
    transferSessionIdsRef.current = sessionIds;
    setTransfersState(limited);
    setTransferSessionIdsState(sessionIds);
    schedulePersist(limited, sessionIds);
  }

  function clearFinishedTransferHistory() {
    resetTransferHistory(
      transfersRef.current.filter(isActiveTransfer),
      transferSessionIdsRef.current,
    );
  }

  function schedulePersist(nextTransfers: TransferInfo[], nextSessionIds: Record<string, string>) {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    const transfersToSave = limitTransferHistory(nextTransfers);
    const sessionIdsToSave = sanitizeTransferSessionIds(
      nextSessionIds,
      new Set(transfersToSave.map((transfer) => transfer.sftpId)),
    );
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      if (transfersToSave.length === 0) {
        removeStorage(TRANSFER_HISTORY_STORAGE_KEY);
        return;
      }
      persistTransferHistory(transfersToSave, sessionIdsToSave);
    }, 0);
  }

  return {
    transfers,
    transfersRef,
    transferSessionIds,
    transferSessionIdsRef,
    setPersistedTransfers,
    setPersistedTransferSessionIds,
    resetTransferHistory,
    clearFinishedTransferHistory,
  };
}

function loadTransferHistory(): TransferHistoryState {
  return readJsonStorage<TransferHistoryState>(
    TRANSFER_HISTORY_STORAGE_KEY,
    { transfers: [], transferSessionIds: {} },
    (value) => {
      if (!value || typeof value !== "object") return { transfers: [], transferSessionIds: {} };
      const parsed = value as Partial<TransferHistorySnapshot>;
      if (parsed.version !== 1 || !Array.isArray(parsed.transfers)) {
        return { transfers: [], transferSessionIds: {} };
      }
      const transfers = limitTransferHistory(parsed.transfers.filter(isTransferInfo).map(normalizePersistedTransfer));
      return {
        transfers,
        transferSessionIds: sanitizeTransferSessionIds(
          parsed.transferSessionIds,
          new Set(transfers.map((transfer) => transfer.sftpId)),
        ),
      };
    },
  );
}

function persistTransferHistory(transfers: TransferInfo[], transferSessionIds: Record<string, string>) {
  const limitedTransfers = limitTransferHistory(transfers);
  const snapshot: TransferHistorySnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    transfers: limitedTransfers,
    transferSessionIds: sanitizeTransferSessionIds(transferSessionIds, new Set(limitedTransfers.map((transfer) => transfer.sftpId))),
  };
  writeJsonStorage(TRANSFER_HISTORY_STORAGE_KEY, snapshot);
}

function limitTransferHistory(transfers: TransferInfo[]) {
  return [...transfers]
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))
    .slice(0, TRANSFER_HISTORY_LIMIT);
}

function normalizePersistedTransfer(transfer: TransferInfo): TransferInfo {
  if (!isActiveTransfer(transfer)) {
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
