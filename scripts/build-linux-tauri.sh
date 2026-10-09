#!/usr/bin/env bash
# aulos Linux Tauri 打包: PyInstaller 冻结后端 + Tauri AppImage + 更新签名
#
# 用法: ./scripts/build-linux-tauri.sh [x.y.z]
#   传版本号会先同步 package.json / tauri.conf.json / Cargo.toml /
#   pyproject.toml (scripts/set-version.js + npm version); 不传维持当前版本。
# 产物 (dist/):
#   aulos_<ver>_amd64.deb          Debian 包 (+ .deb.sig 更新签名)
#   安装即用系统 WebKitGTK/GStreamer, apt 按 Depends 自动拉齐运行时依赖
#   (音频开箱即用, 无 AppImage 的库遮蔽问题)。
# 依赖: uv, Node.js, Rust 工具链, dpkg-deb —— 必须在 Debian 系 Linux 上运行
#       (PyInstaller 无法跨平台构建)。
# 与 build-mac-tauri.sh 同款对齐策略: 冻结后端沿用 "aulos-server.exe"
# 文件名 (Linux 上只是名字), tauri.conf.json / main.rs 零改动。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  echo "[0/4] Setting version $VERSION (package.json, tauri.conf.json, Cargo.toml, pyproject.toml)..."
  npm version "$VERSION" --no-git-tag-version --allow-same-version
  node scripts/set-version.js "$VERSION"
fi

echo "[1/4] Syncing project venv and installing PyInstaller..."
uv sync
uv pip install --python .venv/bin/python pyinstaller

echo "[2/4] Freezing Python backend (static/ bundled, playwright driver collected)..."
mkdir -p build/server
.venv/bin/python -m PyInstaller --noconfirm --clean --onefile \
  --name aulos-server \
  --distpath build/server --workpath build/pyinstaller --specpath build/pyinstaller \
  --add-data "$PWD/static:static" \
  --add-data "$PWD/pyproject.toml:." \
  --collect-all playwright \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.asyncio \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.protocols.websockets.websockets_impl \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  server.py

echo "[3/4] Staging backend + pets into src-tauri (Tauri resources)..."
mkdir -p src-tauri/server
cp build/server/aulos-server src-tauri/server/aulos-server.exe   # 文件名与 Windows 对齐
rm -rf src-tauri/pets
cp -R pets src-tauri/pets

echo "[4/4] Building Tauri deb (updater artifact signed)..."
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "[sign] Using TAURI_SIGNING_PRIVATE_KEY from environment"
else
  echo "[warn] No signing key in environment - build succeeds but produces no .sig"
fi
npm install --no-save @tauri-apps/cli@2
npx tauri build --bundles deb

echo "Staging artifacts into dist/..."
mkdir -p dist
cp src-tauri/target/release/bundle/deb/*.deb dist/
cp src-tauri/target/release/bundle/deb/*.deb.sig dist/ 2>/dev/null || true
ls -1 dist/*.deb* 2>/dev/null || true
