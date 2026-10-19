// 预加载桥: 给页面提供桌面端能力（UA 不可靠, 普通浏览器没有这些值）
// - aulosDesktop: 标记桌面端（右键走应用内自绘菜单）
// - aulosPickFolder: 弹系统原生"选择文件夹"对话框, 返回绝对路径或 null
// - aulosReadClipboard: 读系统剪贴板文本（右键"粘贴"用——渲染层 execCommand('paste')
//   受浏览器安全模型限制不可用, 必须经主进程 clipboard 模块读取）
// - aulosAppVersion: 应用版本号（electron-builder 从 package.json 打进包里）, 标题栏徽标用
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("aulosDesktop", true);
contextBridge.exposeInMainWorld("aulosPickFolder", async () => {
  return await ipcRenderer.invoke("pick-folder");
});
contextBridge.exposeInMainWorld("aulosReadClipboard", async () => {
  return await ipcRenderer.invoke("read-clipboard-text");
});
// 剪贴板图片桥: 有图返回 PNG dataURL, 无图返回 null（不 reject,
// 前端据此提示"剪贴板是空的"）——系统截图右键粘贴转附件用
contextBridge.exposeInMainWorld("aulosReadClipboardImage", async () => {
  return await ipcRenderer.invoke("read-clipboard-image");
});
contextBridge.exposeInMainWorld("aulosAppVersion", async () => {
  return await ipcRenderer.invoke("get-app-version");
});
// 系统云母开关: 真值 = 壳确认 DWM 云母已生效(确认制, 前端凭真值才挂
// data-mica)。仅 Win11 22H2+ 的 Electron 壳返回真值。
contextBridge.exposeInMainWorld("aulosSetMica", async (on) => {
  return await ipcRenderer.invoke("set-mica", on);
});

/* ============================================================
 * __TAURI_INTERNALS__ 垫片: 共享前端（static/desktop.js · loading.html ·
 * notify.js · settings-page.js）的窗口控制/通知/云母直接调 Tauri 命令,
 * Electron 壳在此把同名命令映射到自己的 IPC —— 共享文件零改动, Tauri 端
 * 用真实现, 互不影响。仅垫前端实际调用的命令。
 * ============================================================ */
contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "minimize_main":        return ipcRenderer.invoke("win-ctl", "minimize");
      case "toggle_maximize_main": return ipcRenderer.invoke("win-ctl", "maximize");
      case "close_main":           return ipcRenderer.invoke("win-ctl", "close");
      // 拖拽走下方注入的 CSS app-region（Electron 无 Tauri 的拖拽命令）,
      // 返回成功让 desktop.js/loading.html 的 mousedown 处理静默
      case "start_drag_main":      return Promise.resolve();
      // notify_desktop: 转发系统通知（title/body 与 Tauri 侧参数同名）
      case "notify_desktop":       return ipcRenderer.invoke("notify-desktop",
                                     { title: args?.title, body: args?.body });
      // set_mica: 复用已有桥, 参数形状 { on, dark } → set-mica(on)
      case "set_mica":             return ipcRenderer.invoke("set-mica", !!args?.on);
      default:                     return Promise.reject(new Error("unknown cmd: " + cmd));
    }
  },
});

/* ---------- Electron 壳专属: 去系统标题栏后的拖拽/按钮区 ---------- */
/* frame:false 后窗口拖拽没有原生标题栏承担, 经 CSS app-region 实现:
 * 注入样式 + 给 <html> 挂 electron-shell 标记（样式只作用于 Electron 壳,
 * Tauri 壳无此标记, 仍走自己的 start_drag_main 逻辑, 行为不变） */
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron-shell");
  const css = document.createElement("style");
  css.textContent = [
    "html.electron-shell #titlebar { -webkit-app-region: drag; }",
    "html.electron-shell #titlebar .tb-btn,",
    "html.electron-shell #titlebar .tb-ver,",
    "html.electron-shell #titlebar .tb-update-dl",
    "  { -webkit-app-region: no-drag; }",
  ].join("\n");
  document.head.appendChild(css);
});
