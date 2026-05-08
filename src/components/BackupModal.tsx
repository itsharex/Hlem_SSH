import { CloudUploadOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, ImportOutlined, PlayCircleOutlined, RollbackOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect } from "react";
import type { AppSettings, BackupRecord, BackupSettings } from "../types";
import { getErrorMessage } from "../lib/configMapping";

interface BackupModalProps {
  open: boolean;
  busy: boolean;
  settings: AppSettings;
  records: BackupRecord[];
  onClose: () => void;
  onExport: (path: string) => Promise<void>;
  onImport: (path: string) => Promise<void>;
  onSettingsSave: (settings: AppSettings) => Promise<void>;
  onRunNow: () => Promise<void>;
  onRestoreRecord: (recordId: string) => Promise<void>;
  onDeleteRecord: (recordId: string, deleteFile: boolean) => Promise<void>;
}

type BackupTarget = "local" | "cloud";
type BackupFormValues = BackupSettings & { targetKind: BackupTarget };

export function BackupModal({
  open,
  busy,
  settings,
  records,
  onClose,
  onExport,
  onImport,
  onSettingsSave,
  onRunNow,
  onRestoreRecord,
  onDeleteRecord,
}: BackupModalProps) {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<BackupFormValues>();
  const backupTarget = Form.useWatch("targetKind", form) ?? "local";
  const cloudKind = Form.useWatch(["cloud", "kind"], form);
  const isCloudTarget = backupTarget === "cloud";

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      ...settings.backup,
      targetKind: settings.backup.cloud.enabled ? "cloud" : "local",
    });
  }, [form, open, settings.backup]);

  async function chooseExportPath() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: "导出备份",
        defaultPath: `HelM-backup-${formatBeijingTimestamp()}-BJT.zip`,
        filters: [{ name: "HelM 备份包", extensions: ["zip"] }],
      });
      if (!path) return;
      await onExport(path);
      message.success("备份已导出");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function chooseImportPath() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: "选择备份",
        multiple: false,
        filters: [{ name: "HelM 备份", extensions: ["zip", "rpvault"] }],
      });
      if (typeof path !== "string" || !path) return;
      modal.confirm({
        title: "恢复备份",
        content: "恢复会断开当前所有连接，并用备份覆盖本机数据。",
        okText: "恢复",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: async () => {
          await onImport(path);
          message.success("备份已恢复");
        },
      });
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function chooseLocalDirectory() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ title: "选择本地备份目录", directory: true, multiple: false });
      if (typeof path === "string" && path) {
        form.setFieldValue("localDirectory", path);
      }
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function saveBackupSettings() {
    try {
      const values = await form.validateFields();
      const { targetKind, ...backupValues } = values;
      const localDirectory = targetKind === "local" ? backupValues.localDirectory?.trim() || null : null;
      await onSettingsSave({
        ...settings,
        backup: {
          ...backupValues,
          localDirectory,
          retentionCount: backupValues.retentionCount || 10,
          retentionDays: backupValues.retentionDays || 30,
          cloud: {
            ...backupValues.cloud,
            enabled: targetKind === "cloud",
          },
        },
      });
      message.success("备份设置已保存");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  async function runBackupNow() {
    try {
      await onRunNow();
      message.success("备份已完成");
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function restoreRecord(record: BackupRecord) {
    modal.confirm({
      title: "恢复此备份",
      content: `将恢复 ${record.fileName}，并断开当前所有连接。`,
      okText: "恢复",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        await onRestoreRecord(record.id);
        message.success("备份已恢复");
      },
    });
  }

  const columns: ColumnsType<BackupRecord> = [
    { title: "时间", width: 150, render: (_, record) => new Date(record.createdAt).toLocaleString() },
    { title: "位置", width: 92, render: (_, record) => <Tag>{targetLabel(record.targetKind)}</Tag> },
    { title: "文件", dataIndex: "fileName", ellipsis: true },
    { title: "路径", dataIndex: "targetPath", ellipsis: true },
    { title: "大小", width: 90, render: (_, record) => formatBytes(record.size) },
    {
      title: "状态",
      width: 92,
      render: (_, record) => <Tag color={record.status === "success" ? "green" : "red"}>{record.status === "success" ? "成功" : "失败"}</Tag>,
    },
    {
      title: "",
      width: 92,
      render: (_, record) => (
        <Space size={4}>
          <Button
            aria-label="恢复此备份"
            size="small"
            icon={<RollbackOutlined />}
            disabled={record.status !== "success"}
            onClick={() => restoreRecord(record)}
          />
          <Popconfirm
            title="删除备份记录"
            description={record.targetKind === "local" ? "同时删除本地备份文件。" : "仅删除记录，不会删除云端文件。"}
            okText="删除"
            cancelText="取消"
            onConfirm={() => void onDeleteRecord(record.id, record.targetKind === "local")}
          >
            <Button aria-label="删除备份记录" size="small" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      title="数据备份与恢复"
      className="backupModal"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      width={760}
    >
      <Form form={form} layout="vertical" requiredMark={false} initialValues={settings.backup}>
        <div className="backupSimpleLayout">
          <section className="backupPanel backupPanel-actions">
            <div className="backupSectionHeader">
              <span>备份操作</span>
            </div>
            <div className="backupActionGrid">
              <Button icon={<ExportOutlined />} loading={busy} onClick={() => void chooseExportPath()}>
                导出备份
              </Button>
              <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={() => void runBackupNow()}>
                立即备份
              </Button>
              <Button danger icon={<ImportOutlined />} loading={busy} onClick={() => void chooseImportPath()}>
                恢复备份
              </Button>
            </div>
          </section>

          <section className="backupPanel">
            <div className="backupSectionHeader">
              <span>备份设置</span>
              <Button type="primary" size="small" onClick={() => void saveBackupSettings()}>
                保存配置
              </Button>
            </div>
            <Form.Item label="备份位置" name="targetKind" rules={[{ required: true }]}>
              <Segmented
                block
                options={[
                  { label: "本地", value: "local" },
                  { label: "云端", value: "cloud" },
                ]}
              />
            </Form.Item>
            {backupTarget === "local" && (
              <Form.Item label="本地备份目录">
                <Space.Compact className="backupDirectoryPicker" style={{ width: "100%" }}>
                  <Form.Item name="localDirectory" noStyle rules={[{ required: true, message: "请选择本地备份目录" }]}>
                    <Input placeholder="选择一个目录保存备份包" />
                  </Form.Item>
                  <Button aria-label="选择本地备份目录" icon={<FolderOpenOutlined />} onClick={() => void chooseLocalDirectory()} />
                </Space.Compact>
              </Form.Item>
            )}
            <div className="backupFormGrid backupFormGrid-tight">
              <Form.Item label="自动备份" name="autoEnabled" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item label="频率" name="frequency">
                <Select
                  options={[
                    { label: "手动", value: "manual" },
                    { label: "每小时", value: "hourly" },
                    { label: "每天", value: "daily" },
                    { label: "每周", value: "weekly" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="保留份数" name="retentionCount" rules={[{ required: true, message: "请输入保留份数" }]}>
                <InputNumber min={1} max={999} precision={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="保留天数" name="retentionDays" rules={[{ required: true, message: "请输入保留天数" }]}>
                <InputNumber min={1} max={3650} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </div>
          </section>

          {isCloudTarget && (
            <section className="backupPanel">
              <div className="backupCloudHeader">
                <Space>
                  <CloudUploadOutlined />
                  <span>云端备份</span>
                </Space>
              </div>
              <Form.Item label="云端类型" name={["cloud", "kind"]}>
                <Select
                  options={[
                    { label: "WebDAV", value: "webdav" },
                    { label: "S3 存储桶", value: "s3" },
                  ]}
                />
              </Form.Item>
              {cloudKind === "s3" ? (
                <div className="backupFormGrid">
                  <Form.Item label="Endpoint" name={["cloud", "s3", "endpoint"]} rules={[{ required: true, message: "请输入 Endpoint" }]}>
                    <Input placeholder="https://s3.amazonaws.com" />
                  </Form.Item>
                  <Form.Item label="Region" name={["cloud", "s3", "region"]} rules={[{ required: true, message: "请输入 Region" }]}>
                    <Input placeholder="us-east-1" />
                  </Form.Item>
                  <Form.Item label="Bucket" name={["cloud", "s3", "bucket"]} rules={[{ required: true, message: "请输入 Bucket" }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="Prefix" name={["cloud", "s3", "prefix"]}>
                    <Input placeholder="helm" />
                  </Form.Item>
                  <Form.Item label="Access Key ID" name={["cloud", "s3", "accessKeyId"]} rules={[{ required: true, message: "请输入 Access Key" }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="Secret Access Key" name={["cloud", "s3", "secretAccessKey"]} rules={[{ required: true, message: "请输入 Secret Key" }]}>
                    <Input.Password />
                  </Form.Item>
                  <Form.Item label="Path Style" name={["cloud", "s3", "pathStyle"]} valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </div>
              ) : (
                <div className="backupFormGrid">
                  <Form.Item label="WebDAV 地址" name={["cloud", "webdav", "endpoint"]} rules={[{ required: true, message: "请输入 WebDAV 地址" }]}>
                    <Input placeholder="https://example.com/dav" />
                  </Form.Item>
                  <Form.Item label="远端目录" name={["cloud", "webdav", "remotePath"]}>
                    <Input placeholder="helm" />
                  </Form.Item>
                  <Form.Item label="用户名" name={["cloud", "webdav", "username"]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="密码" name={["cloud", "webdav", "password"]}>
                    <Input.Password />
                  </Form.Item>
                </div>
              )}
            </section>
          )}

          <section className="backupPanel">
            <div className="backupSectionHeader">
              <span>已备份</span>
              <Tag>{records.length}</Tag>
            </div>
            <Table
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={records}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              scroll={{ x: 720, y: 180 }}
            />
          </section>
        </div>
      </Form>
    </Modal>
  );
}

function targetLabel(kind: BackupRecord["targetKind"]) {
  if (kind === "local") return "本地";
  if (kind === "webdav") return "WebDAV";
  if (kind === "s3") return "S3";
  return "云端";
}

function formatBytes(bytes: number) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatBeijingTimestamp() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}
