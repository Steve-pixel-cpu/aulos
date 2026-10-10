/* ============================================================
 * settings-extras.js — 设置页: 命令白名单 / Skills / 记忆
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 与 app.js 共享全局作用域; 由 index.html 在 app.js 之后
 * defer 加载——顺序反转是刻意的: 本文件加载期执行的顶层绑定
 * ($("btn-skill-install").onclick 等) 依赖 app.js 已就绪的 $ / state,
 * 而它暴露给 openSettings() 的渲染函数 (renderAllowlistSettings /
 * loadSkills / loadMemories) 只在用户打开设置页时才被调用, 运行时
 * 解引用, 加载序天然安全。
 *
 * 读的前置全局: $ / state / toast / confirmDialog / genQid 等 (app.js)
 * 暴露的全局:   renderAllowlistSettings / loadSkills / skillStatus /
 *               loadMemories (openSettings 调用) + 本域事件绑定
 * ============================================================ */
/* ============================================================
 * 设置页: 命令白名单（GET/POST/DELETE /api/settings/allowlist）
 * ============================================================ */
async function renderAllowlistSettings() {
  await renderRuleListSettings({
    listEl: "al-rule-list", url: "/api/settings/allowlist",
    key: "rules", emptyText: "还没有规则。审批弹窗里的“总是允许”会自动把命令前缀加进来。",
  });
}
async function renderDenylistSettings() {
  await renderRuleListSettings({
    listEl: "dl-rule-list", url: "/api/settings/denylist",
    key: "rules", emptyText: "还没有拒绝规则。白名单放行 \"git push\" 的同时, 可以在这里加 \"git push --force\" 拦住强推。",
  });
}
async function renderSensitivePathsSettings() {
  await renderRuleListSettings({
    listEl: "sp-path-list", url: "/api/settings/sensitive-paths",
    key: "paths", emptyText: "还没有自定义敏感路径。加项目里的 secrets/、.env.production 等, 写入时任何模式都强制确认。",
  });
}

/* 通用清单管理器: 白名单/拒绝清单/敏感路径三个分区共用同一交互
 * （GET 拉取渲染, DELETE 按原文移除）。 */
async function renderRuleListSettings({ listEl, url, key, emptyText }) {
  const list = $(listEl);
  if (!list) return;
  let items = [];
  try {
    const r = await fetch(url);
    if (r.ok) items = (await r.json())[key] || [];
  } catch (e) { /* 服务不可达: 列表留空 */ }
  list.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "al-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "al-rule-item";
    const code = document.createElement("code");
    code.textContent = item;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-act al-del";
    del.textContent = "删除";
    del.onclick = async () => {
      del.disabled = true;
      try {
        const r = await fetch(url, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key === "paths" ? "path" : "rule"]: item }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        renderRuleListSettings({ listEl, url, key, emptyText });
      } catch (e) {
        del.disabled = false;
        toast("删除失败: " + e.message);
      }
    };
    row.appendChild(code);
    row.appendChild(del);
    list.appendChild(row);
  }
}

/* 添加框的通用行为: POST 一条新规则/路径后重渲染本分区。 */
function bindRuleListInput(inputId, btnId, url, bodyKey, listSpec, doneMsg) {
  const submit = async () => {
    const inp = $(inputId);
    const value = (inp.value || "").trim();
    if (!value) return;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [bodyKey]: value }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      inp.value = "";
      renderRuleListSettings(listSpec);
      toast(doneMsg);
    } catch (e) {
      toast("添加失败: " + e.message);
    }
  };
  $(btnId).onclick = submit;
  $(inputId).addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}
bindRuleListInput("al-rule-input", "btn-al-add", "/api/settings/allowlist",
  "rule", { listEl: "al-rule-list", url: "/api/settings/allowlist", key: "rules" },
  "白名单已更新");
bindRuleListInput("dl-rule-input", "btn-dl-add", "/api/settings/denylist",
  "rule", { listEl: "dl-rule-list", url: "/api/settings/denylist", key: "rules" },
  "拒绝清单已更新");
