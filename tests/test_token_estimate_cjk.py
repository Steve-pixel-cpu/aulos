"""R2: CJK 感知 token 估算——len//4+1 对中文低估 3~4 倍（中文现代分词器
约 1 字 ≈ 0.7~1.1 token, //4 只给 0.25）, MicroCompact 60K 触发线实际
150~240K 真实 token 才触发, 清理滞后。修复: 文本按 CJK/非 CJK 分桶加权,
非 CJK 维持 //4 校准, 禁止全局 //2（对英文高估 2 倍）。

运行: uv run pytest tests/test_token_estimate_cjk.py -v
"""

from aulos.compact import _estimate_text_tokens, estimate_message_tokens
from aulos.models import Message


def test_纯英文校准不变():
    # 800 ASCII 字符 ≈ 200 token（原 //4+1 校准）
    assert _estimate_text_tokens("x" * 800) == 800 // 4 + 1


def test_纯中文按约1token每字计():
    # 1 万中文字 ≈ 1 万 token（原实现只给 2500）
    text = "测" * 10_000
    est = _estimate_text_tokens(text)
    assert 0.8 * 10_000 <= est <= 1.2 * 10_000


def test_中英混合按比例分桶():
    text = "x" * 400 + "测" * 600     # 400 英文 → 100 tok; 600 中文 → ~600 tok
    est = _estimate_text_tokens(text)
    assert 0.8 * 700 <= est <= 1.2 * 700


def test_CJK标点与全角区间也按CJK计():
    # U+3000-303F（CJK标点）、U+FF00-FFEF（全角形式）
    text = "，。！？（）《》" + "：；"   # 全部落在 CJK 辅助区间
    est = _estimate_text_tokens(text)
    assert est >= len(text) - 2          # 每字至少约 1 token, +1 起步余量


def test_消息级估算用分桶结果():
    # 中文工具结果 2 万字: 旧实现估 5k token（< 60K 不触发微压缩）,
    # 新实现估 ~20k——12 条这样的消息旧口径 60k 恰好擦线, 新口径明确超线
    msg = Message.tool_result(id="t", name="bash", output="测" * 20_000,
                              is_error=False)
    est = estimate_message_tokens(msg)
    assert est >= 19_000
