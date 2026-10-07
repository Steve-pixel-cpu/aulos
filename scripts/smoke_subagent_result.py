# -*- coding: utf-8 -*-
"""真实 API 冒烟: 派 general 子代理跑 5+ 步任务, 验证修复后 result 非空。

任务故意偏大(写 3 个脚本 + 逐个运行 + 总结), 逼模型多轮迭代——正是
「无消息内容!」事故的触发形态(长任务尾段 thinking-only)。

运行: uv run python scripts/smoke_subagent_result.py
前置: .env 里有可用 API_KEY(走 build_subagent_runtime 的正常装配)。
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv()

import multi_agent
from multi_agent import AgentOrchestrator

# CLI 形态没有会话级 api_config, 全局 provider 缺省返回 3 元组(CLI 旧契约),
# 而 build_subagent_runtime 按 4 元组解包(Web 契约)。这里显式装 4 元组。
# 端点选 ZAI-ANTHROPIC(coding paas v4): 实测有余额; glm-4.7 支持 tool use。
def _smoke_api_config():
    import json as _json
    cfg = _json.load(open(os.path.expanduser("~/.x-code/settings.json"),
                          encoding="utf-8"))
    p = next(x for x in cfg["providers"] if x.get("name") == "ZAI-ANTHROPIC")
    return (p["api_key"], p["base_url"].strip('"'),
            os.getenv("CLAUDE_MODEL") or "glm-4.7", "openai")

multi_agent.set_api_config_provider(_smoke_api_config)


def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="xc-smoke-"))
    store = workdir / "agents"
    store.mkdir()
    prompt = (
        "依次完成(每步都要真的执行): "
        "1) 在当前目录写 calc/add.py: 内容为 print(1+1); "
        "2) 写 calc/mul.py: 内容为 print(2*3); "
        "3) 写 calc/fmt.py: 内容为 print(f'{40+2} done'); "
        "4) 逐个运行这三个脚本并记下输出; "
        "5) 最后写 result.txt, 内容为三个输出用逗号连接。"
        "全部完成后用一段话总结每个脚本的路径与运行输出。"
    )
    orch = AgentOrchestrator(store, workdir=str(workdir))
    manifest = orch.spawn_agent(
        description="三个计算脚本+运行+总结", prompt=prompt,
        subagent_type="general")
    aid = manifest.agent_id
    print(f"[smoke] agent={aid} workdir={workdir}")
    deadline = time.time() + 600
    last = ""
    while time.time() < deadline:
        try:
            m = orch.get_status(aid)
        except FileNotFoundError:
            time.sleep(1)
            continue
        if m.status != last:
            print(f"[smoke] status -> {m.status}")
            last = m.status
        if m.status in ("completed", "failed"):
            print("=== manifest ===")
            print(json.dumps(json.loads((store / f"{aid}.json").read_text(encoding="utf-8")),
                             ensure_ascii=False, indent=2)[:2000])
            ok = (m.status == "completed" and m.result
                  and m.result.strip() not in ("", "(无文本输出)"))
            print("[smoke] RESULT:", "PASS" if ok else "FAIL")
            return 0 if ok else 1
        time.sleep(2)
    print("[smoke] timeout 600s")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
