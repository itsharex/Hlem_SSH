import { Form, Input, Modal, Radio, Tree } from "antd";
import { FolderAddOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import type { RemoteFileEntry } from "../../types";

export type FileDialogState =
  | { kind: "create"; entryType: "file" | "directory"; name: string }
  | { kind: "rename"; entry: RemoteFileEntry; value: string }
  | { kind: "copy"; entry: RemoteFileEntry; value: string }
  | { kind: "move"; entry: RemoteFileEntry; value: string };

export interface FileDialogsProps {
  dialog: FileDialogState | null;
  treeData: DataNode[];
  directoryExpandedKeys: string[];
  onDialogChange: (dialog: FileDialogState | null) => void;
  onSubmit: () => void;
  onLoadDirectory: (path: string) => void;
  onExpandChange: (keys: string[]) => void;
  onTreeSelect: (path: string) => void;
}

export function FileDialogs({
  dialog,
  treeData,
  directoryExpandedKeys,
  onDialogChange,
  onSubmit,
  onLoadDirectory,
  onExpandChange,
  onTreeSelect,
}: FileDialogsProps) {
  return (
    <Modal
      open={Boolean(dialog)}
      title={dialogTitle(dialog)}
      okText="执行"
      cancelText="取消"
      onCancel={() => onDialogChange(null)}
      onOk={onSubmit}
      destroyOnHidden
      className="fileOperationModal"
    >
      {dialog?.kind === "create" && (
        <Form layout="vertical">
          <Form.Item label="类型">
            <Radio.Group
              value={dialog.entryType}
              onChange={(event) => onDialogChange({ ...dialog, entryType: event.target.value })}
              options={[
                { label: "文件", value: "file" },
                { label: "目录", value: "directory" },
              ]}
            />
          </Form.Item>
          <Form.Item label="名称">
            <Input
              autoFocus
              placeholder={dialog.entryType === "file" ? "new-file.txt" : "new-folder"}
              value={dialog.name}
              onChange={(event) => onDialogChange({ ...dialog, name: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
        </Form>
      )}
      {dialog?.kind === "rename" && (
        <Form layout="vertical">
          <Form.Item label="新名称">
            <Input
              autoFocus
              value={dialog.value}
              onChange={(event) => onDialogChange({ ...dialog, value: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
        </Form>
      )}
      {(dialog?.kind === "copy" || dialog?.kind === "move") && (
        <Form layout="vertical">
          <div className="fileOperationTree">
            <Tree
              showIcon
              blockNode
              virtual
              expandAction={false}
              selectedKeys={[dialog.value]}
              expandedKeys={directoryExpandedKeys}
              treeData={treeData}
              switcherIcon={({ isLeaf }) => (isLeaf ? null : <span className="pathTreeChevron" />)}
              loadData={(node) => {
                onLoadDirectory(String(node.key));
                return Promise.resolve();
              }}
              onExpand={(keys, info) => {
                onExpandChange(keys.map(String));
                if (info.expanded) onLoadDirectory(String(info.node.key));
              }}
              onClick={(event, node) => {
                if (isTreeSwitcherClick(event.target)) return;
                onTreeSelect(String(node.key));
              }}
            />
          </div>
          <Form.Item label={dialog.kind === "copy" ? "复制到路径" : "移动到路径"}>
            <Input
              autoFocus
              prefix={<FolderAddOutlined />}
              placeholder="/目标目录/或/完整目标路径"
              value={dialog.value}
              onChange={(event) => onDialogChange({ ...dialog, value: event.target.value })}
              onPressEnter={onSubmit}
            />
          </Form.Item>
          <div className="fileOperationHint">可以从目录树选择，也可以输入目录或完整目标路径。</div>
        </Form>
      )}
    </Modal>
  );
}

function dialogTitle(dialog: FileDialogState | null) {
  if (!dialog) return "";
  if (dialog.kind === "create") return "新建文件或目录";
  if (dialog.kind === "rename") return "重命名";
  if (dialog.kind === "copy") return "复制到";
  return "移动到";
}

function isTreeSwitcherClick(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(".ant-tree-switcher"));
}

export function operationLabel(operation: { kind: string; entryType?: string }) {
  if (operation.kind === "create") return operation.entryType === "directory" ? "新建目录" : "新建文件";
  if (operation.kind === "rename") return "重命名";
  if (operation.kind === "copy") return "复制";
  if (operation.kind === "move") return "移动";
  return "删除";
}