bindRuleListInput("sp-path-input", "btn-sp-add", "/api/settings/sensitive-paths",
  "path", { listEl: "sp-path-list", url: "/api/settings/sensitive-paths", key: "paths" },
  "敏感路径已更新");

/* ============================================================
 * 设置页: Skills（GET /api/skills, POST /api/skills/install,
 * DELETE /api/skills/{name}）—— 安装/卸载后端即时热生效
 * ============================================================ */
function skillStatus(msg, isErr) {
  const el = $("skill-install-status");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("err", Boolean(isErr));
}

async function loadSkills() {
  const list = $("skill-list");
  if (!list) return [];
  let skills = [];
  try {
    const r = await fetch("/api/skills");
    if (r.ok) skills = (await r.json()).skills || [];
  } catch (e) { /* 服务不可达: 列表留空 */ }
  // 同一份清单喂给斜杠补全（设置页拉的是 cwd 视图; 会话绑定其他目录时,
  // 补全按 skillCacheDir 失配自动重拉, 不吃这里的缓存）
  state.skillCache = skills;
  skillCacheDir = "";
  list.innerHTML = "";
  if (!skills.length) {
    const empty = document.createElement("div");
    empty.className = "al-empty";
    empty.textContent = "还没有安装技能。上方输入 GitHub 仓库即可安装社区 skills。";
    list.appendChild(empty);
    return skills;
  }
  for (const s of skills) {
    const item = document.createElement("div");
    item.className = "skill-item";
    const head = document.createElement("div");
    head.className = "skill-item-head";
    const name = document.createElement("span");
    name.className = "skill-name";
    name.textContent = s.name;
    const badge = document.createElement("span");
    badge.className = `skill-src skill-src-${s.source === "project" ? "project" : "user"}`;
    badge.textContent = s.source === "project" ? "项目级" : "用户级";
    head.appendChild(name);
    head.appendChild(badge);
    if (s.description) {
      const desc = document.createElement("div");
      desc.className = "skill-desc";
      desc.textContent = s.description;
      head.appendChild(desc);
    }
    const dir = document.createElement("div");
    dir.className = "skill-dir";
    dir.textContent = s.dir;
    item.appendChild(head);
    item.appendChild(dir);
    if (s.source !== "project") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-act al-del skill-del";
      del.textContent = "卸载";
      del.onclick = async () => {
        del.disabled = true;
        try {
          const r = await fetch(`/api/skills/${encodeURIComponent(s.name)}`,
                               { method: "DELETE" });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
          toast("已卸载 " + s.name);
          loadSkills();        } catch (e) {
          del.disabled = false;
          toast("卸载失败: " + e.message);
        }
      };
      item.appendChild(del);
    }
    list.appendChild(item);
  }
  return skills;
}

