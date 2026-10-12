# --- Web 后端启动 shim: 真实现在 aulos/server.py（Tauri/Electron 壳与打包脚本按本路径拉起, 勿删）---
import sys

if __name__ == "__main__":
    sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
    from aulos.server import main

    sys.exit(main())
