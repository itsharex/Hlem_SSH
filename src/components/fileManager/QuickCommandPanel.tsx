import { Button, Space, Tooltip } from "antd";
import { CodeOutlined, DeleteOutlined, DownOutlined, EditOutlined, PlusOutlined, UpOutlined } from "@ant-design/icons";
import { useState, type ReactNode } from "react";
import { formatBeijingModifiedTime } from "../../lib/fileClassify";
import type { QuickCommand } from "../../types";

type QuickCommandPreviewState = {
  command: QuickCommand;
  left: number;
  top: number;
  width: number;
};

export interface QuickCommandTopAreaProps {
  children: ReactNode;
  commandItems: QuickCommand[];
  onSendCommand: (command: QuickCommand) => void | Promise<void>;
  onEditCommand: (command?: QuickCommand) => void;
  onDeleteCommand: (command: QuickCommand) => void;
}

export function QuickCommandTopArea({ children, commandItems, onSendCommand, onEditCommand, onDeleteCommand }: QuickCommandTopAreaProps) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<QuickCommandPreviewState | null>(null);

  function hidePreview() {
    setPreview(null);
  }

  function toggleOpen() {
    hidePreview();
    setOpen((current) => !current);
  }

  function showPreview(command: QuickCommand, node: HTMLElement) {
    const rect = node.getBoundingClientRect();
    const viewportWidth = Math.max(320, window.innerWidth);
    const width = Math.min(viewportWidth - 32, command.command.length > 72 ? 650 : 420);
    const left = Math.min(Math.max(16, rect.left), Math.max(16, viewportWidth - width - 16));
    const estimatedHeight = command.createdAt ? 132 : 96;
    const belowTop = rect.bottom + 8;
    const top = belowTop + estimatedHeight > window.innerHeight ? Math.max(16, rect.top - estimatedHeight - 8) : belowTop;
    setPreview({ command, left, top, width });
  }

  function runCommand(command: QuickCommand) {
    hidePreview();
    void onSendCommand(command);
  }

  return (
    <div className="fileTopArea">
      <div className="fileToolbar">
        <Space className="fileToolbarActions" size={4}>
          <Tooltip title="常用命令">
            <Button
              aria-label="常用命令"
              className={`fileCommandDropdownButton${open ? " fileCommandDropdownButton-active" : ""}`}
              icon={<CodeOutlined />}
              size="small"
              onClick={toggleOpen}
            >
              {open ? <UpOutlined className="fileToolbarDropdownArrow" /> : <DownOutlined className="fileToolbarDropdownArrow" />}
            </Button>
          </Tooltip>
          {children}
        </Space>
      </div>

      <div className={`quickCommandDrawer${open ? " quickCommandDrawer-open" : ""}`}>
        <div className="quickCommandDrawerHeader">
          <span className="quickCommandDrawerTitle">
            <CodeOutlined />
            常用命令
            <small>({commandItems.length})</small>
          </span>
          <button type="button" className="quickCommandAdd" onClick={() => onEditCommand()}>
            <PlusOutlined />
            <span>添加</span>
          </button>
        </div>
        <div className="quickCommandScrollList" onMouseLeave={hidePreview} onScroll={hidePreview}>
          {commandItems.length === 0 ? (
            <div className="quickCommandEmpty">暂无命令，点击上方添加</div>
          ) : (
            commandItems.map((item) => (
              <span
                key={item.id}
                className="quickCommandTag"
                role="button"
                tabIndex={0}
                onClick={() => runCommand(item)}
                onFocus={(event) => showPreview(item, event.currentTarget)}
                onMouseEnter={(event) => showPreview(item, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runCommand(item);
                }}
              >
                {item.name}
                <span className="quickCommandTagActions">
                  <Button
                    aria-label={`编辑 ${item.name}`}
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    onClick={(event) => {
                      event.stopPropagation();
                      hidePreview();
                      onEditCommand(item);
                    }}
                  />
                  <Button
                    aria-label={`删除 ${item.name}`}
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(event) => {
                      event.stopPropagation();
                      hidePreview();
                      onDeleteCommand(item);
                    }}
                  />
                </span>
              </span>
            ))
          )}
        </div>
      </div>

      {open && preview ? (
        <div
          className="quickCommandHoverPreview"
          style={{ left: preview.left, top: preview.top, width: preview.width }}
          aria-hidden="true"
        >
          {quickCommandDetailTooltip(preview.command)}
        </div>
      ) : null}
    </div>
  );
}

function quickCommandDetailTooltip(command: QuickCommand) {
  return (
    <div className="detailHoverPanel">
      <div className="detailHoverTitle">{command.name}</div>
      <div className="detailHoverCommand">{command.command}</div>
      {command.createdAt && (
        <div className="detailHoverGrid">
          <span>创建时间</span>
          <strong>{formatBeijingModifiedTime(command.createdAt)}</strong>
        </div>
      )}
    </div>
  );
}
