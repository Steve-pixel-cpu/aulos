# 代码组织与拆分路线

> 自 README 移出的开发者备忘。两个历史巨石文件正在按域渐进拆分
> （机械搬移 + 门面保兼容，不做大爆炸重写）。

## 后端 server.py（门面）

- 装配单例与事件路由已上移 `aulos/web/server_common.py`。
- 电台/B站/桌宠/遥测四个低耦合 REST 域拆为 `aulos/web/server_music.py` /
  `aulos/web/server_bilibili.py` / `aulos/web/server_pets.py` / `aulos/web/server_stats.py`
  （import 即挂路由）；设置/供应商/Skills/记忆/MCP 管理拆为
  `aulos/web/server_settings.py`，权限策略（allowlist/denylist/敏感路径/附加目录/
  批复）拆为 `aulos/web/server_policy.py`。
- `import server` 的全部既有调用点与测试零改动——server.py re-export
  共享名；共享可变态一律 `server.X` call-time 解析（monkeypatch 语义不变）。
  server_pets→main 反向依赖已斩断（经 server_common 转出）。
- **2026-10 包化**：7 个 `server_*.py` 域模块移入 `web/` 包，电台库
  `music.py` / `bilibili.py` 移入 `radio/` 包（照 `memory/` 包先例）。
  随后**全量包化**：根目录 21 个内核/入口模块连同 `web/` `radio/`
  `memory/` 一并收入 `aulos/` 包；仓库根只留 `main.py` / `server.py`
  两个启动 shim（evals `ROOT/"main.py"`、Tauri/Electron 壳与 PyInstaller
  都按根路径拉起，勿删）。测试中字符串形式的 patch 目标
  （`monkeypatch.setattr("config.…")`）与 `server.__file__` 上溯路径
  同步更新。后续候选：WS 路由、turn 循环各自成模块。

## 前端 static/（原生 JS，无模块系统）

- 已按「低耦合域先外迁」模式完成拆分——6946 → **2205 行**（-68%），
  9 个域文件按依赖序 defer 加载（共享全局作用域）：`ui-dialogs`(弹窗/纯工具)
  → `tooltip` → `notify` → app(核心: 状态/WS连接/发送/会话切换/启动) →
  `settings-extras`(设置三节) → `desktop`(标题栏/右键/更新/拖宽) →
  `bubbles`(气泡工厂) → `msg-extras`(滚动/minimap/斜杠/划词) →
  `ws-handlers`(WS 分派+全部处理器) → `sidebar`(会话列表) →
  `settings-page`(设置弹窗九节) → `music`/`pet`。
- 加载序契约: 前段只定义函数, 后段顶层绑定可依赖前段; 被核心调用的
  域（bubbles/sidebar/ws-handlers）运行时解引用, 顺序天然安全。
- 回归网: `npm run test:web`（jsdom 19 断言, eval 真实源码+真实
  index.html 骨架）+ `tests/web/e2e.py`（Playwright 主干×3: 流式
  回执/插队广播/断线重连）。app.js 剩余部分即「网状耦合核心」,
  再拆需事件总线重构——待测试更厚时再评估。ES 模块化暂不做:
  拆分后单文件已均 <2300 行, 收益不再显著。
