import json
import hashlib
import os
import threading
import uuid
from typing import Literal, List
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ValidationError

from fsatomic import read_text_with_retry
from models import Message, TextContentBlock


class StorageEntry(BaseModel):
    uuid: str
    parent_uuid: Optional[str] = None
    message: dict  # Message.model_dump() 的结果
    timestamp: str


class TitleRecord(BaseModel):
    """命名记录: 与消息条目并存于同一 JSONL, 不进消息链。追加式改名:
    同一会话可有多条 title 记录, 展示永远取最新一条。"""
    type: Literal["title"] = "title"
    title: str
    timestamp: str


class WorkdirRecord(BaseModel):
    """工作目录记录: 会话所属"项目"。与 title 同一套追加式设计, 取最新一条。
    workdir=None 表示"清除归属"(解除会话与项目的绑定), 旧目录记录保留在文件里。"""
    type: Literal["workdir"] = "workdir"
    workdir: Optional[str] = None
    timestamp: str


class PermissionModeRecord(BaseModel):
    """权限模式记录: 会话级隔离的持久化。追加式取最新一条;
    没有记录的会话回落全局默认（app_state）。
    mode 是基础权限模式名（MODE_TO_NAME 的值）; plan 是计划开关,
    与基础模式独立叠加。旧记录（引入 plan 字段之前）缺 plan → False;
    旧数据里 mode="plan"/"read-only" 的读取时归一为 ("prompt", True)——
    见 get_permission_mode。"""
    type: Literal["permission_mode"] = "permission_mode"
    mode: str
    plan: bool = False
    timestamp: str


class ModelRecord(BaseModel):
    """会话模型记录: 会话级模型选择的持久化。追加式取最新一条;
    没有记录的会话跟随全局 active 模型。model_id=None 表示"清除覆盖"
    （回到跟随全局）, 旧记录保留在文件里。"""
    type: Literal["model"] = "model"
    provider_id: Optional[str] = None
    model_id: Optional[str] = None
    timestamp: str


class SessionMemoryRecord(BaseModel):
    """Session Memory（三层压缩中间层的滚动摘要）记录: 后台消化每合并
    一步追加一条, 恢复时取最新。last_sha = 第 digested-1 条消息内容的
    稳定哈希——恢复时校验消息链对齐（repair/中断修补可能改变消息数,
    错位的摘要宁可弃用: 覆盖不全回落现场摘要, 不劣于没有持久化）。"""
    type: Literal["session_memory"] = "session_memory"
    summary: str
    digested: int
    last_sha: str = ""
    timestamp: str


