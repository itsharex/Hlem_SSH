import {
  ApiOutlined,
  AppstoreOutlined,
  DisconnectOutlined,
  EditOutlined,
  LeftOutlined,
  PlusOutlined,
  ProfileOutlined,
  RightOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Badge, Button, Modal, Space, Tabs, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ConnectionState, RemoteSession, TransferInfo } from "../types";

const SESSIONS_PER_PAGE = 5;

interface TopBarProps {
  sessions: RemoteSession[];
  tabSessions: RemoteSession[];
  activeSessionId: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onEdit: (id: string) => void;
  onConnect: (session: RemoteSession) => void;
  onDisconnect: (session: RemoteSession) => void;
  onTransferOpen: () => void;
  onSettingsOpen: () => void;
  connectingSessionId: string | null;
  transfers: TransferInfo[];
  sessionListOpen: boolean;
  onSessionListOpenChange: (open: boolean) => void;
  apiServerRunning: boolean;
  onApiServerStop: () => void;
}

export function TopBar({
  sessions,
  tabSessions,
  activeSessionId,
  onActivate,
  onAdd,
  onClose,
  onEdit,
  onConnect,
  onDisconnect,
  onTransferOpen,
  onSettingsOpen,
  connectingSessionId,
  transfers,
  sessionListOpen,
  onSessionListOpenChange,
  apiServerRunning,
  onApiServerStop,
}: TopBarProps) {
  const [sessionListPage, setSessionListPage] = useState(1);

  const sessionListPageCount = Math.max(1, Math.ceil(sessions.length / SESSIONS_PER_PAGE));
  const activeTransferTotal = activeTransferCount(transfers);

  useEffect(() => {
    if (sessionListPage > sessionListPageCount) setSessionListPage(sessionListPageCount);
  }, [sessionListPage, sessionListPageCount]);

  useEffect(() => {
    if (!sessionListOpen) return;
    const activeIndex = sessions.findIndex((session) => session.id === activeSessionId);
    if (activeIndex >= 0) setSessionListPage(Math.floor(activeIndex / SESSIONS_PER_PAGE) + 1);
    else setSessionListPage(1);
  }, [sessionListOpen, sessions, activeSessionId]);

  const pagedSessions = useMemo(() => {
    const start = (sessionListPage - 1) * SESSIONS_PER_PAGE;
    return sessions.slice(start, start + SESSIONS_PER_PAGE);
  }, [sessions, sessionListPage]);

  function openCreateSession() {
    onAdd();
  }

  function openSessionFromList(session: RemoteSession) {
    onActivate(session.id);
    onSessionListOpenChange(false);
    if (connectingSessionId === session.id || session.state === "connected") return;
    onConnect(session);
  }

  return (
    <header className="topBar">
      <div className="brand">
        <span className="brandMark">
          <img className="brandIcon" src="./nexus_icon.svg" alt="" aria-hidden="true" />
          <span>HelM</span>
        </span>
        <span className="brandActions">
          {apiServerRunning && (
            <Tooltip title="点击关闭 AI API" placement="bottom">
              <span className="brandApiIndicator" role="button" onClick={onApiServerStop}>
                <span className="brandApiDot" />
                <span className="brandApiText">API</span>
              </span>
            </Tooltip>
          )}
          <Tooltip title="设置" placement="bottom">
            <Button
              aria-label="设置"
              icon={<SettingOutlined />}
              size="small"
              onClick={onSettingsOpen}
            />
          </Tooltip>
        </span>
      </div>
      <Tabs
        className="sessionTabs"
        hideAdd
        tabBarExtraContent={{
          right: (
            <Tooltip title="会话列表" placement="bottom">
              <Button
                aria-label="会话列表"
                className="sessionTabsListButton"
                icon={<AppstoreOutlined />}
                size="small"
                onClick={() => onSessionListOpenChange(true)}
              />
            </Tooltip>
          ),
        }}
        type="editable-card"
        size="small"
        activeKey={activeSessionId}
        onChange={onActivate}
        onTabClick={(key) => {
          if (key === activeSessionId) {
            const session = tabSessions.find((s) => s.id === key);
            if (!session) return;
            const state = sessionState(session, connectingSessionId);
            if (state === "connected") {
              onDisconnect(session);
            } else if (state === "disconnected" || state === "failed") {
              onConnect(session);
            }
          }
        }}
        onEdit={(targetKey, action) => {
          if (action === "add") onAdd();
          if (action === "remove" && typeof targetKey === "string")
            onClose(targetKey);
        }}
        items={tabSessions.map((session) => {
          const state = sessionState(session, connectingSessionId);
          return {
            key: session.id,
            label: (
              <span className={`sessionTabLabel sessionTabLabel-${state}`}>
                <span className="sessionTabName">{session.name}</span>
              </span>
            ),
            closable: true,
          };
        })}
      />

      <Space size={4} className="toolbar">
        <Tooltip title={activeTransferTotal > 0 ? `传输进行中 · ${activeTransferTotal} 条` : "传输列表"} placement="bottom">
          <Badge size="small" count={activeTransferTotal} offset={[-2, 2]}>
            <Button
              aria-label="传输列表"
              className={activeTransferTotal > 0 ? "transferToolbarButton transferToolbarButton-active" : "transferToolbarButton"}
              icon={<ProfileOutlined />}
              size="small"
              onClick={onTransferOpen}
            />
          </Badge>
        </Tooltip>
      </Space>

      <Modal
        title={
          <div className="sessionListModalTitleBar">
            <div className="sessionListModalTitle">
              <span>SSH 列表</span>
              <small>{sessions.length} 个连接</small>
            </div>
            <Tooltip title="新建 SSH 连接">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                aria-label="新建 SSH 连接"
                className="sessionListModalAdd"
                onClick={openCreateSession}
              />
            </Tooltip>
          </div>
        }
        open={sessionListOpen}
        footer={null}
        centered
        width={560}
        className="sessionListModal"
        transitionName=""
        maskTransitionName=""
        destroyOnHidden
        onCancel={() => onSessionListOpenChange(false)}
      >
        <div className="sessionListModalBody">
          {pagedSessions.map((session) => {
            const active = session.id === activeSessionId;
            const state = sessionState(session, connectingSessionId);
            const connected = state === "connected";
            const connecting = connectingSessionId === session.id;

            return (
              <div
                key={session.id}
                className={`sessionListModalItem${active ? " sessionListModalItem-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => openSessionFromList(session)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openSessionFromList(session);
                  }
                }}
              >
                <span className={`stateDot stateDot-${state}`} />
                <span className="sessionListModalText">
                  <strong>{session.name}</strong>
                  <span>
                    {session.username}@{session.host}
                  </span>
                </span>
                <span className="sessionListModalActions">
                  <Tooltip title={connected ? "断开连接" : "连接"}>
                    <Button
                      aria-label={connected ? `断开 ${session.name}` : `连接 ${session.name}`}
                      icon={connected ? <DisconnectOutlined /> : <ApiOutlined />}
                      size="small"
                      loading={connecting}
                      danger={connected}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (connected) {
                          onDisconnect(session);
                        } else {
                          openSessionFromList(session);
                        }
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      aria-label={`编辑 ${session.name}`}
                      icon={<EditOutlined />}
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit(session.id);
                      }}
                    />
                  </Tooltip>
                </span>
              </div>
            );
          })}
        </div>
        {sessionListPageCount > 1 && (
          <div className="sessionListModalPager">
            <Button
              aria-label="上一页"
              size="small"
              icon={<LeftOutlined />}
              disabled={sessionListPage <= 1}
              onClick={() => setSessionListPage((page) => Math.max(1, page - 1))}
            />
            <span className="sessionListModalPagerInfo">
              <strong>{sessionListPage}</strong>
              <em>/</em>
              <span>{sessionListPageCount}</span>
            </span>
            <Button
              aria-label="下一页"
              size="small"
              icon={<RightOutlined />}
              disabled={sessionListPage >= sessionListPageCount}
              onClick={() => setSessionListPage((page) => Math.min(sessionListPageCount, page + 1))}
            />
          </div>
        )}
      </Modal>
    </header>
  );
}

function sessionState(session: RemoteSession, connectingSessionId: string | null): ConnectionState {
  return connectingSessionId === session.id ? "connecting" : session.state;
}

function activeTransferCount(transfers: TransferInfo[]) {
  return transfers.filter((transfer) => transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused").length;
}
