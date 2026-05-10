import { Alert, Button, Form, Input, Modal } from "antd";
import { useEffect } from "react";

interface VaultGateProps {
  open: boolean;
  mode: "create" | "unlock";
  loading: boolean;
  initializing?: boolean;
  error?: string;
  onCreate: (masterPassword: string) => void | Promise<void>;
  onUnlock: (masterPassword: string) => void | Promise<void>;
}

interface FormValues {
  masterPassword: string;
  confirmPassword?: string;
}

export function VaultGate({ open, mode, loading, initializing, error, onCreate, onUnlock }: VaultGateProps) {
  const [form] = Form.useForm<FormValues>();
  const isCreate = mode === "create";
  const masterPassword = Form.useWatch("masterPassword", form) ?? "";
  const confirmPassword = Form.useWatch("confirmPassword", form) ?? "";
  const passwordReady = masterPassword.trim().length > 0 && masterPassword.length >= 6;
  const canSubmit = isCreate ? passwordReady && confirmPassword === masterPassword : passwordReady;

  useEffect(() => {
    form.resetFields();
  }, [form, mode, open]);

  async function submit(values: FormValues) {
    try {
      if (isCreate) {
        await onCreate(values.masterPassword);
      } else {
        await onUnlock(values.masterPassword);
      }
    } finally {
      form.resetFields();
    }
  }

  return (
    <Modal
      open={open}
      footer={null}
      closable={false}
      maskClosable={false}
      centered
      width={400}
      styles={{
        mask: { backdropFilter: "blur(8px)", background: "rgba(244, 247, 250, 0.7)" },
        container: {
          padding: 0,
          borderRadius: 16,
          overflow: "hidden",
          background: "var(--bg-surface)",
          boxShadow: "var(--shadow-lg)",
        },
        body: { padding: 0 },
      }}
    >
      <div className="vaultPanel">
        <div className="vaultIcon">
          <img src="./nexus_icon.svg" alt="" aria-hidden="true" />
        </div>
        <h1>{isCreate ? "设置本机主密码" : "输入解锁密码"}</h1>
        <p>
          {isCreate
            ? "主密码用于保护本机会话数据，无法找回，请妥善保管。"
            : "解锁后，会话数据仅在本次运行期间保留在内存中。"}
        </p>

        {error && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
        )}

        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            label="本机主密码"
            name="masterPassword"
            rules={[
              { required: true, message: "请输入主密码" },
              { min: 6, message: "主密码至少 6 位" },
            ]}
          >
            <Input.Password
              autoFocus
              placeholder="输入主密码"
              size="large"
              onPressEnter={() => {
                if (canSubmit) form.submit();
              }}
            />
          </Form.Item>

          {isCreate && (
            <Form.Item
            label="确认本机主密码"
              name="confirmPassword"
              dependencies={["masterPassword"]}
              rules={[
                { required: true, message: "请再次输入主密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    return !value || getFieldValue("masterPassword") === value
                      ? Promise.resolve()
                      : Promise.reject(new Error("两次输入的主密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password
                placeholder="再次输入主密码"
                size="large"
                onPressEnter={() => {
                  if (canSubmit) form.submit();
                }}
              />
            </Form.Item>
          )}

          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            disabled={!canSubmit}
            block
            size="large"
          >
            {isCreate ? "开始使用" : "解锁工作区"}
          </Button>
        </Form>
      </div>
    </Modal>
  );
}
