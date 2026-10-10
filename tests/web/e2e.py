# tests/web/e2e.py — Playwright 主干链路 ×3 (同步 API, 直连已运行的 server)
#
# 跑法: .venv/Scripts/python.exe tests/web/e2e.py
# 前置: server.py 已起 (8000), 令牌读 ~/.aulos/token
"""Aulos 前端端到端主干: 发消息回执 / 插队广播 / 重连快照。"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8000"
TOKEN = (Path.home() / ".aulos" / "token").read_text(encoding="utf-8").strip()
URL = f"{BASE}/?token={TOKEN}&desktop=1"


def open_app(page):
    page.goto(URL, wait_until="domcontentloaded", timeout=15000)
    expect(page.locator("#session-list")).to_be_visible(timeout=10000)


def case1_send_message(page):
    """发消息 → 服务端必有一条回执 (busy_sync/turn_started/error 均算协议存活)。"""
    open_app(page)
    got = page.evaluate("""
      async () => {
        const got = [];
        await new Promise((resolve) => {
          const orig = handleServerMessage;
          window.handleServerMessage = (msg) => {
            got.push(msg.type); orig(msg);
            if (got.length >= 2) { window.handleServerMessage = orig; resolve(); }
          };
          sendWs({ type: "user", text: "e2e 主干1: 探活", qid: genQid() },
                 state.sessionId);
          setTimeout(() => { window.handleServerMessage = orig; resolve(); }, 8000);
        });
        return got;
      }
""")
    assert got, "发消息后未收到任何服务端消息"
    print(f"  case1 服务端回执: {got}")
    return page


def case2_queue_promote(page):
    """busy 时 queue_promote → 必广播 turn_interrupting (P0 修复的回归锚点)。"""
    open_app(page)
    saw = page.evaluate("""
      async () => {
        const got = [];
        await new Promise((resolve) => {
          const orig = handleServerMessage;
          window.handleServerMessage = (msg) => {
            got.push(msg.type); orig(msg);
            if (msg.type === "turn_interrupting" || got.length >= 6) {
              window.handleServerMessage = orig; resolve(); }
          };
          sendWs({ type: "user", text: "e2e 主干2: 排队", qid: genQid() },
                 state.sessionId);
          setTimeout(() => {
            const qid = (state.pending && state.pending[0] && state.pending[0].qid) || "";
            sendWs({ type: "queue_promote", qid }, state.sessionId);
          }, 400);
          setTimeout(() => { window.handleServerMessage = orig; resolve(); }, 8000);
        });
        return got;
      }
""")
    print(f"  case2 消息序列: {saw}")
    if "turn_started" in saw or "user_accepted" in saw:
        assert "turn_interrupting" in saw, f"busy 插队未广播: {saw}"
    return page


def case3_reconnect_snapshot(page):
    """选中一个已有会话 (selectSession 会 connectWs) → 断开 → 退避重连。"""
    open_app(page)
    ok = page.evaluate("""
      async () => {
        // 找一个非当前的已有会话, 点它 → connectWs 懒建
        // (ws 挂在 state.runs[id], 不在 sessions 条目上)
        const other = state.sessions.find(s => s.id !== state.sessionId
                                              && s.id !== "__draft__");
        if (!other) return { fail: "no other session" };
        await selectSession(other.id);
        let run = state.runs[other.id];
        // selectSession → connectWs 是异步建连, 轮询等 open
        for (let i = 0; i < 20 && !(run.ws && run.ws.readyState === 1); i++)
          await new Promise(r => setTimeout(r, 300));
        if (!run.ws || run.ws.readyState !== 1) return { fail: "ws not open" };
        run.ws.close();
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 300));
          if (run.ws && run.ws.readyState === 1) return { ok: true };
        }
        return { fail: "no reconnect", attempts: run.reconnectAttempts };
      }
""")
    assert ok.get("ok"), f"重连失败: {ok}"
    print("  case3 重连 OK")


def main():
    with sync_playwright() as pw:
        # 本机 ms-playwright 缓存为空, 直接驱动系统 Edge (WebView2 同内核)
        browser = pw.chromium.launch(
            headless=True,
            channel="msedge",
        )
        page = browser.new_page()
        case1_send_message(page)
        case2_queue_promote(page)
        case3_reconnect_snapshot(page)
        browser.close()
    print("e2e 3/3 PASS")


if __name__ == "__main__":
    sys.exit(main())
