import { useEffect, useState } from "react";
import { remoteApi } from "../api/remoteApi";
import { vaultApi } from "../api/vaultApi";
import type { ConfigSnapshot, ForwardInfo, ForwardStatusEvent, TunnelConfig, TunnelInput } from "../types";

type UseTunnelRuntimeOptions = {
  appReady: boolean;
  applyConfigSnapshot: (snapshot: ConfigSnapshot) => void;
};

export function useTunnelRuntime({ appReady, applyConfigSnapshot }: UseTunnelRuntimeOptions) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);

  useEffect(() => {
    if (!appReady) return;
    void remoteApi.listForwards().then(setForwards).catch(() => undefined);
  }, [appReady]);

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

  function resetForwards() {
    setForwards([]);
  }

  async function createTunnel(input: TunnelInput) {
    applyConfigSnapshot(await vaultApi.tunnelCreate(input));
  }

  async function updateTunnel(tunnelId: string, input: TunnelInput) {
    applyConfigSnapshot(await vaultApi.tunnelUpdate(tunnelId, input));
  }

  async function deleteTunnel(tunnelId: string) {
    applyConfigSnapshot(await vaultApi.tunnelDelete(tunnelId));
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

  return {
    forwards,
    upsertForward,
    resetForwards,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
  };
}
