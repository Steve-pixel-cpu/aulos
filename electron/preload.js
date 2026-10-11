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
