/**
 * Web client. Three views selected by the URL hash:
 *   (no token)      -> login / register
 *   #/              -> document list
 *   #/doc/<id>      -> editor
 * The editor is a <textarea>. Each input event becomes CRDT ops through a text diff.
 * Remote ops re-render the textarea; the selection follows CRDT anchors, so it does not jump.
 */
import type { Presence } from "../../shared/protocol";
import { SyncClient, type Status } from "../sync-client";

const app = document.getElementById("app")!;
const who = document.getElementById("who")!;
const logoutBtn = document.getElementById("logout") as HTMLButtonElement;

// sessionStorage: one login per browser tab, so 3 tabs can be 3 different users.
const session = {
  get token() {
    return sessionStorage.getItem("ds04.token");
  },
  get user() {
    return sessionStorage.getItem("ds04.user") ?? "";
  },
  set(user: string, token: string) {
    sessionStorage.setItem("ds04.user", user);
    sessionStorage.setItem("ds04.token", token);
  },
  clear() {
    sessionStorage.removeItem("ds04.user");
    sessionStorage.removeItem("ds04.token");
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (d = new Date()) => d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && session.token) {
    session.clear();
    location.hash = "#/";
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

// ---------------- router ----------------

let active: SyncClient | null = null;

function route() {
  active?.disconnect("leave editor");
  active = null;
  who.textContent = session.user;
  logoutBtn.hidden = !session.token;
  if (!session.token) return renderLogin();
  const m = location.hash.match(/^#\/doc\/([a-z0-9]+)$/);
  return m ? renderEditor(m[1]!) : renderList();
}

logoutBtn.onclick = () => {
  session.clear();
  location.hash = "#/";
  route();
};
window.addEventListener("hashchange", route);
route();

// ---------------- login ----------------

function renderLogin() {
  app.innerHTML = `
    <section class="card narrow">
      <h1>Đăng nhập</h1>
      <form id="auth">
        <label>Tên đăng nhập <input name="username" autocomplete="username" required pattern="[a-z0-9_]{3,32}" title="3-32 ký tự: a-z, 0-9, _"></label>
        <label>Mật khẩu <input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
        <div class="row">
          <button class="primary" name="action" value="login">Đăng nhập</button>
          <button name="action" value="register">Đăng ký</button>
        </div>
        <p class="error" id="authError"></p>
      </form>
    </section>`;
  const form = document.getElementById("auth") as HTMLFormElement;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const action = ((e as SubmitEvent).submitter as HTMLButtonElement).value;
    const data = Object.fromEntries(new FormData(form));
    try {
      const res = await api<{ username: string; token: string }>(`/api/${action}`, { method: "POST", body: data });
      session.set(res.username, res.token);
      route();
    } catch (err) {
      document.getElementById("authError")!.textContent = (err as Error).message;
    }
  };
}

// ---------------- document list ----------------

type DocItem = { id: string; title: string; owner: string; role: string; updated_at: number };

async function renderList() {
  app.innerHTML = `
    <section class="card">
      <h1>Tài liệu</h1>
      <form id="create" class="row">
        <input name="title" placeholder="Tên tài liệu mới" required maxlength="100">
        <button class="primary">Tạo tài liệu</button>
      </form>
      <ul class="doclist" id="docs"><li class="muted">Đang tải...</li></ul>
      <form id="openId" class="row">
        <input name="id" placeholder="Mã tài liệu (người khác chia sẻ cho bạn)" pattern="[a-z0-9]{6,32}" required>
        <button>Mở</button>
      </form>
      <p class="error" id="listError"></p>
    </section>`;
  const createForm = document.getElementById("create") as HTMLFormElement;
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const doc = await api<{ id: string }>("/api/docs", { method: "POST", body: Object.fromEntries(new FormData(createForm)) });
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      document.getElementById("listError")!.textContent = (err as Error).message;
    }
  };
  const openForm = document.getElementById("openId") as HTMLFormElement;
  openForm.onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/doc/${new FormData(openForm).get("id")}`;
  };

  const docs = await api<DocItem[]>("/api/docs").catch(() => []);
  const roleText: Record<string, string> = { owner: "chủ sở hữu", editor: "biên tập", viewer: "chỉ xem" };
  document.getElementById("docs")!.innerHTML = docs.length
    ? docs
        .map(
          (d) => `<li><a href="#/doc/${d.id}">${esc(d.title)}</a>
            <span class="muted">${roleText[d.role] ?? d.role} · chủ: ${esc(d.owner)} · ${new Date(d.updated_at).toLocaleString("vi-VN")}</span></li>`,
        )
        .join("")
    : `<li class="muted">Chưa có tài liệu.</li>`;
}

// ---------------- editor ----------------

function renderEditor(docId: string) {
  app.innerHTML = `
    <section class="editor-page">
      <div class="doc-head">
        <div>
          <h1 id="title">Đang mở...</h1>
          <div class="muted">Mã tài liệu: <code>${docId}</code> · Vai trò: <span id="role">-</span></div>
        </div>
        <div class="actions">
          <span id="conn" class="chip">-</span>
          <span id="saved" class="chip">-</span>
          <button id="toggleNet">Ngắt kết nối</button>
          <button id="download">Tải về .txt</button>
        </div>
      </div>
      <div class="layout">
        <div class="paper">
          <div id="mirror" class="mirror" aria-hidden="true"></div>
          <textarea id="editor" spellcheck="false" readonly placeholder="Bắt đầu soạn thảo..."></textarea>
        </div>
        <aside class="side">
          <h2>Người đang mở</h2>
          <ul id="users" class="users"></ul>
          <div id="sharePanel" hidden>
            <h2>Chia sẻ</h2>
            <form id="share" class="row">
              <input name="username" placeholder="tên người dùng" required>
              <select name="role"><option value="editor">biên tập</option><option value="viewer">chỉ xem</option></select>
              <button>Thêm</button>
            </form>
            <ul id="members" class="muted small"></ul>
          </div>
          <h2>Trạng thái</h2>
          <dl id="stats" class="stats"></dl>
          <h2>Nhật ký sự kiện</h2>
          <ol id="log" class="log"></ol>
        </aside>
      </div>
    </section>`;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const editor = $<HTMLTextAreaElement>("editor");
  const mirror = $("mirror");
  const logList = $("log");
  const toggleNet = $<HTMLButtonElement>("toggleNet");

  const addLog = (event: string, fields: Record<string, unknown> = {}, result = "OK") => {
    const li = document.createElement("li");
    const detail = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    li.textContent = `${time()} ${event} ${detail}${result === "OK" ? "" : ` [${result}]`}`;
    if (result !== "OK") li.className = "warn";
    logList.prepend(li);
    while (logList.children.length > 200) logList.lastChild!.remove();
  };

  const client = new SyncClient({ server: location.origin, token: session.token!, docId, username: session.user, log: addLog });
  active = client;
  const cursors = new Map<string, Presence>();
  let selAnchors: [string | null, string | null] = [null, null];
  let lastText = "";
  let composing = false;
  let online = true;

  // ----- rendering -----
  const autoGrow = () => {
    editor.style.height = "auto";
    editor.style.height = `${Math.max(editor.scrollHeight, 480)}px`;
  };

  function renderCursors() {
    const text = client.doc.text();
    const marks = [...cursors.values()]
      .filter((c) => c.replica !== client.replica)
      .map((c) => ({ ...c, pos: client.doc.positionOf(c.anchor) }))
      .sort((a, b) => a.pos - b.pos);
    let html = "";
    let at = 0;
    for (const m of marks) {
      html += esc(text.slice(at, m.pos)) + `<span class="caret" style="--c:${m.color}" data-name="${esc(m.user)}"></span>`;
      at = m.pos;
    }
    mirror.innerHTML = html + esc(text.slice(at)) + "\n";
  }

  function renderUsers() {
    const list = client.users.map((u) => {
      const me = u.replica === client.replica ? " (bạn)" : "";
      return `<li><span class="dot" style="background:${u.color}"></span>${esc(u.user)}${me} <span class="muted small">${esc(u.replica)}</span></li>`;
    });
    $("users").innerHTML = list.join("") || `<li class="muted">-</li>`;
  }

  const statusText: Record<Status, string> = { online: "Trực tuyến", connecting: "Đang kết nối...", offline: "Mất kết nối" };
  function renderStatus() {
    $("conn").textContent = statusText[client.status];
    $("conn").className = `chip ${client.status}`;
    const unsaved = client.unsavedCount;
    $("saved").textContent = unsaved === 0 ? "Đã lưu trên máy chủ" : `Chưa lưu: ${unsaved} thao tác`;
    $("saved").className = `chip ${unsaved === 0 ? "online" : "pending"}`;
    $("stats").innerHTML = `
      <dt>Client ID</dt><dd>${esc(client.replica)}</dd>
      <dt>Máy chủ</dt><dd>${esc(client.serverId || "-")}</dd>
      <dt>Phiên bản máy chủ</dt><dd>${client.serverVersion}</dd>
      <dt>Phiên bản cục bộ</dt><dd>${client.doc.version}</dd>
      <dt>Số ký tự</dt><dd>${client.doc.text().length}</dd>`;
  }

  function renderText() {
    const text = client.doc.text();
    const focused = document.activeElement === editor;
    editor.value = text;
    lastText = text;
    if (focused) editor.setSelectionRange(client.doc.positionOf(selAnchors[0]), client.doc.positionOf(selAnchors[1]));
    autoGrow();
    renderCursors();
    renderStatus();
  }

  // ----- local edits -----
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  function rememberSelection() {
    selAnchors = [client.doc.anchorAt(editor.selectionStart), client.doc.anchorAt(editor.selectionEnd)];
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => client.sendCursor(selAnchors[1]), 80);
  }

  function applyLocalDiff() {
    const prev = lastText;
    const next = editor.value;
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length;
    let endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--;
      endNext--;
    }
    if (endPrev > start) client.delete(start, endPrev - start);
    if (endNext > start) client.insert(start, next.slice(start, endNext));
    lastText = next;
    rememberSelection();
    autoGrow();
    renderCursors();
    renderStatus();
  }

  editor.addEventListener("input", () => !composing && applyLocalDiff());
  editor.addEventListener("compositionstart", () => {
    composing = true;
    client.pauseRemote(); // do not change the text under the IME (Vietnamese Telex, ...)
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    applyLocalDiff();
    client.resumeRemote();
  });
  document.addEventListener("selectionchange", () => document.activeElement === editor && !composing && rememberSelection());

  // ----- sync events -----
  client.onChange = () => renderText();
  client.onSaved = () => renderStatus();
  client.onError = (code, message) => addLog("ERROR", { code, message }, "ERROR");
  client.onPresence = (users, reason) => {
    cursors.clear();
    users.forEach((u) => cursors.set(u.replica, u));
    renderUsers();
    renderCursors();
    if (reason !== "joined") addLog("PRESENCE", { reason, online: users.length });
  };
  client.onCursor = (replica, anchor) => {
    const c = cursors.get(replica);
    if (c) c.anchor = anchor;
    renderCursors();
  };

  let firstJoin = true;
  client.onStatus = () => {
    renderStatus();
    if (client.status !== "online" || !firstJoin) return;
    firstJoin = false;
    $("title").textContent = client.title;
    document.title = `${client.title} - DS04 Docs`;
    $("role").textContent = client.role === "viewer" ? "chỉ xem" : client.role === "owner" ? "chủ sở hữu" : "biên tập";
    editor.readOnly = client.role === "viewer";
    if (client.role === "owner") showSharePanel();
    renderText();
    editor.focus();
  };

  // ----- buttons -----
  toggleNet.onclick = () => {
    online = !online;
    if (online) client.connect();
    else client.disconnect("user pressed 'Ngắt kết nối'");
    toggleNet.textContent = online ? "Ngắt kết nối" : "Kết nối lại";
  };

  $("download").onclick = async () => {
    const res = await fetch(`/api/docs/${docId}/export`, { headers: { authorization: `Bearer ${session.token}` } });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = `${client.title || docId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  async function showSharePanel() {
    $("sharePanel").hidden = false;
    const showMembers = (members: { username: string; role: string }[]) =>
      ($("members").innerHTML = members.map((m) => `<li>${esc(m.username)}: ${m.role}</li>`).join(""));
    const info = await api<{ members: { username: string; role: string }[] }>(`/api/docs/${docId}`);
    showMembers(info.members);
    const form = $<HTMLFormElement>("share");
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api<{ members: { username: string; role: string }[] }>(`/api/docs/${docId}/members`, {
          method: "POST",
          body: Object.fromEntries(new FormData(form)),
        });
        showMembers(res.members);
        form.reset();
      } catch (err) {
        addLog("SHARE", { error: (err as Error).message }, "ERROR");
      }
    };
  }

  renderStatus();
  client.connect();
}
