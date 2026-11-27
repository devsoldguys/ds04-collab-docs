/**
 * Text CRDT based on RGA (Replicated Growable Array).
 *
 * Every character is an item with a globally unique ID "<replica>:<seq>".
 * An insert says "put this character right after item X".
 * A delete marks an item as a tombstone; the item stays in the list.
 *
 * Concurrent inserts after the same item are ordered by (clock, replica),
 * highest first. Every replica runs the same rule, so every replica ends
 * with the same sequence (strong eventual consistency).
 *
 * Reference: H.-G. Roh et al., "Replicated abstract data types: Building
 * blocks for collaborative applications", J. Parallel Distrib. Comput., 2011.
 */

export type InsertOp = {
  id: string; // "<client>:<seq>"
  kind: "insert";
  doc: string; // document ID
  client: string; // replica ID that created the op
  seq: number; // per-replica counter: 1, 2, 3, ...
  clock: number; // Lamport clock
  after: string | null; // item to the left at creation time; null = document start
  char: string; // exactly one UTF-16 code unit
};

export type DeleteOp = {
  id: string;
  kind: "delete";
  doc: string;
  client: string;
  seq: number;
  clock: number;
  target: string; // item to delete
};

export type Op = InsertOp | DeleteOp;

/** Highest seq integrated per replica. Summarises "which ops I already have". */
export type StateVector = Record<string, number>;

export type ApplyResult = {
  applied: Op[]; // ops integrated now (includes earlier buffered ops that became ready)
  duplicates: number; // ops ignored because they were already integrated or already buffered
  buffered: number; // ops still waiting for a missing dependency
};

type Item = { id: string; client: string; clock: number; char: string; deleted: boolean };

export const makeOpId = (client: string, seq: number) => `${client}:${seq}`;

/** True if item a must stay to the left of a new item b inserted at the same place. */
function wins(a: Item, b: { clock: number; client: string }): boolean {
  return a.clock > b.clock || (a.clock === b.clock && a.client > b.client);
}

export class TextDoc {
  private readonly items: Item[] = [];
  private readonly byId = new Map<string, Item>();
  private readonly sv = new Map<string, number>();
  private readonly pending = new Map<string, Op>();
  private readonly history: Op[] = [];
  private clock = 0;

  constructor(
    readonly docId: string,
    readonly replica: string,
  ) {}

  // ---------- reading ----------

  text(): string {
    const out: string[] = [];
    for (const it of this.items) if (!it.deleted) out.push(it.char);
    return out.join("");
  }

  /** Number of ops integrated so far. Same value on all replicas that have the same ops. */
  get version(): number {
    return this.history.length;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get itemCount(): number {
    return this.items.length;
  }

  stateVector(): StateVector {
    return Object.fromEntries(this.sv);
  }

  /** Ops this replica has and the peer (described by its state vector) does not. Causal order. */
  missingFor(peer: StateVector): Op[] {
    return this.history.filter((op) => op.seq > (peer[op.client] ?? 0));
  }

  // ---------- local edits ----------

  insertText(pos: number, text: string): Op[] {
    if (text.length === 0) return [];
    let after = pos <= 0 ? null : this.visibleItem(pos - 1).id;
    const ops: Op[] = [];
    for (const char of text.split("")) {
      const op: InsertOp = { ...this.nextMeta(), kind: "insert", after, char };
      this.integrate(op);
      ops.push(op);
      after = op.id;
    }
    return ops;
  }

  deleteText(pos: number, length: number): Op[] {
    const targets: string[] = [];
    let visible = 0;
    for (const it of this.items) {
      if (it.deleted) continue;
      if (visible >= pos && visible < pos + length) targets.push(it.id);
      visible++;
      if (visible >= pos + length) break;
    }
    return targets.map((target) => {
      const op: DeleteOp = { ...this.nextMeta(), kind: "delete", target };
      this.integrate(op);
      return op;
    });
  }

  // ---------- remote ops ----------

  /**
   * Integrate ops from another replica. Safe with duplicates (ignored) and with
   * out-of-order delivery (op waits in `pending` until its dependencies arrive).
   */
  apply(ops: Op[]): ApplyResult {
    let duplicates = 0;
    for (const op of ops) {
      if (!this.isNew(op) || this.pending.has(op.id)) duplicates++;
      else this.pending.set(op.id, op);
    }
    const applied: Op[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const [id, op] of this.pending) {
        if (!this.isReady(op)) continue;
        this.pending.delete(id);
        this.integrate(op);
        applied.push(op);
        progress = true;
      }
    }
    return { applied, duplicates, buffered: this.pending.size };
  }

  /** Remove buffered ops of one replica (server protection against a client that never fills a gap). */
  dropPending(client: string): number {
    let dropped = 0;
    for (const [id, op] of this.pending) {
      if (op.client === client) {
        this.pending.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  // ---------- cursor helpers ----------

  /** Stable anchor for a cursor position: ID of the visible item on its left (null = start). */
  anchorAt(pos: number): string | null {
    return pos <= 0 ? null : this.visibleItem(pos - 1).id;
  }

  /** Current cursor position for an anchor, after any number of remote edits. */
  positionOf(anchor: string | null): number {
    if (anchor === null) return 0;
    const target = this.byId.get(anchor);
    if (!target) return 0;
    let visible = 0;
    for (const it of this.items) {
      if (!it.deleted) visible++;
      if (it === target) return visible; // deleted anchor: position of its left neighbour
    }
    return visible;
  }

  // ---------- internals ----------

  private nextMeta() {
    const seq = (this.sv.get(this.replica) ?? 0) + 1;
    return { id: makeOpId(this.replica, seq), doc: this.docId, client: this.replica, seq, clock: this.clock + 1 };
  }

  private isNew(op: Op): boolean {
    return op.seq > (this.sv.get(op.client) ?? 0);
  }

  /** Ready = next op from that replica, and the item it refers to exists. */
  private isReady(op: Op): boolean {
    if (op.seq !== (this.sv.get(op.client) ?? 0) + 1) return false;
    if (op.kind === "insert") return op.after === null || this.byId.has(op.after);
    return this.byId.has(op.target);
  }

  private integrate(op: Op): void {
    this.clock = Math.max(this.clock, op.clock);
    this.sv.set(op.client, op.seq);
    this.history.push(op);

    if (op.kind === "delete") {
      this.byId.get(op.target)!.deleted = true;
      return;
    }

    const item: Item = { id: op.id, client: op.client, clock: op.clock, char: op.char, deleted: false };
    let i = op.after === null ? 0 : this.items.indexOf(this.byId.get(op.after)!) + 1;
    // RGA rule: skip concurrent inserts (and their descendants) that win against the new item.
    while (i < this.items.length && wins(this.items[i]!, item)) i++;
    this.items.splice(i, 0, item);
    this.byId.set(item.id, item);
  }

  private visibleItem(index: number): Item {
    let visible = 0;
    for (const it of this.items) {
      if (it.deleted) continue;
      if (visible === index) return it;
      visible++;
    }
    throw new RangeError(`position ${index} is outside the document (length ${visible})`);
  }
}
