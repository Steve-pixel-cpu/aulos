# AGENTS.md — AI agent 开发指引（aulos）

## 测试策略（重要：直接影响你的迭代速度）

全量 1316 用例已可并行，但开发循环请分层跑，别每改一行就全量：

```bash
# 快循环（默认，日常开发验证用这个）: 跳过 slow 集成测试, ~30s
uv run pytest -m "not slow" -x -q

# 只重跑上次失败（修 bug 循环）
uv run pytest --lf -q

# 提交前全量回归（xdist 并行, ~30s）
uv run pytest -n auto -q

# 单文件/单用例
uv run pytest tests/test_xxx.py -q
uv run pytest "tests/test_xxx.py::test_name" -q
```

- `slow` marker = 真实子进程/浏览器/shell 集成测试（MCP stdio、Playwright Chromium、evals spawn、git、windows shell），文件：`test_mcp_client.py`、`test_browser_tools.py`、`test_evals_harness.py`、`test_skills_api.py`、`test_windows_shell.py`。慢测试必须打此标记，不许删测试。
- 全局 `timeout = 120s`（pytest-timeout, thread 法）兜底挂起；新测试里避免真实 `time.sleep` 长等待，轮询用事件/短 deadline。
- 故意不把 `-n auto` 写进 addopts：保持无 xdist 环境的默认行为；需要串行调试时去掉即可。
- 前端：`npm run test:web`（jsdom 回归）；浏览器 E2E：`uv run python tests/web/e2e.py`（手动跑，不在 pytest 内）。

## 已知测试陷阱（写测试前必读）

- 测试替身 runtime 挂到 `server._sessions` 后必须实现完整协议（含 `set_utility_client`），否则 `_rebuild_utility_client` 遍历时会炸到后续无关测试（顺序依赖雷，2026-10-20 修过一次）。
- 退避/重试类测试统一接 `sleeps` fixture（monkeypatch `time.sleep`），别让 2/4/8s 指数退避真睡。
- `aulos.server` 模块级副作用多（event bridge、`_sessions`、`_turn_slots`），跨用例全局状态改动要还原。
