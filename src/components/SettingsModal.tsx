import { ApartmentOutlined, ExportOutlined } from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Switch } from "antd";
import { useEffect } from "react";
import type { AppSettings } from "../types";

interface SettingsModalProps {
  open: boolean;
  initialValue: AppSettings;
  onClose: () => void;
  onSubmit: (settings: AppSettings) => Promise<void>;
  onBackupOpen: () => void;
  onTunnelOpen: () => void;
}

interface SettingsFormValues {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

export function SettingsModal({ open, initialValue, onClose, onSubmit, onBackupOpen, onTunnelOpen }: SettingsModalProps) {
  const [form] = Form.useForm<SettingsFormValues>();
  const enabled = Form.useWatch("enabled", form);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      enabled: initialValue.proxy?.enabled ?? false,
      kind: initialValue.proxy?.kind ?? "socks5",
      host: initialValue.proxy?.host ?? "127.0.0.1",
      port: initialValue.proxy?.port ?? 1080,
    });
  }, [form, initialValue, open]);

  async function submit() {
    const values = await form.validateFields();
    await onSubmit({
      ...initialValue,
      proxy: values.enabled
        ? {
            enabled: true,
            kind: values.kind,
            host: values.host.trim(),
            port: values.port,
          }
        : null,
    });
  }

  return (
    <Modal
      open={open}
      title="全局设置"
      className="settingsModal"
      okText="保存"
      cancelText="取消"
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div className="settingsPanel">
          <div className="settingsSectionTitle">数据与连接</div>
          <div className="settingsShortcutGrid">
            <Button block icon={<ExportOutlined />} onClick={onBackupOpen}>
              数据备份与恢复
            </Button>
            <Button block icon={<ApartmentOutlined />} onClick={onTunnelOpen}>
              SSH 隧道管理
            </Button>
          </div>
        </div>
        <div className="settingsPanel">
          <div className="settingsProxyHeader">
            <span className="settingsSectionTitle">应用内全局代理</span>
            <Form form={form} component={false}>
              <Form.Item name="enabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
            </Form>
          </div>
          <Form form={form} layout="vertical" requiredMark={false} className="settingsProxyForm">
            <Form.Item label="代理类型" name="kind">
              <Select
                disabled={!enabled}
                options={[
                  { label: "SOCKS5", value: "socks5" },
                  { label: "HTTP CONNECT", value: "httpConnect" },
                ]}
              />
            </Form.Item>
            <Form.Item label="代理主机" name="host" rules={enabled ? [{ required: true, message: "请输入代理主机" }] : []}>
              <Input disabled={!enabled} placeholder="127.0.0.1" />
            </Form.Item>
            <Form.Item label="代理端口" name="port" rules={enabled ? [{ required: true, message: "请输入代理端口" }] : []}>
              <InputNumber disabled={!enabled} min={1} max={65535} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Form>
        </div>
      </Space>
    </Modal>
  );
}
