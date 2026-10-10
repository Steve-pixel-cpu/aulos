/* ============================================================
 * 完成通知: 提示音(WebAudio 合成) + 系统桌面通知, localStorage 持久化
 * 值: "1" 开 / "0" 关; 未设置时默认开
 * ============================================================ */
const NOTIFY_SOUND_KEY = "xc-notify-sound";
const NOTIFY_DESKTOP_KEY = "xc-notify-desktop";
function notifySoundPref() { return localStorage.getItem(NOTIFY_SOUND_KEY) !== "0"; }
function notifyDesktopPref() { return localStorage.getItem(NOTIFY_DESKTOP_KEY) !== "0"; }

/* 双音阶提示音: 正弦波 + 指数衰减, 约 0.6s。AudioContext 必须在用户手势
 * 之后才能出声——首次交互时 resume 预热, 之后轮次结束可直接播。 */
let _chimeCtx = null;
function chimeCtx() {
  if (!_chimeCtx) _chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_chimeCtx.state === "suspended") _chimeCtx.resume();
  return _chimeCtx;
}
document.addEventListener("pointerdown", () => { try { chimeCtx(); } catch {} }, { once: true });

function playChime() {
  try {
    const ctx = chimeCtx();
    const t0 = ctx.currentTime;
    // 两声上行（E5→A5）: 干完活上扬收尾, 比"叮"单音更醒目又不刺耳
    [[659.25, 0], [880, 0.18]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.55);
    });
  } catch (e) { console.warn("提示音播放失败", e); }
}

/* 桌面通知权限: 只在用户手势上下文（开关/测试按钮）里申请, 静默页面
 * 自动弹权限框会被浏览器拒掉。返回当前权限态。
 * 桌面壳形态恒为 "granted"——原生 toast 走壳内命令, 无 Web 权限一说。 */
function ensureNotifyPermission() {
  if (DESKTOP) return "granted";
  if (!("Notification" in window)) return "denied";
  if (Notification.permission === "default") Notification.requestPermission();
  return Notification.permission;
}

/* 桌面壳里的原生通知: WebView2 未实现 Web Notification API,
 * new Notification() 在壳里静默失败——转发给壳内 notify_desktop 命令
 * 发系统 toast。老壳没有该命令(或桥不在)时 invoke 被拒, 静默降级。 */
function nativeNotify(title, body) {
  try {
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (inv) inv("notify_desktop", { title, body }).catch(() => {});
  } catch (e) { /* 桥不在(浏览器/老壳): 静默 */ }
}

/* 轮次收尾统一通知入口（turn_done / error, 前台后台会话都经过这里）:
 * 桌宠派活的会话在 handleServerMessage 挂钩处已先跳过（结果回传悬浮窗,
 * 主窗不提醒——摸鱼场景）, 不会走到这里。
 * 手动打断不提醒; 声音开关开了就播; 桌面弹窗只在窗口不可见或该会话
 * 在后台时弹——人正盯着这个会话时不打扰。
 * 桌面壳走原生 toast(无点击回调, 点通知不聚焦——只做告知); 浏览器形态
 * 维持 Web Notification(带点击聚焦+切会话)。 */
function notifyTurnEnd(msg, sid) {
  if (msg.type === "turn_done" && msg.interrupted) return;
  if (notifySoundPref()) playChime();
  if (!notifyDesktopPref()) return;
  const visibleHere = sid === state.sessionId
    && document.visibilityState === "visible"
    && !document.hidden;
  if (visibleHere) return;
  const s = state.sessions.find(x => x.id === sid);
  const title = (s?.name || s?.title || "会话") + " · 任务完成";
  const body = msg.type === "error" ? ("出错了: " + (msg.message || "未知错误")) : "本轮已结束, 回来看看结果";
  if (DESKTOP) {
    nativeNotify(title, body);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: "aulos-turn-" + sid, silent: true });
    n.onclick = () => {
      window.focus();
      if (sid !== state.sessionId) selectSession(sid);
      n.close();
    };
  } catch (e) { console.warn("桌面通知失败", e); }
}

