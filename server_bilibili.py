# server_bilibili.py — REST: 摸鱼电台 · B站视频（server 包拆分的第 3 步）
#
# 纯音频: 搜索/直链/音频流本地代理。从 server.py 原样搬移;
# 复用 server_music 的 _music_call 502 包装。
"""Aulos web — B 站音频代理 API。"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import StreamingResponse

from server_common import app
from server_music import _music_call
import bilibili as _bili

# 顺序代理给 <audio> 用。前端 B 站播放与网易云共用一条播放条: 直链走
# 本地 /api/bili/stream, 不直连 B 站 CDN（防盗链只认 B 站 Referer,
# 浏览器从 localhost 会 403）。


@app.get("/api/bili/search")
async def api_bili_search(kw: str = "", limit: int = 30):
    return await _music_call(_bili.search_videos, kw, limit)


@app.get("/api/bili/url")
async def api_bili_url(bvid: str = ""):
    """拿音频直链信息; 前端不直接用它连 CDN, 而是拿 token 走 /stream。"""
    token = _bili.make_stream_token(bvid)
    url = await _music_call(_bili.get_audio_url, bvid)
    return {"source": "bili", "id": bvid, "token": token, "url": url}


@app.get("/api/bili/stream")
async def api_bili_stream(request: Request, token: str = ""):
    """音频流本地代理: 带 B 站 Referer 拉直链, 逐块转发给前端 <audio>。
    Range 透传: 浏览器读流会带 Range, seek 也会发二次 Range(206), 透传给 CDN。"""
    range_h = request.headers.get("range")
    status, ctype, crange, chunks = await _music_call(
        _bili.stream_audio, token, range_h)
    headers = {"Content-Type": ctype}
    if crange:
        headers["Content-Range"] = crange
        headers["Accept-Ranges"] = "bytes"
    return StreamingResponse(chunks, status_code=status, headers=headers)