async function installSkillFromInput() {
  const inp = $("skill-repo-input");
  const sub = $("skill-subpath-input");
  const chk = $("skill-overwrite-chk");
  const btn = $("btn-skill-install");
  const repo = (inp.value || "").trim();
  if (!repo) { skillStatus("请填写仓库地址", true); return; }
  btn.disabled = true;
  skillStatus("正在克隆并解析技能…");
  try {
    const r = await fetch("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo,
        subpath: (sub.value || "").trim(),
        overwrite: chk ? chk.checked : false,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    const names = (data.installed || []).map(s => s.name).join(", ");
    skillStatus(`已安装: ${names}`);
    inp.value = ""; sub.value = "";
    loadSkills();
    toast("技能已安装并生效");
  } catch (e) {
    skillStatus("安装失败: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$("btn-skill-install").onclick = installSkillFromInput;
$("skill-repo-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") installSkillFromInput();
});

/* ============================================================
 * 设置页: 记忆（GET/POST /api/memory, PATCH/DELETE /api/memory/{id}）
 * source=user 的条目不会被自动淘汰; agent 条目只在对话流里维护
 * ============================================================ */
const MEM_CAT_LABEL = { preference: "偏好", fact: "事实", context: "背景" };

async function loadMemories() {
  const list = $("mem-list");
  if (!list) return;
  let memories = [], evictedCount = 0;
  try {
    const r = await fetch("/api/memory");
    if (r.ok) {
      const data = await r.json();
      memories = data.memories || [];
      evictedCount = data.evicted_count || 0;
    }
  } catch (e) { /* 服务不可达: 列表留空 */ }
  const note = $("mem-evict-note");
  if (note) {
    note.style.display = evictedCount ? "" : "none";
    note.textContent = evictedCount
      ? `另有 ${evictedCount} 条记忆因容量上限被自动淘汰（归档于 memory.json 的 evicted，可手动找回）` : "";
  }
  list.innerHTML = "";
  if (!memories.length) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    const ico = document.createElement("div");
    ico.className = "mem-empty-ico";
    ico.textContent = "🧠";
    const main = document.createElement("div");
    main.className = "mem-empty-main";
    main.textContent = "还没有记忆";
    const sub = document.createElement("div");
    sub.className = "mem-empty-sub";
    sub.textContent = "对话中让 Agent 记，或在上方手动添加一条";
    empty.appendChild(ico);
    empty.appendChild(main);
    empty.appendChild(sub);
    list.appendChild(empty);
    return;
  }
  for (const m of memories) {
    const item = document.createElement("div");
    item.className = "mem-item";
    const main = document.createElement("div");
    main.className = "mem-main";
    const content = document.createElement("div");
    content.className = "mem-content";
    content.textContent = m.content;
    const meta = document.createElement("div");
    meta.className = "mem-meta";
    const cat = document.createElement("span");
    cat.className = `mem-cat mem-cat-${m.category || "fact"}`;
    cat.textContent = MEM_CAT_LABEL[m.category] || m.category;
    const badge = document.createElement("span");
    badge.className = `mem-src ${m.source === "user" ? "mem-src-user" : "mem-src-agent"}`;
    badge.textContent = m.source === "user" ? "用户" : "Agent";
    meta.appendChild(cat);
    meta.appendChild(badge);
    if (m.created_at) {
      const time = document.createElement("span");
      time.className = "mem-time";
      time.textContent = (m.created_at || "").slice(0, 10);
      meta.appendChild(time);
    }
    main.appendChild(content);
    main.appendChild(meta);
    item.appendChild(main);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-act mem-del";
    del.textContent = "删除";
    del.title = "删除这条记忆";
    del.onclick = async () => {
      del.disabled = true;
      try {
        const r = await fetch(`/api/memory/${encodeURIComponent(m.id)}`,
                             { method: "DELETE" });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
        toast("已删除该条记忆");
        loadMemories();
      } catch (e) {
        del.disabled = false;
        toast("删除失败: " + e.message);
      }
    };
    item.appendChild(del);
    list.appendChild(item);
  }
}

/* 记忆分类下拉: 用应用统一的 dd 弹层替换原生 select */
let memCategory = "fact";
const memCatDd = makeDropdown($("mem-category"), {
  items: Object.entries(MEM_CAT_LABEL).map(([value, label]) => ({ value, label })),
  value: memCategory,
  onChange(v) { memCategory = v; },
});

async function addMemoryFromInput() {
  const inp = $("mem-input"), btn = $("btn-mem-add");
  const content = (inp.value || "").trim();
  if (!content) { toast("先写点要记的内容"); return; }
  btn.disabled = true;
  try {
    const r = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, category: memCategory }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    inp.value = "";
    inp.style.height = "";
    loadMemories();
    toast("已添加记忆");
  } catch (e) {
    toast("添加失败: " + e.message);
  } finally {
    btn.disabled = false;
  }
}
$("btn-mem-add").onclick = addMemoryFromInput;
const memInputEl = $("mem-input");
memInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    addMemoryFromInput();
  }
});
memInputEl.addEventListener("input", () => {
  memInputEl.style.height = "auto";
  memInputEl.style.height = Math.min(memInputEl.scrollHeight, 160) + "px";
  memInputEl.classList.toggle("scrollable", memInputEl.scrollHeight > 160);
});
