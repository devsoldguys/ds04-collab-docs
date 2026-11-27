/**
 * Sync client: keeps a local CRDT replica in step with the server.
 * Runs in the browser and in Bun (both have a global WebSocket).
 *
 * Delivery = at-least-once + deduplication:
 * - local ops go to an outbox; one batch is in flight at a time;
 * - the batch stays in the outbox until the server sends "ack";
 * - no ack before the timeout -> send the same batch again (bounded retries);
 * - too many retries, a lost heartbeat or a closed socket -> reconnect with backoff;
 * - after reconnect: "join" with the state vector, receive missing ops, resend the outbox.
 * The server ignores ops it already has, so a resend never duplicates text.
 */
import { TextDoc, type Op } from "../shared/crdt";
import type { LogFields } from "../shared/log";
import type { ClientMsg, Presence, Role, ServerMsg } from "../shared/protocol";

export type Status = "connecting" | "online" | "offline";

export type SyncOptions = {
  server: string; // http(s)://host:port
  token: string;
  docId: string;
  username: string;
  replica?: string;
  ackTimeoutMs?: number;
  maxRetries?: number;
  heartbeatMs?: number;
  maxBackoffMs?: number;
  maxBatch?: number;
  log?: (event: string, fields?: LogFields, result?: string) => void;
};

