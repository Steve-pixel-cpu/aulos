"""贴图降采样: 用户粘贴的大截图不再原样常驻会话。

实测单会话两张截图（81KB / 176KB base64）常驻并逐轮重发, 上下文里
永远背着这两块石头。这里在用户消息入会话前把超限图片等比压到限额内:
单边 ≤1568px（与主流视觉模型按分辨率分档计费的门槛对齐）且 ≤300KB。
原图落盘 tool-outputs/images/ 供追溯, 会话 JSONL 与后续每轮请求只带
缩后版本。

失败方向保守: 解码/编码/落盘任何一步出问题都退回原图——瘦身是优化,
不是正确性依赖, 单张失败不拖累整条消息。
"""
import base64
import hashlib
import io
import time

from config import USER_DIR

IMAGES_DIR = USER_DIR / "tool-outputs" / "images"
MAX_SIDE_PX = 1568
MAX_BYTES = 300 * 1024

_EXT_BY_MEDIA_TYPE = {
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def slim_image_attachments(attachments):
    """逐个检查 image 附件; 超限的降采样重编码并落盘原图, 返回附件列表
    （无超限项时原列表原样返回, 零拷贝）。"""
    if not attachments:
        return attachments
    out = []
    changed = False
    for att in attachments:
        slim = att
        if isinstance(att, dict) and att.get("kind") == "image":
            try:
                slim = _slim_one(att)
            except Exception:
                slim = att          # 单张失败不拖累整条消息
        if slim is not att:
            changed = True
        out.append(slim)
    return out if changed else attachments


def _slim_one(att: dict) -> dict:
    from PIL import Image

    raw = base64.b64decode(att.get("data") or "")
    media_type = att.get("media_type") or "image/png"
    with Image.open(io.BytesIO(raw)) as img:
        w, h = img.size
        if max(w, h) <= MAX_SIDE_PX and len(raw) <= MAX_BYTES:
            return att                      # 本就达标
        if max(w, h) > MAX_SIDE_PX:
            scale = MAX_SIDE_PX / max(w, h)
            img = img.resize(
                (max(1, round(w * scale)), max(1, round(h * scale))),
                Image.LANCZOS)
        data, new_media_type = _encode(img)
    _spill_original(raw, media_type)
    return {**att, "data": data, "media_type": new_media_type}


def _encode(img) -> tuple:
    """编码到限额内。PNG 优先（截图文字锐度）; 超 300KB 退 JPEG
    （透明压平到白底）, 再超降质量。"""
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    if buf.tell() <= MAX_BYTES:
        return base64.b64encode(buf.getvalue()).decode("ascii"), "image/png"
    if img.mode != "RGB":
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
    for quality in (85, 70):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        if buf.tell() <= MAX_BYTES:
            break
    return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"


def _spill_original(raw: bytes, media_type: str) -> None:
    """原图落盘（时间戳 + 内容 hash 命名）。尽力而为: 失败静默。"""
    try:
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        ext = _EXT_BY_MEDIA_TYPE.get(media_type, ".png")
        digest = hashlib.sha256(raw).hexdigest()[:12]
        path = IMAGES_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}_{digest}{ext}"
        if not path.exists():
            path.write_bytes(raw)
    except Exception:
        pass
