/**
 * A room = one open document on the server.
 * The room keeps the server replica of the CRDT in memory, the list of
 * connected clients, and writes every integrated op to the store before
 * it acknowledges or broadcasts the op.
 */
import type { ServerWebSocket } from "bun";
import { TextDoc, type ApplyResult, type Op } from "../shared/crdt";
import type { Logger } from "../shared/log";
import type { Presence, Role } from "../shared/protocol";
import type { Store } from "./store";

export type WsData = {
  conn: string; // connection ID, for logs
  user: string; // authenticated username (from the token)
  replica: string | null; // set by "join"
  doc: string | null;
  role: Role | null;
  color: string;
  anchor: string | null; // cursor anchor
  lastSeen: number; // for heartbeat timeout
};
export type Socket = ServerWebSocket<WsData>;

export class Room {
  readonly doc: TextDoc;
  readonly sockets = new Set<Socket>();

  constructor(
    readonly id: string,
    private readonly store: Store,
    log: Logger,
  ) {
    const started = performance.now();
    const ops = store.loadOps(id);
    this.doc = new TextDoc(id, "server");
    this.doc.apply(ops);
    log("ROOM_LOAD", { doc: id, ops: ops.length, chars: this.doc.text().length, ms: Math.round(performance.now() - started) });
  }

  presence(): Presence[] {
    return [...this.sockets].map((ws) => ({ replica: ws.data.replica!, user: ws.data.user, color: ws.data.color, anchor: ws.data.anchor }));
  }

  /** Integrate ops into the server replica and persist the new ones. */
  submit(ops: Op[]): ApplyResult {
    const result = this.doc.apply(ops);
    if (result.applied.length > 0) {
      const firstN = this.doc.version - result.applied.length + 1;
      this.store.appendOps(this.id, firstN, result.applied, this.doc.text());
    }
    return result;
  }

  /** Socket that already uses this replica ID (an old connection after a network break). */
  findReplica(replica: string): Socket | undefined {
    for (const ws of this.sockets) if (ws.data.replica === replica) return ws;
    return undefined;
  }
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  get(docId: string): Room {
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Room(docId, this.store, this.log);
      this.rooms.set(docId, room);
    }
    return room;
  }

  peek(docId: string): Room | undefined {
    return this.rooms.get(docId);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }
}
