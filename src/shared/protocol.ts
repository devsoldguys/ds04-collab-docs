/**
 * WebSocket message formats (JSON) shared by server, web client and CLI client.
 * Every message has a "type". The server validates every client message with
 * parseClientMessage() before it uses it.
 */
import type { Op, StateVector } from "./crdt";

export type Role = "owner" | "editor" | "viewer";

export type Presence = { replica: string; user: string; color: string; anchor: string | null };

// ----- client -> server -----
export type JoinMsg = { type: "join"; doc: string; replica: string; sv: StateVector };
export type OpsMsg = { type: "ops"; doc: string; batch: string; ops: Op[] };
export type CursorMsg = { type: "cursor"; doc: string; anchor: string | null };
export type PingMsg = { type: "ping"; t: number };
export type ClientMsg = JoinMsg | OpsMsg | CursorMsg | PingMsg;

// ----- server -> client -----
export type JoinedMsg = {
  type: "joined";
  doc: string;
  title: string;
  role: Role;
  server: string; // server node ID
  version: number; // ops integrated on the server
  ops: Op[]; // ops the client is missing
  users: Presence[];
};
export type AckMsg = { type: "ack"; batch: string; applied: number; duplicates: number; buffered: number; version: number };
export type RemoteOpsMsg = { type: "ops"; doc: string; from: string; ops: Op[]; version: number };
export type PresenceMsg = { type: "presence"; users: Presence[]; reason: string };
export type CursorUpdateMsg = { type: "cursor"; replica: string; anchor: string | null };
export type PongMsg = { type: "pong"; t: number; server: string };
export type ErrorMsg = { type: "error"; code: ErrorCode; message: string; batch?: string };
export type ServerMsg = JoinedMsg | AckMsg | RemoteOpsMsg | PresenceMsg | CursorUpdateMsg | PongMsg | ErrorMsg;

export type ErrorCode =
  | "BAD_MESSAGE"
  | "TOO_LARGE"
  | "NOT_JOINED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REPLICA"
  | "DOC_TOO_LARGE"
  | "TOO_MANY_PENDING";

// ----- naming rules -----
export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const REPLICA_RE = /^[a-z0-9_]{3,32}-[a-z0-9]{4,16}$/; // "<username>-<random>"
export const DOC_ID_RE = /^[a-z0-9]{6,32}$/;
const ITEM_ID_RE = /^[a-z0-9_]{3,32}-[a-z0-9]{4,16}:[1-9][0-9]{0,14}$/;
const MAX_CLOCK = 2 ** 50;

export const LIMITS = {
  maxOpsPerMessage: 1000,
  maxBatchId: 64,
};

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isItemId = (v: unknown): v is string => typeof v === "string" && ITEM_ID_RE.test(v);

/** Returns an error text, or null if the op is well formed. */
export function validateOp(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "op is not an object";
  const op = raw as Record<string, unknown>;
  if (typeof op.client !== "string" || !REPLICA_RE.test(op.client)) return "bad client";
  if (!isInt(op.seq, 1, 1e15)) return "bad seq";
  if (op.id !== `${op.client}:${op.seq}`) return "id must be <client>:<seq>";
  if (typeof op.doc !== "string" || !DOC_ID_RE.test(op.doc)) return "bad doc";
  if (!isInt(op.clock, 1, MAX_CLOCK)) return "bad clock";
  if (op.kind === "insert") {
    if (op.after !== null && !isItemId(op.after)) return "bad after";
    if (typeof op.char !== "string" || op.char.length !== 1) return "char must be one UTF-16 unit";
    return null;
  }
  if (op.kind === "delete") return isItemId(op.target) ? null : "bad target";
  return "bad kind";
}

function isStateVector(v: unknown): v is StateVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 10_000 && entries.every(([k, n]) => REPLICA_RE.test(k) && isInt(n, 0, 1e15));
}

/** Parse and validate one client message. */
export function parseClientMessage(text: string): { ok: true; msg: ClientMsg } | { ok: false; error: string } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "message is not an object" };

  switch (raw.type) {
    case "join":
      if (typeof raw.doc !== "string" || !DOC_ID_RE.test(raw.doc)) return { ok: false, error: "bad doc" };
      if (typeof raw.replica !== "string" || !REPLICA_RE.test(raw.replica)) return { ok: false, error: "bad replica" };
      if (!isStateVector(raw.sv)) return { ok: false, error: "bad sv" };
      return { ok: true, msg: { type: "join", doc: raw.doc, replica: raw.replica, sv: raw.sv } };
    case "ops": {
      if (typeof raw.doc !== "string") return { ok: false, error: "bad doc" };
      if (typeof raw.batch !== "string" || raw.batch.length === 0 || raw.batch.length > LIMITS.maxBatchId)
        return { ok: false, error: "bad batch" };
      if (!Array.isArray(raw.ops) || raw.ops.length === 0) return { ok: false, error: "ops must be a non-empty array" };
      if (raw.ops.length > LIMITS.maxOpsPerMessage) return { ok: false, error: `max ${LIMITS.maxOpsPerMessage} ops per message` };
      for (const op of raw.ops) {
        const err = validateOp(op);
        if (err) return { ok: false, error: err };
      }
      return { ok: true, msg: { type: "ops", doc: raw.doc, batch: raw.batch, ops: raw.ops } };
    }
    case "cursor":
      if (typeof raw.doc !== "string") return { ok: false, error: "bad doc" };
      if (raw.anchor !== null && !isItemId(raw.anchor)) return { ok: false, error: "bad anchor" };
      return { ok: true, msg: { type: "cursor", doc: raw.doc, anchor: raw.anchor } };
    case "ping":
      return { ok: true, msg: { type: "ping", t: isInt(raw.t, 0, Number.MAX_SAFE_INTEGER) ? raw.t : 0 } };
    default:
      return { ok: false, error: "unknown type" };
  }
}