class SessionStore:

    # 进程内互斥: 大记录(几十 KB 的工具结果)经缓冲写入可能拆成多次
    # write() 系统调用, 并发线程交错时另一条记录的半截插进中间——
    # JSONL 出现"一行撕成多行"的结构性损坏(20260925-022538 实测)。
    _append_lock = threading.Lock()

    # 全文搜索: 每会话摘录上限; 摘录前后上下文宽度。量级考虑:
    # 会话列表一屏放得下, 没必要做分页; 摘录太长反而淹没关键词。
    SEARCH_SNIPPET_LIMIT = 3
    SEARCH_CONTEXT = 60

    def __init__(self, storage_dir: Path):
        self._storage_dir = storage_dir
        # 全文搜索的可搜文本缓存: (mtime_ns, size) -> 拼接后的正文。
        # 文件追加(新消息)必改 mtime/size, 缓存自然失效; 进程重启清零,
        # 无持久化——派生数据不落盘, 永不与 JSONL 失同步。
        self._search_text_cache: dict[Path, tuple[int, int, str]] = {}

    def  _append_entry(self, path: Path, entry):
        """追加一条 JSONL 记录。entry 是已 dump 的 dict 或 pydantic 模型。

        整条记录序列化成一段 bytes 后**单次** write 追加: json.dumps 的
        输出不可能含裸换行(字符串内控制字符一律转义), 单次写入再配合
        O_APPEND 语义, 记录要么整行落下要么不落, 不会被别的并发写半路
        撕开。代理字符(上游 errors="surrogateescape" 之类漏进来的)在
        编码时就地转 U+FFFD, 保证 utf-8 编码永不抛错、永不吐裸字节。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        data = entry.model_dump() if isinstance(entry, BaseModel) else entry
        text = json.dumps(data, ensure_ascii=False)
        payload = (text.encode("utf-8", errors="surrogatepass")
                   .decode("utf-8", errors="replace")
                   .encode("utf-8") + b"\n")
        with self._append_lock, open(path, "ab") as f:
            f.write(payload)


    def save_message(self, session_id: str, message: Message, parent_uuid: Optional[str]) -> str:
        file_path = self._session_path(session_id)
        msg = message.model_dump()
        curr_id = str(uuid.uuid4())
        entry = StorageEntry(
            uuid=curr_id,
            parent_uuid=parent_uuid,
            message=msg,
            timestamp=datetime.now(timezone.utc).isoformat()
        ).model_dump()
        self._append_entry(file_path, entry)
        return curr_id

    # 注: 曾有 rewrite_session(压缩后重写整个会话文件)。压缩已改为
    # "给模型的请求期视图"(runtime._model_view), 历史不再被改写,
    # 存储永远只追加, 该函数随之退役。

    def load_session(self, session_id:str) -> tuple[list[Message], Optional[str]]:
        file_path = self._session_path(session_id)
        result : list[Message] = []
        entries = [e for e in self._read_entries(file_path)
                   if isinstance(e, StorageEntry)]
        if not entries:
            return result, None
        chain = self._rebuild_chain(entries)
        for entry in chain:
            result.append(Message.model_validate(entry.message))

        last_uuid = chain[-1].uuid

        return result, last_uuid

    def load_session_detail(self, session_id: str) -> tuple[list[tuple[Message, str]], Optional[str]]:
        """与 load_session 相同的消息链, 但逐条携带落盘 timestamp。
        供历史回放场景（如 minimap 快速定位）展示相对时间, 不影响
        请求构造链路——后者继续用 load_session。"""
        file_path = self._session_path(session_id)
        entries = [e for e in self._read_entries(file_path)
                   if isinstance(e, StorageEntry)]
        if not entries:
            return [], None
        chain = self._rebuild_chain(entries)
        detail = [(Message.model_validate(entry.message), entry.timestamp)
                  for entry in chain]
        return detail, chain[-1].uuid

    def list_sessions(self) -> list[str]:
        """列出所有会话 ID。"""
        if not self._storage_dir.exists():
            return []
        return sorted(
            p.stem for p in self._storage_dir.glob("*.jsonl")
        )

    def delete_session(self, session_id: str) -> None:
        """删除会话（消息 + 命名记录同在一个 JSONL，删文件即可）。文件不存在抛 KeyError。"""
        file_path = self._session_path(session_id)
        if not file_path.exists():
            raise KeyError(session_id)
        file_path.unlink()

    # --- 会话命名 (prompt_dev/session_title.md) ---
    # 存储方案: 标题作为独立记录类型与消息条目共存于同一 JSONL 文件。
    # 改名 = 追加一条新 title 记录, 旧记录保留——追加式哲学不被破坏,
    # 消息链(parent_uuid)完全不受影响, _read_entries 按字段校验会
    # 自动跳过 title 行, load_session 行为不变。

    def set_title(self, session_id: str, title: str) -> None:
        """追加一条命名记录。改名不删旧记录, 展示层取最新。"""
        record = TitleRecord(
            title=title,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._append_entry(self._session_path(session_id), record)

    @staticmethod
    def _message_sha(message: Message) -> str:
        """消息内容的稳定哈希（sort_keys 保证跨进程/跨次 dump 一致）。"""
        payload = json.dumps(message.model_dump(), ensure_ascii=False,
                             sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def save_session_memory(self, session_id: str, summary: str,
                            digested: int, messages: List[Message]) -> None:
        """追加一条 Session Memory 记录（后台消化每合并一步调用一次）。
        last_sha 取第 digested-1 条消息的哈希供恢复时校验对齐; digested
        越界时不记 sha（恢复时的在界校验必然弃用, 等价于没有持久化）。"""
        last_sha = (self._message_sha(messages[digested - 1])
                    if 0 < digested <= len(messages) else "")
        record = SessionMemoryRecord(
            summary=summary, digested=digested, last_sha=last_sha,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._append_entry(self._session_path(session_id), record)

    def load_session_memory(self, session_id: str,
                            messages: List[Message]) -> Optional[tuple[str, int]]:
        """返回 (summary, digested) 或 None。恢复校验三连: 有记录且非空、
        digested 在界、尾部消息哈希一致——消息链被修补/改写过就视为摘要
        错位, 宁可弃用（回落现场摘要, 行为不劣于没有持久化）。"""
        latest: Optional[SessionMemoryRecord] = None
        for entry in self._read_entries(self._session_path(session_id)):
            if isinstance(entry, SessionMemoryRecord):
                latest = entry
        if latest is None or not latest.summary:
            return None
        if not 0 < latest.digested <= len(messages):
            return None
        if self._message_sha(messages[latest.digested - 1]) != latest.last_sha:
            return None
        return latest.summary, latest.digested

    def count_messages(self, session_id: str) -> int:
        """会话消息数（活跃链长度）。无记录/空会话返回 0。"""
        entries = [e for e in self._read_entries(self._session_path(session_id))
                   if isinstance(e, StorageEntry)]
        if not entries:
            return 0
        return len(self._rebuild_chain(entries))

    def get_title(self, session_id: str) -> Optional[str]:
        """返回会话名; 没有命名记录返回 None（旧会话 → 展示"(未命名)"）。"""
        entries = self._read_entries(self._session_path(session_id))
        latest: Optional[str] = None
        for entry in entries:
            if isinstance(entry, TitleRecord):
                latest = entry.title
        return latest

    def set_workdir(self, session_id: str, workdir: str) -> None:
        """追加一条工作目录记录（会话的项目目录）。"""
        record = WorkdirRecord(
            workdir=workdir,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._append_entry(self._session_path(session_id), record)

    def get_workdir(self, session_id: str) -> Optional[str]:
        """返回会话工作目录; 没有记录返回 None（工具回退到服务进程 cwd）。"""
        entries = self._read_entries(self._session_path(session_id))
        latest: Optional[str] = None
        for entry in entries:
            if isinstance(entry, WorkdirRecord):
                latest = entry.workdir
        return latest

    def set_permission_mode(self, session_id: str, mode: str,
                            plan: bool = False) -> None:
        """追加一条权限模式记录（会话级隔离的持久化）。mode 为基础权限
        模式名（MODE_TO_NAME 的值）; plan 为计划开关。非法值由调用方校验。"""
        record = PermissionModeRecord(
            mode=mode,
            plan=bool(plan),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._append_entry(self._session_path(session_id), record)

    def get_permission_mode(self, session_id: str) -> tuple:
        """返回 (基础权限模式名, 计划开关); 没有记录返回 (None, False)
        （调用方回落全局默认）。旧数据归一在此单一收口:
        mode="plan"/"read-only"（只读模式时代的记录——当时计划是并列
        模式）→ ("prompt", True): 基础模式回落 prompt, 计划开关保持开。"""
        entries = self._read_entries(self._session_path(session_id))
        latest: Optional[PermissionModeRecord] = None
        for entry in entries:
            if isinstance(entry, PermissionModeRecord):
                latest = entry
        if latest is None:
            return None, False
        if latest.mode in ("plan", "read-only"):
            return "prompt", True
        return latest.mode, bool(latest.plan)

    def set_model(self, session_id: str, provider_id: Optional[str],
                  model_id: Optional[str]) -> None:
        """追加一条会话模型记录。model_id=None 表示清除覆盖（跟随全局）。"""
        record = ModelRecord(
            provider_id=provider_id,
            model_id=model_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._append_entry(self._session_path(session_id), record)

    def get_model(self, session_id: str) -> tuple[Optional[str], Optional[str]]:
        """返回会话模型 (provider_id, model_id); 没有记录返回 (None, None)
        （调用方回落全局 active）。"""
        entries = self._read_entries(self._session_path(session_id))
        latest: Optional[ModelRecord] = None
        for entry in entries:
            if isinstance(entry, ModelRecord):
                latest = entry
        if latest is None:
            return (None, None)
        return (latest.provider_id, latest.model_id)

    def _session_path(self, session_id: str) -> Path:
        return self._storage_dir / f"{session_id}.jsonl"

    # --- 会话全文搜索 (2026-10-10) ---
    # 定位: "记得聊过什么但忘了是哪个会话"的兜底查找。线性扫描 + mtime
    # 缓存, 不建倒排索引——几十 MB 量级全扫 <200ms(本机 84 会话/35MB 实测
    # 110ms), 子串语义天然支持(倒排需分词且丢子串命中), 派生数据不落盘
    # 永不漏命中。数据量涨到数百 MB 再考虑换实现, 接口不变。

    @staticmethod
    def _searchable_text(message: Message) -> str:
        """拼接一条消息的可搜文本: text 块 + tool_use.input +
        tool_result.output + file 块。image 无文本自然跳过;
        title/workdir 等元数据记录不是 Message, 天然不参与。"""
        parts: list[str] = []
        for block in message.content:
            if isinstance(block, TextContentBlock):
                parts.append(block.text)
            elif block.type == "tool_use":
                parts.append(str(getattr(block, "input", "") or ""))
            elif block.type == "tool_result":
                parts.append(str(getattr(block, "output", "") or ""))
            elif block.type == "file":
                parts.append(f"{block.name} {block.text}")
        return "\n".join(parts)

    def _session_search_text(self, path: Path) -> str:
        """取会话文件的可搜正文, 按 (mtime_ns, size) 缓存。
        追加消息必改 mtime/size → 缓存自动失效; 校验不过就整文件重解析。"""
        try:
            st = path.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            return ""
        cached = self._search_text_cache.get(path)
        if cached and cached[0] == key[0] and cached[1] == key[1]:
            return cached[2]
        parts: list[str] = []
        for entry in self._read_entries(path):
            if isinstance(entry, StorageEntry):
                try:
                    msg = Message.model_validate(entry.message)
                    parts.append(self._searchable_text(msg))
                except ValidationError:
                    continue
        text = "\n".join(parts)
        self._search_text_cache[path] = (key[0], key[1], text)
        return text

    def search_sessions(self, query: str) -> dict[str, list[str]]:
        """全库子串搜索消息正文, 返回 {会话id: [摘录, ...]}。

        - 大小写不敏感(与前端标题过滤的 includes 语义一致)
        - 摘录压缩空白为单行, 命中词两侧各留 SEARCH_CONTEXT 字符,
          被截断的一侧以 … 起止; 每会话最多 SEARCH_SNIPPET_LIMIT 条
        - query 去除首尾空白后为空 → 返回 {} (调用方回落标题过滤)
        """
        q = (query or "").strip().lower()
        if not q:
            return {}
        results: dict[str, list[str]] = {}
        if not self._storage_dir.exists():
            return results
        for path in sorted(self._storage_dir.glob("*.jsonl")):
            text = self._session_search_text(path).lower()
            if q not in text:
                continue
            snippets: list[str] = []
            pos = 0
            while len(snippets) < self.SEARCH_SNIPPET_LIMIT:
                idx = text.find(q, pos)
                if idx < 0:
                    break
                start = max(0, idx - self.SEARCH_CONTEXT)
                end = min(len(text), idx + len(q) + self.SEARCH_CONTEXT)
                # 大写原文按同一坐标切摘录, 大小写在摘录里保真
                raw = self._session_search_text(path)[start:end]
                snippet = " ".join(raw.split())  # 压换行/多空白为单空格
                if start > 0:
                    snippet = "…" + snippet
                if end < len(text):
                    snippet += "…"
                snippets.append(snippet)
                pos = idx + len(q)
            if snippets:
                results[path.stem] = snippets
        return results

    def _read_entries(self, file_path: Path) -> list[StorageEntry]:

        result : list[StorageEntry] = []
        if not file_path.exists(): return result
        # 读走重试: 原子替换的过渡窗口里, Windows 新开读句柄会瞬时被拒
        # （delete pending）; 整体读入再按行解析
        text = read_text_with_retry(file_path)
        # 必须按物理行("\n")切分, 不能用 str.splitlines(): 后者把 U+0085/
        # U+2028/U+2029 也当行边界, 而 json.dumps(ensure_ascii=False) 不转义
        # 这些字符——工具结果里嵌了二进制/特殊 Unicode 时, 一条合法记录会被
        # 切成多段假告警, 消息条目丢失导致 parent_uuid 链断裂（历史回放丢失）。
        # 写入方 _append_entry 只写 "\n", 读取侧与写入侧对齐。
        for line_no, line in enumerate(text.split("\n"), 1):
            if line.strip() == "":
                continue
            try:
                data = json.loads(line)
                # title/workdir/permission_mode 记录与消息条目共存一个文件, 按类型分流
                if data.get("type") == "title":
                    result.append(TitleRecord.model_validate(data))
                elif data.get("type") == "workdir":
                    result.append(WorkdirRecord.model_validate(data))
                elif data.get("type") == "permission_mode":
                    result.append(PermissionModeRecord.model_validate(data))
                elif data.get("type") == "model":
                    result.append(ModelRecord.model_validate(data))
                elif data.get("type") == "session_memory":
                    result.append(SessionMemoryRecord.model_validate(data))
                else:
                    result.append(StorageEntry.model_validate(data))
            except json.JSONDecodeError as e:
                print(f"[WARN] line {line_no}: JSON 解析失败 - {e}")
                continue
            except ValidationError as e:
                print(f"[WARN] line {line_no}: 校验失败 - {e}")
                continue
        return result

    def detect_interruption(self, session_id: str) -> Optional[str]:
        """检测中断类型。

               CC 的恢复逻辑: 根据最后一条消息的 role 判断:
               - "user" → 用户发了消息但 AI 没回复
               - "tool" → 工具执行完但 AI 没继续
               - "assistant" → 正常结束，无中断
               - None → 空会话
        """
        path = self._session_path(session_id)
        entries = [e for e in self._read_entries(path)
                   if isinstance(e, StorageEntry)]
        if not entries:
            return None

        chain = self._rebuild_chain(entries)
        if not chain:
            return None

        last_role = chain[-1].message.get("role", "")
        if last_role in ("user", "tool"):
            return last_role
        return None

    @classmethod
    def _rebuild_chain(cls, entries: list[StorageEntry])-> list[StorageEntry]:
        uuid_map = {e.uuid: e for e in entries}
        referenced: set[str] = set()
        chain : list [StorageEntry] = []

        for entry in entries:
            if entry.parent_uuid:
                referenced.add(entry.parent_uuid)

        leaf_set = set(uuid_map.keys()) - referenced
        if not leaf_set:
            return [entries[-1]]

        tip : Optional[StorageEntry] = None
        for entry in reversed(entries):
            if entry.uuid in leaf_set:
                tip = entry
                break


        seen = set()  # 环检测（防止损坏的链指针导致无限循环）
        current_uuid = tip.uuid

        while current_uuid:
            if current_uuid in seen:
                print(f"    [WARNING] 检测到循环引用 {current_uuid}，停止遍历")
                break
            seen.add(current_uuid)

            entry = uuid_map.get(current_uuid)
            if entry is None:
                break

            chain.append(entry)
            current_uuid = entry.parent_uuid if entry.parent_uuid else ""
        chain.reverse()
        return chain



if __name__ == "__main__":
    store = SessionStore(Path("test_storage"))
    session_id = "s2"

    msgs,last_uuid =  store.load_session(session_id)
    u4 = store.save_message(session_id,  Message.user_text("答案是1"), last_uuid)
    print(msgs)





