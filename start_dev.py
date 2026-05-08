from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> int:
    npm = "npm.cmd" if os.name == "nt" else "npm"
    command = [npm, "run", "tauri:dev", *sys.argv[1:]]

    try:
        return subprocess.call(command, cwd=ROOT)
    except FileNotFoundError:
        print("未找到 npm，请先安装 Node.js 并确认 npm 已加入 PATH。", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
