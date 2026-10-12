# 桌面端发版与平台排障备忘

> 自 README「发版」章节移出的开发者备忘（Linux/Wayland/VMware 排障细节）。

三平台产物由 GitHub Actions 在打 tag 时自动构建并发布（`.github/workflows/release.yml`）。

- `latest.json` 含三平台更新条目, 已装用户通过自动更新收到新版本
- 手动触发（Actions 页 Run workflow）：只构建并传 artifact, 不发 Release
- 签名密钥走仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`）；
  缺失时构建成功但无 `.sig`, 不能作为自动更新目标
- macOS 未做 Apple 公证：首次打开需右键 → 打开, 或 `xattr -cr /Applications/aulos.app`
- Linux 运行时依赖（缺 GStreamer 插件时窗口/工具正常, 但网页音频无声）:

  ```bash
  sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
  ```

  AppImage 下若仍无声, 先在系统终端确认 `gst-inspect-1.0 --version` 正常。
  AppImage 打包形态暂不含与捆绑库匹配的 GStreamer 插件, 电台在该形态下
  不可用——应用会在播放前探测管线, 不可用时自动停用 (只弹提示, 不会卡死)。
- Wayland 会话 (Ubuntu 22.04/24.04 默认): Wayland 协议不允许客户端置顶/编程
  挪窗, 桌宠会被其他窗口遮挡且拖不动。应用检测到 Wayland + XWayland 时自动设
  `GDK_BACKEND=x11` 走 XWayland 恢复该行为 (决策记录在 `~/.aulos/boot.log`)。
  想回原生 Wayland: 启动前 `export AULOS_GDK_BACKEND=wayland`, 代价是桌宠
  可能被遮挡、拖不动。
- VMware 等无 3D 加速环境: 应用自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  回退 WebKitGTK 的非加速渲染路径——否则窗口会停留在过期帧/空白 (页面
  实际正常)。已显式设置该变量的环境不受影响。

## Electron 壳弃用说明（2026-10）

`electron/` 目录保留仅供参照，不再随版本发布。桌面端能力（原生通知、
单实例、自动更新、多窗口/桌宠）已全部由 Tauri 壳承担且包体更小
（WebView2 系统共享运行时）。`npm start` 仍可跑通，但新功能只做
Tauri 侧，请勿在 electron/ 继续投入。
