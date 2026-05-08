import { lazy } from "react";

export const BackupModal = lazy(() => import("../components/BackupModal").then((module) => ({ default: module.BackupModal })));
export const FileManager = lazy(() => import("../components/FileManager").then((module) => ({ default: module.FileManager })));
export const SettingsModal = lazy(() => import("../components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
export const SplitPane = lazy(() => import("../components/SplitPane").then((module) => ({ default: module.SplitPane })));
export const SessionConfigModal = lazy(() => import("../components/SessionConfigModal").then((module) => ({ default: module.SessionConfigModal })));
export const TelemetrySidebar = lazy(() => import("../components/TelemetrySidebar").then((module) => ({ default: module.TelemetrySidebar })));
export const TerminalPanel = lazy(() => import("../components/TerminalPanel").then((module) => ({ default: module.TerminalPanel })));
export const TopBar = lazy(() => import("../components/TopBar").then((module) => ({ default: module.TopBar })));
export const TransferCenter = lazy(() => import("../components/TransferCenter").then((module) => ({ default: module.TransferCenter })));
export const TunnelDrawer = lazy(() => import("../components/TunnelDrawer").then((module) => ({ default: module.TunnelDrawer })));

