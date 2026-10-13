"""探针: 直连智谱 Anthropic 兼容端点, 抓原始流事件序列。

目的: 验证「无消息内容!」的疑似根因——thinking 块有 delta 但
content_block_stop 缺失(或整条响应零 text/tool 块), 导致
build_assistant_message 收不到 ThinkingEvent, 兜底失效。
"""
import json
import sys
import anthropic

KEY = json.load(open(r"C:/Users/18331/.aulos/providers.json", encoding="utf-8"))
prov = KEY["providers"][0]

client = anthropic.Anthropic(
    api_key=prov["api_key"], base_url=prov["base_url"], timeout=180, max_retries=0)

PROMPTS = [
    "9.11 和 9.8 哪个大?只回答结论。",
    "一个三角形三边长 13,14,15,求面积。给出过程和答案。",
    "用一句话解释什么是事件循环。",
]

run = int(sys.argv[1]) if len(sys.argv) > 1 else 0
prompt = PROMPTS[run % len(PROMPTS)]
print(f"=== run {run} prompt: {prompt}")

seq = []
thinking_json = []
with client.messages.stream(
    model="glm-5.3-flash",
    max_tokens=4096,
    thinking={"type": "enabled", "budget_tokens": 2048},
    messages=[{"role": "user", "content": prompt}],
) as stream:
    for ev in stream:
        t = ev.type
        if t == "content_block_start":
            seq.append(f"start:{ev.content_block.type}")
        elif t == "content_block_delta":
            d = ev.delta.type
            if not seq or not seq[-1].startswith("delta:"):
                seq.append(f"delta:{d}")
            else:
                seq[-1] = f"delta:{d}(x{eval(seq[-1].split('x')[1].strip('()'))+1})" \
                    if "(x" in seq[-1] else f"delta:{d}(x2)"
        elif t == "content_block_stop":
            seq.append(f"stop:{seq[-1] if seq else '?'}")
        elif t == "message_delta":
            seq.append(f"msg_delta:stop_reason={ev.delta.stop_reason}")
        elif t in ("message_start", "message_stop"):
            seq.append(t)

print("事件序列:", " -> ".join(seq))

# 复核: 最终消息内容块类型
final = stream.get_final_message()
print("最终块类型:", [b.type for b in final.content])
print("stop_reason:", final.stop_reason)
for b in final.content:
    if b.type == "thinking":
        print("thinking 长度:", len(b.thinking))
    if b.type == "text":
        print("text 长度:", len(b.text), "预览:", b.text[:80])
