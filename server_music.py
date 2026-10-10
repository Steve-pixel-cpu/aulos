# server_music.py — REST: 摸鱼电台（server 包拆分的第 2 步）
#
# 在线只读代理（搜索/直链/歌词）+ 本地曲库读写, 不碰会话/模型状态。
# 从 server.py 原样搬移; 路由挂在 server_common.app 上, server.py import
# 本模块完成注册。
"""Aulos web — 摸鱼电台 API。"""
from __future__ import annotations

from typing import Optional

from fastapi import Body, HTTPException

from server_common import app
import music as _music

# 在线部分（搜索/直链/歌词）上游失败转 502; 本地曲库是文件读写:
# KeyError→404（歌单/收藏不存在）, ValueError→400（参数非法）,
# 不走 _music_call（那是给上游 502 用的包装）。


async def _music_call(fn, *args, **kwargs):
    """统一的 502 包装: 上游失败不往客户端抛裸 500。"""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


def _library_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"不存在: {e.args[0]}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/music/library")
async def api_music_library():
    """整个本地曲库（收藏 + 自定义歌单）。"""
    return _music.list_library()


# ---- 收藏 ----

@app.post("/api/music/favorites")
async def api_music_fav_add(payload: Optional[dict] = Body(None)):
    if not isinstance(payload, dict) or not isinstance(payload.get("songs"), list):
        raise HTTPException(status_code=400, detail="需要 {\"songs\": [...]}")
    return _music.add_favorites(payload["songs"])


@app.delete("/api/music/favorites/{song_id}")
async def api_music_fav_remove(song_id: str, source: str = "netease"):
    return _library_call(_music.remove_favorite, song_id, source)


# ---- 自定义播放列表 ----

@app.post("/api/music/playlists")
async def api_music_pl_create(payload: Optional[dict] = Body(None)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="需要 JSON body")
    return _library_call(_music.create_playlist,
                         payload.get("name"), payload.get("songs"))


@app.patch("/api/music/playlists/{pid}")
async def api_music_pl_rename(pid: int, payload: Optional[dict] = Body(None)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="需要 JSON body")
    return _library_call(_music.rename_playlist, pid, payload.get("name"))


@app.delete("/api/music/playlists/{pid}")
async def api_music_pl_delete(pid: int):
    return _library_call(_music.delete_playlist, pid)


@app.post("/api/music/playlists/{pid}/songs")
async def api_music_pl_add_songs(pid: int, payload: Optional[dict] = Body(None)):
    if not isinstance(payload, dict) or not isinstance(payload.get("songs"), list):
        raise HTTPException(status_code=400, detail="需要 {\"songs\": [...]}")
    return _library_call(_music.add_to_playlist, pid, payload["songs"])


@app.delete("/api/music/playlists/{pid}/songs/{song_id}")
async def api_music_pl_remove_song(pid: int, song_id: str, source: str = "netease"):
    return _library_call(_music.remove_from_playlist, pid, [song_id], source)


@app.get("/api/music/search")
async def api_music_search(kw: str = "", limit: int = 30):
    return await _music_call(_music.search_songs, kw, limit)


@app.get("/api/music/url")
async def api_music_url(id: int, br: int = 128000):
    """播放直链。VIP/无版权歌 url 为 None, 前端按「跳过」处理。"""
    return await _music_call(_music.song_url, id, br)


@app.get("/api/music/lyric")
async def api_music_lyric(id: int):
    return await _music_call(_music.song_lyric, id)
