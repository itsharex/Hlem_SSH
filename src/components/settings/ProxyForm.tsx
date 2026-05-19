import { Form, Input, InputNumber, Select, Switch } from "antd";

interface SettingsFormValues {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

interface ProxyFormProps {
  form: ReturnType<typeof Form.useForm<SettingsFormValues>>[0];
  enabled: boolean;
}

export function ProxyForm({ form, enabled }: ProxyFormProps) {
  return (
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
  );
}
