import { CopyOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { getErrorMessage } from "../lib/configMapping";
import type { ForwardInfo, RemoteSession, TunnelConfig, TunnelInput } from "../types";

interface TunnelDrawerProps {
  open: boolean;
  sessions: RemoteSession[];
  tunnels: TunnelConfig[];
  forwards: ForwardInfo[];
  onClose: () => void;
  onCreate: (input: TunnelInput) => Promise<void>;
  onUpdate: (id: string, input: TunnelInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onStart: (tunnel: TunnelConfig) => Promise<void>;
  onStop: (forwardId: string) => Promise<void>;
}

type TunnelModalState = { mode: "create"; value?: TunnelConfig } | { mode: "edit"; value: TunnelConfig };

export function TunnelDrawer({
  open,
  sessions,
  tunnels,
  forwards,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onStart,
  onStop,
}: TunnelDrawerProps) {
  const { message, modal } = AntdApp.useApp();
  const [editing, setEditing] = useState<TunnelModalState | null>(null);

  const tunnelColumns: ColumnsType<TunnelConfig> = [
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "类型", width: 80, render: (_, tunnel) => forwardTypeLabel(tunnel.forwardType) },
    { title: "会话", width: 120, render: (_, tunnel) => sessions.find((session) => session.id === tunnel.sessionId)?.name ?? "未知会话" },
    { title: "监听", width: 150, render: (_, tunnel) => `${tunnel.bindHost}:${tunnel.bindPort}` },
    { title: "目标", width: 150, render: (_, tunnel) => tunnel.forwardType === "dynamic" ? "SOCKS5" : `${tunnel.targetHost}:${tunnel.targetPort}` },
    {
      title: "操作",
      width: 148,
      render: (_, tunnel) => {
        const running = forwards.find((forward) => forwardMatchesTunnel(forward, tunnel));
        return (
          <Space size={4}>
            {running ? (
              <Tooltip title="停止">
                <Button aria-label="停止" size="small" icon={<StopOutlined />} onClick={() => void onStop(running.forwardId)} />
              </Tooltip>
            ) : (
              <Tooltip title="启动">
                <Button aria-label="启动" size="small" icon={<PlayCircleOutlined />} onClick={() => void startTunnel(tunnel)} />
              </Tooltip>
            )}
            <Tooltip title="编辑">
              <Button aria-label="编辑" size="small" icon={<EditOutlined />} onClick={() => setEditing({ mode: "edit", value: tunnel })} />
            </Tooltip>
            <Tooltip title="删除">
              <Button aria-label="删除" size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(tunnel)} />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const forwardColumns: ColumnsType<ForwardInfo> = [
    { title: "类型", width: 80, render: (_, forward) => forwardTypeLabel(forward.forwardType) },
    { title: "监听", render: (_, forward) => `${forward.bindHost}:${forward.bindPort}` },
    { title: "目标", render: (_, forward) => forward.forwardType === "dynamic" ? "SOCKS5" : `${forward.targetHost}:${forward.targetPort}` },
    { title: "状态", width: 90, render: (_, forward) => <Tag color={forward.status === "running" ? "green" : "default"}>{forward.status}</Tag> },
    {
      title: "操作",
      width: 112,
      render: (_, forward) => (
        <Space size={4}>
          <Tooltip title="复制监听地址">
            <Button aria-label="复制监听地址" size="small" icon={<CopyOutlined />} onClick={() => void copyBindAddress(forward)} />
          </Tooltip>
          <Tooltip title="停止">
            <Button aria-label="停止" size="small" icon={<StopOutlined />} onClick={() => void onStop(forward.forwardId)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  async function startTunnel(tunnel: TunnelConfig) {
    try {
      await onStart(tunnel);
      message.success("隧道已启动");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function confirmDelete(tunnel: TunnelConfig) {
    modal.confirm({
      title: "删除隧道模板",
      content: tunnel.name,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => onDelete(tunnel.id),
    });
  }

  async function copyBindAddress(forward: ForwardInfo) {
    const value = `${forward.bindHost}:${forward.bindPort}`;
    await navigator.clipboard?.writeText(value);
    message.success("监听地址已复制");
  }

  return (
    <>
      <Modal
        className="tunnelModal"
        title="SSH 隧道"
        open={open}
        onCancel={onClose}
        width={840}
        footer={null}
        destroyOnHidden
      >
        <div className="tunnelModalHeader">
          <span className="settingsSectionTitle">隧道模板</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ mode: "create" })}>新建</Button>
        </div>
        <Table rowKey="id" size="small" pagination={false} columns={tunnelColumns} dataSource={tunnels} />
        <h3 className="drawerSubTitle">运行中</h3>
        <Table rowKey="forwardId" size="small" pagination={false} columns={forwardColumns} dataSource={forwards} />
      </Modal>
      <TunnelConfigModal
        state={editing}
        sessions={sessions}
        onCancel={() => setEditing(null)}
        onSubmit={async (input) => {
          if (!editing) return;
          if (editing.mode === "edit") {
            await onUpdate(editing.value.id, input);
          } else {
            await onCreate(input);
          }
          setEditing(null);
        }}
      />
    </>
  );
}

function TunnelConfigModal({
  state,
  sessions,
  onCancel,
  onSubmit,
}: {
  state: TunnelModalState | null;
  sessions: RemoteSession[];
  onCancel: () => void;
  onSubmit: (input: TunnelInput) => Promise<void>;
}) {
  const [form] = Form.useForm<TunnelInput>();
  const forwardType = Form.useWatch("forwardType", form);

  useEffect(() => {
    if (!state) return;
    form.setFieldsValue(state.mode === "edit" ? state.value : {
      name: "",
      sessionId: sessions[0]?.id ?? "",
      forwardType: "local",
      bindHost: "127.0.0.1",
      bindPort: 0,
      targetHost: "127.0.0.1",
      targetPort: 22,
    });
  }, [form, sessions, state]);

  async function submit() {
    const values = await form.validateFields();
    await onSubmit({
      ...values,
      targetHost: values.forwardType === "dynamic" ? "SOCKS5" : values.targetHost,
      targetPort: values.forwardType === "dynamic" ? 0 : values.targetPort,
    });
  }

  return (
    <Modal
      open={Boolean(state)}
      className="tunnelConfigModal"
      title={state?.mode === "edit" ? "编辑隧道" : "新建隧道"}
      okText="保存"
      cancelText="取消"
      onCancel={onCancel}
      onOk={() => void submit()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
          <Input placeholder="数据库隧道" />
        </Form.Item>
        <Form.Item label="会话" name="sessionId" rules={[{ required: true, message: "请选择会话" }]}>
          <Select options={sessions.map((session) => ({ label: session.name, value: session.id }))} />
        </Form.Item>
        <Form.Item label="类型" name="forwardType">
          <Select
            options={[
              { label: "本地转发", value: "local" },
              { label: "远端转发", value: "remote" },
              { label: "动态 SOCKS5", value: "dynamic" },
            ]}
          />
        </Form.Item>
        <Form.Item label="监听地址" name="bindHost" rules={[{ required: true, message: "请输入监听地址" }]}>
          <Input />
        </Form.Item>
        <Form.Item label="监听端口" name="bindPort" rules={[{ required: true, message: "请输入监听端口" }]}>
          <InputNumber min={0} max={65535} precision={0} style={{ width: "100%" }} />
        </Form.Item>
        {forwardType !== "dynamic" && (
          <>
            <Form.Item label="目标地址" name="targetHost" rules={[{ required: true, message: "请输入目标地址" }]}>
              <Input />
            </Form.Item>
            <Form.Item label="目标端口" name="targetPort" rules={[{ required: true, message: "请输入目标端口" }]}>
              <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}

function forwardMatchesTunnel(forward: ForwardInfo, tunnel: TunnelConfig) {
  if (forward.sessionId !== tunnel.sessionId) return false;
  if (forward.forwardType !== tunnel.forwardType) return false;
  if (forward.bindHost !== tunnel.bindHost) return false;
  if (tunnel.bindPort !== 0 && forward.bindPort !== tunnel.bindPort) return false;
  if (tunnel.forwardType === "dynamic") return true;
  return forward.targetHost === tunnel.targetHost && forward.targetPort === tunnel.targetPort;
}

function forwardTypeLabel(type: TunnelConfig["forwardType"] | ForwardInfo["forwardType"]) {
  if (type === "local") return "本地";
  if (type === "remote") return "远端";
  return "动态";
}
