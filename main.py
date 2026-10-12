# --- CLI 启动 shim: 真实现在 aulos/main.py（evals 与文档硬编码本路径, 勿删）---
import sys

from aulos.main import main

if __name__ == "__main__":
    sys.exit(main())
