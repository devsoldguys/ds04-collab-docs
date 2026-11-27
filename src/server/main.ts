/**
 * Collaboration server: HTTP API (accounts, documents, sharing) + WebSocket (real-time sync).
 * Start: bun src/server/main.ts
 */
import index from "../client/web/index.html";
import { makeLogger } from "../shared/log";
import {
  DOC_ID_RE,
  USERNAME_RE,
  parseClientMessage,
  type CursorMsg,
  type ErrorCode,
  type JoinMsg,
  type OpsMsg,
  type RemoteOpsMsg,
  type ServerMsg,
} from "../shared/protocol";
import { hashPassword, signToken, verifyPassword, verifyToken } from "./auth";
import { loadConfig } from "./config";
import { Rooms, type Room, type Socket, type WsData } from "./room";
import { Store } from "./store";

const cfg = loadConfig();
const log = makeLogger(cfg.serverId);
const store = new Store(cfg.dbPath);
const rooms = new Rooms(store, log);
const startedAt = Date.now();

const topic = (doc: string) => `doc:${doc}`;
const COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83", "#c5221f", "#b06000"];
const colorOf = (user: string) => COLORS[[...user].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;
const randomId = (len: number) =>
  [...crypto.getRandomValues(new Uint8Array(len))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

// ---------------- HTTP helpers ----------------

const json = (data: unknown, status = 200) => Response.json(data, { status });
const readJson = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
function requireUser(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  return verifyToken(header.startsWith("Bearer ") ? header.slice(7) : null, cfg.tokenSecret);
}

// ---------------- WebSocket helpers ----------------

const send = (ws: Socket, msg: ServerMsg) => ws.send(JSON.stringify(msg));

function fail(ws: Socket, code: ErrorCode, message: string, batch?: string) {
  send(ws, { type: "error", code, message, batch });
  log("WS_ERROR", { conn: ws.data.conn, user: ws.data.user, code, detail: message }, "REJECTED");
}

function broadcastPresence(room: Room, reason: string) {
  server.publish(topic(room.id), JSON.stringify({ type: "presence", users: room.presence(), reason } satisfies ServerMsg));
}

function leave(ws: Socket, reason: string) {
  const docId = ws.data.doc;
  if (!docId) return;
  ws.data.doc = null;
  const room = rooms.peek(docId);
  if (!room?.sockets.delete(ws)) return;
  try {
    ws.unsubscribe(topic(docId));
  } catch {
    /* socket already closed */
  }
  log("LEAVE", { conn: ws.data.conn, replica: ws.data.replica, doc: docId, reason, online: room.sockets.size });
  broadcastPresence(room, `${ws.data.user} left (${reason})`);
}

function handleJoin(ws: Socket, msg: JoinMsg) {
  const doc = store.getDoc(msg.doc);
  if (!doc) return fail(ws, "NOT_FOUND", "document not found");
  const role = store.getRole(msg.doc, ws.data.user);
  if (!role) return fail(ws, "FORBIDDEN", "you have no access to this document");
  if (!msg.replica.startsWith(`${ws.data.user}-`)) return fail(ws, "BAD_REPLICA", "replica ID must start with '<your username>-'");

  if (ws.data.doc) leave(ws, "rejoin");
  const room = rooms.get(msg.doc);
  const old = room.findReplica(msg.replica);
  if (old && old !== ws) {
    // Same client, new connection (for example after a network break). Drop the stale socket.
    leave(old, "replaced by new connection");
    old.close(4001, "replaced by new connection");
  }

  const usedColors = new Set([...room.sockets].map((s) => s.data.color));
  const color = COLORS.find((c) => !usedColors.has(c)) ?? colorOf(ws.data.user); // distinct color per person in the room
  Object.assign(ws.data, { replica: msg.replica, doc: msg.doc, role, color });
  room.sockets.add(ws);
  ws.subscribe(topic(msg.doc));
  const missing = room.doc.missingFor(msg.sv);
  send(ws, {
    type: "joined",
    doc: msg.doc,
    title: doc.title,
    role,
    server: cfg.serverId,
    version: room.doc.version,
    ops: missing,
    users: room.presence(),
  });
  log("JOIN", { conn: ws.data.conn, replica: msg.replica, doc: msg.doc, role, sent_missing: missing.length, version: room.doc.version, online: room.sockets.size });
  broadcastPresence(room, `${ws.data.user} joined`);
}

function handleOps(ws: Socket, msg: OpsMsg) {
  const room = ws.data.doc ? rooms.peek(ws.data.doc) : undefined;
  if (!room || msg.doc !== ws.data.doc) return fail(ws, "NOT_JOINED", "join the document first", msg.batch);
  if (ws.data.role === "viewer") return fail(ws, "FORBIDDEN", "viewers cannot edit", msg.batch);
  if (msg.ops.some((op) => op.client !== ws.data.replica || op.doc !== msg.doc))
    return fail(ws, "BAD_REPLICA", "ops must use your own replica ID and the joined document", msg.batch);
  const inserts = msg.ops.filter((op) => op.kind === "insert").length;
  if (room.doc.itemCount + inserts > cfg.maxDocChars)
    return fail(ws, "DOC_TOO_LARGE", `document limit is ${cfg.maxDocChars} characters`, msg.batch);

  const started = performance.now();
  const res = room.submit(msg.ops);
  if (res.buffered > cfg.maxPendingOps) {
    room.doc.dropPending(ws.data.replica!);
    return fail(ws, "TOO_MANY_PENDING", "too many ops wait for missing dependencies", msg.batch);
  }

  send(ws, { type: "ack", batch: msg.batch, applied: res.applied.length, duplicates: res.duplicates, buffered: res.buffered, version: room.doc.version });
  if (res.applied.length > 0) {
    const out: RemoteOpsMsg = { type: "ops", doc: room.id, from: ws.data.replica!, ops: res.applied, version: room.doc.version };
    ws.publish(topic(room.id), JSON.stringify(out)); // all other clients in the room
    const foreign = res.applied.filter((op) => op.client !== ws.data.replica);
    if (foreign.length > 0) send(ws, { ...out, ops: foreign });
  }
  const result = res.applied.length === 0 && res.duplicates > 0 ? "DUPLICATE" : res.buffered > 0 ? "BUFFERED" : "OK";
  log(
    "OPS",
    {
      conn: ws.data.conn,
      replica: ws.data.replica,
      doc: room.id,
      batch: msg.batch,
      received: msg.ops.length,
      applied: res.applied.length,
      duplicates: res.duplicates,
      buffered: res.buffered,
      version: room.doc.version,
      ms: (performance.now() - started).toFixed(2),
    },
    result,
  );
}

function handleCursor(ws: Socket, msg: CursorMsg) {
  if (!ws.data.doc || msg.doc !== ws.data.doc) return;
  ws.data.anchor = msg.anchor;
  ws.publish(topic(msg.doc), JSON.stringify({ type: "cursor", replica: ws.data.replica!, anchor: msg.anchor } satisfies ServerMsg));
}

// ---------------- server ----------------

const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  development: !cfg.production,

  routes: {
    "/": index,

    "/api/health": () =>
      json({
        server: cfg.serverId,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        memoryMB: Math.round(process.memoryUsage().rss / 1e6),
        cpuMicros: process.cpuUsage(),
        rooms: rooms.all().map((r) => ({ doc: r.id, clients: r.sockets.size, version: r.doc.version, chars: r.doc.text().length })),
      }),

    "/api/register": {
      POST: async (req) => {
        const body = await readJson(req);
        const username = String(body?.username ?? "").trim().toLowerCase();
        const password = String(body?.password ?? "");
        if (!USERNAME_RE.test(username)) return json({ error: "username: 3-32 characters a-z, 0-9, _" }, 400);
        if (password.length < 8 || password.length > 128) return json({ error: "password: 8-128 characters" }, 400);
        if (!store.createUser(username, await hashPassword(password))) {
          log("REGISTER", { user: username }, "CONFLICT");
          return json({ error: "username already exists" }, 409);
        }
        log("REGISTER", { user: username });
        return json({ username, token: signToken(username, cfg.tokenSecret, cfg.tokenTtlMs) }, 201);
      },
    },

    "/api/login": {
      POST: async (req) => {
        const body = await readJson(req);
        const username = String(body?.username ?? "").trim().toLowerCase();
        const hash = USERNAME_RE.test(username) ? store.getPasswordHash(username) : null;
        if (!hash || !(await verifyPassword(String(body?.password ?? ""), hash))) {
          log("LOGIN", { user: username.slice(0, 32) }, "UNAUTHORIZED");
          return json({ error: "wrong username or password" }, 401);
        }
        log("LOGIN", { user: username });
        return json({ username, token: signToken(username, cfg.tokenSecret, cfg.tokenTtlMs) });
      },
    },

    "/api/docs": {
      GET: (req) => {
        const user = requireUser(req);
        return user ? json(store.listDocs(user)) : json({ error: "login required" }, 401);
      },
      POST: async (req) => {
        const user = requireUser(req);
        if (!user) return json({ error: "login required" }, 401);
        const title = String((await readJson(req))?.title ?? "").trim();
        if (title.length < 1 || title.length > 100) return json({ error: "title: 1-100 characters" }, 400);
        const id = randomId(10);
        store.createDoc(id, title, user);
        log("DOC_CREATE", { user, doc: id, title });
        return json({ id, title }, 201);
      },
    },

    "/api/docs/:id": {
      GET: (req) => {
        const user = requireUser(req);
        if (!user) return json({ error: "login required" }, 401);
        const doc = DOC_ID_RE.test(req.params.id) ? store.getDoc(req.params.id) : null;
        const role = doc ? store.getRole(doc.id, user) : null;
        if (!doc || !role) return json({ error: "document not found" }, 404);
        return json({ id: doc.id, title: doc.title, owner: doc.owner, role, members: store.members(doc.id) });
      },
    },

    "/api/docs/:id/members": {
      POST: async (req) => {
        const user = requireUser(req);
        if (!user) return json({ error: "login required" }, 401);
        const docId = req.params.id;
        if (!DOC_ID_RE.test(docId) || store.getRole(docId, user) !== "owner") return json({ error: "only the owner can share" }, 403);
        const body = await readJson(req);
        const member = String(body?.username ?? "").trim().toLowerCase();
        const role = body?.role;
        if (role !== "editor" && role !== "viewer") return json({ error: "role: editor or viewer" }, 400);
        if (member === user || !store.userExists(member)) return json({ error: "user not found" }, 404);
        store.setMember(docId, member, role);
        log("SHARE", { owner: user, doc: docId, member, role });
        return json({ members: store.members(docId) });
      },
    },

    "/api/docs/:id/export": {
      GET: (req) => {
        const user = requireUser(req);
        const docId = req.params.id;
        const doc = user && DOC_ID_RE.test(docId) && store.getRole(docId, user) ? store.getDoc(docId) : null;
        if (!doc) return json({ error: "document not found" }, 404);
        const text = rooms.peek(docId)?.doc.text() ?? doc.content;
        return new Response(text, {
          headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${docId}.txt"` },
        });
      },
    },
  },

  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    // Browsers cannot set headers on a WebSocket, so the token comes in the query string.
    const user = verifyToken(url.searchParams.get("token"), cfg.tokenSecret);
    if (!user || !store.userExists(user)) {
      log("WS_REJECT", { ip: srv.requestIP(req)?.address }, "UNAUTHORIZED");
      return new Response("unauthorized", { status: 401 });
    }
    const data: WsData = { conn: randomId(6), user, replica: null, doc: null, role: null, color: colorOf(user), anchor: null, lastSeen: Date.now() };
    return srv.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade required", { status: 400 });
  },

  websocket: {
    data: {} as WsData,
    maxPayloadLength: cfg.maxMessageBytes * 4, // hard limit: Bun closes the socket. Soft limit below answers with an error.
    idleTimeout: 60,

    open(ws) {
      log("WS_OPEN", { conn: ws.data.conn, user: ws.data.user });
    },

    message(ws, raw) {
      ws.data.lastSeen = Date.now();
      const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
      if (size > cfg.maxMessageBytes) return fail(ws, "TOO_LARGE", `message is ${size} bytes, limit is ${cfg.maxMessageBytes}`);
      const parsed = parseClientMessage(typeof raw === "string" ? raw : raw.toString());
      if (!parsed.ok) return fail(ws, "BAD_MESSAGE", parsed.error);
      const msg = parsed.msg;
      switch (msg.type) {
        case "ping":
          send(ws, { type: "pong", t: msg.t, server: cfg.serverId });
          return;
        case "join":
          return handleJoin(ws, msg);
        case "ops":
          return handleOps(ws, msg);
        case "cursor":
          return handleCursor(ws, msg);
      }
    },

    close(ws, code) {
      leave(ws, `connection closed code=${code}`);
      log("WS_CLOSE", { conn: ws.data.conn, user: ws.data.user, code });
    },
  },
});

// Heartbeat: a client that sends nothing (not even "ping") for heartbeatTimeoutMs is offline.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.all()) {
    for (const ws of room.sockets) {
      if (now - ws.data.lastSeen <= cfg.heartbeatTimeoutMs) continue;
      log("HEARTBEAT_TIMEOUT", { conn: ws.data.conn, replica: ws.data.replica, doc: room.id, silent_ms: now - ws.data.lastSeen }, "OFFLINE");
      leave(ws, "heartbeat timeout");
      ws.close(4000, "heartbeat timeout");
    }
  }
}, 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("SERVER_STOP", { signal });
    server.stop(true);
    store.close();
    process.exit(0);
  });
}

log("SERVER_START", { url: server.url.href, db: cfg.dbPath, pid: process.pid });