const randomSuffix = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export class SyncClient {
  readonly doc: TextDoc;
  readonly replica: string;
  status: Status = "offline";
  role: Role | null = null;
  title = "";
  serverId = "";
  serverVersion = 0;
  users: Presence[] = [];

  onChange?: (ops: Op[]) => void; // remote ops changed the text
  onStatus?: (status: Status) => void;
  onPresence?: (users: Presence[], reason: string) => void;
  onCursor?: (replica: string, anchor: string | null) => void;
  onSaved?: () => void; // every local op is acknowledged (stored on the server)
  onError?: (code: string, message: string) => void;

  private readonly opt: Required<Omit<SyncOptions, "replica" | "log">>;
  private readonly log: NonNullable<SyncOptions["log"]>;
  private ws: WebSocket | null = null;
  private joined = false;
  private wantOnline = false;
  private outbox: Op[] = [];
  private inflight: { batch: string; ops: Op[]; tries: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  private batchCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private holdRemote = false;
  private held: Op[] = [];
  private cursorAnchor: string | null = null;

  constructor(options: SyncOptions) {
    this.opt = {
      ackTimeoutMs: 3000,
      maxRetries: 3,
      heartbeatMs: 4000,
      maxBackoffMs: 8000,
      maxBatch: 500,
      ...options,
    };
    this.log = options.log ?? (() => {});
    this.replica = options.replica ?? `${options.username}-${randomSuffix()}`;
    this.doc = new TextDoc(options.docId, this.replica);
  }

  /** Local ops not yet acknowledged by the server. */
  get unsavedCount(): number {
    return this.outbox.length;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  // ---------------- public API ----------------

  connect(): void {
    this.wantOnline = true;
    clearTimeout(this.reconnectTimer);
    if (!this.ws) this.open();
  }

  /** Stop and stay offline. Local edits still work; they wait in the outbox. */
  disconnect(reason = "client disconnect"): void {
    this.wantOnline = false;
    clearTimeout(this.reconnectTimer);
    this.forceClose(1000, reason);
  }

  /** Simulate a network failure: the socket breaks, the client reconnects by itself. */
  breakConnection(): void {
    this.forceClose(4005, "simulated network failure");
  }

  insert(pos: number, text: string): Op[] {
    this.assertCanEdit();
    return this.queue(this.doc.insertText(pos, text));
  }

  delete(pos: number, length: number): Op[] {
    this.assertCanEdit();
    return this.queue(this.doc.deleteText(pos, length));
  }

  /** A viewer must not change its local copy: the server would refuse the ops and the copies would differ. */
  private assertCanEdit(): void {
    if (this.role === "viewer") throw new Error("read-only: viewers cannot edit");
  }

  sendCursor(anchor: string | null): void {
    this.cursorAnchor = anchor;
    if (this.joined) this.send({ type: "cursor", doc: this.doc.docId, anchor });
  }

  /** Hold remote ops (for example while an IME composes a character). */
  pauseRemote(): void {
    this.holdRemote = true;
  }

  resumeRemote(): void {
    this.holdRemote = false;
    const ops = this.held;
    this.held = [];
    this.applyRemote(ops);
  }

  // ---------------- connection ----------------

  private open(): void {
    this.setStatus("connecting");
    const url = `${this.opt.server.replace(/^http/, "ws").replace(/\/$/, "")}/ws?token=${encodeURIComponent(this.opt.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      this.log("WS_OPEN", { server: this.opt.server });
      this.send({ type: "join", doc: this.doc.docId, replica: this.replica, sv: this.doc.stateVector() });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      this.handle(JSON.parse(String(ev.data)) as ServerMsg);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClosed(ev.code, ev.reason);
    };
    ws.onerror = () => {
      /* "close" always follows */
    };
  }

  /** Close now and do not wait for the close handshake (the network may be dead). */
  private forceClose(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
    this.onClosed(code, reason);
  }

  private onClosed(code: number, reason: string): void {
    this.ws = null;
    this.joined = false;
    clearInterval(this.heartbeatTimer);
    if (this.inflight) clearTimeout(this.inflight.timer);
    this.inflight = null; // the outbox keeps the ops; they go again after reconnect
    this.setStatus("offline");
    this.log("WS_CLOSE", { code, reason: reason || undefined, unsaved: this.outbox.length }, "OFFLINE");
    if (this.wantOnline) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = Math.min(this.opt.maxBackoffMs, 250 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectAttempt++;
    this.log("RECONNECT_WAIT", { attempt: this.reconnectAttempt, ms: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.wantOnline && !this.ws && this.open(), delay);
  }

  private startHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > this.opt.heartbeatMs * 3) {
        this.log("HEARTBEAT_LOST", { silent_ms: Date.now() - this.lastHeard }, "RECONNECT");
        this.forceClose(4003, "heartbeat lost");
        return;
      }
      this.send({ type: "ping", t: Date.now() });
    }, this.opt.heartbeatMs);
  }

  // ---------------- messages ----------------

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case "joined":
        this.joined = true;
        this.reconnectAttempt = 0;
        Object.assign(this, { role: msg.role, title: msg.title, serverId: msg.server, serverVersion: msg.version, users: msg.users });
        this.log("JOINED", { doc: msg.doc, role: msg.role, server: msg.server, missing: msg.ops.length, unsaved: this.outbox.length });
        this.applyRemote(msg.ops);
        this.setStatus("online");
        this.onPresence?.(msg.users, "joined");
        this.flush();
        if (this.cursorAnchor) this.sendCursor(this.cursorAnchor); // a new connection starts with no cursor on the server
        if (this.outbox.length === 0) this.onSaved?.();
        break;

      case "ack": {
        const f = this.inflight;
        if (!f || f.batch !== msg.batch) return; // late ack for an old batch: ignore
        clearTimeout(f.timer);
        this.outbox.splice(0, f.ops.length);
        this.inflight = null;
        this.serverVersion = msg.version;
        this.log("ACK", { batch: msg.batch, applied: msg.applied, duplicates: msg.duplicates, version: msg.version });
        this.flush();
        if (this.outbox.length === 0) this.onSaved?.();
        break;
      }

      case "ops":
        this.serverVersion = Math.max(this.serverVersion, msg.version);
        this.applyRemote(msg.ops);
        break;

      case "presence":
        this.users = msg.users;
        this.onPresence?.(msg.users, msg.reason);
        break;

      case "cursor":
        this.onCursor?.(msg.replica, msg.anchor);
        break;

      case "pong":
        break;

      case "error":
        this.log("SERVER_ERROR", { code: msg.code, message: msg.message, batch: msg.batch }, "ERROR");
        if (msg.batch && this.inflight?.batch === msg.batch) {
          // The server refused the batch (for example: viewer, document too large). A resend cannot succeed.
          clearTimeout(this.inflight.timer);
          this.outbox.splice(0, this.inflight.ops.length);
          this.inflight = null;
          this.log("DELIVERY_ERROR", { batch: msg.batch, code: msg.code }, "DROPPED");
        }
        this.onError?.(msg.code, msg.message);
        break;
    }
  }

  private applyRemote(ops: Op[]): void {
    if (ops.length === 0) return;
    if (this.holdRemote) {
      this.held.push(...ops);
      return;
    }
    const res = this.doc.apply(ops);
    this.log("REMOTE_OPS", { received: ops.length, applied: res.applied.length, duplicates: res.duplicates, buffered: res.buffered });
    if (res.applied.length > 0) this.onChange?.(res.applied);
  }

  // ---------------- outbox ----------------

  private queue(ops: Op[]): Op[] {
    this.outbox.push(...ops);
    this.flush();
    return ops;
  }

  private flush(): void {
    if (!this.joined || this.inflight || this.outbox.length === 0) return;
    const ops = this.outbox.slice(0, this.opt.maxBatch);
    this.inflight = { batch: `${this.replica.slice(-8)}-${++this.batchCounter}`, ops, tries: 0 };
    this.transmit();
  }

  private transmit(): void {
    const f = this.inflight!;
    f.tries++;
    this.send({ type: "ops", doc: this.doc.docId, batch: f.batch, ops: f.ops });
    this.log("SEND", { batch: f.batch, ops: f.ops.length, try: f.tries });
    f.timer = setTimeout(() => {
      if (this.inflight !== f) return;
      if (f.tries >= this.opt.maxRetries) {
        this.log("ACK_TIMEOUT", { batch: f.batch, tries: f.tries }, "RECONNECT");
        this.forceClose(4002, "ack timeout");
      } else {
        this.log("ACK_TIMEOUT", { batch: f.batch, tries: f.tries }, "RETRY");
        this.transmit();
      }
    }, this.opt.ackTimeoutMs);
  }

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }
}

/** Wait until a condition is true (polling). Used by the CLI and by tests. */
export async function waitUntil(check: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
