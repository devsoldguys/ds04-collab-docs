/**
 * Durable storage (SQLite, WAL mode).
 * - users:   accounts with argon2id password hashes
 * - docs:    document metadata + last saved text (for export and the document list)
 * - members: access control (owner / editor / viewer)
 * - ops:     append-only operation log per document. The server rebuilds a document
 *            after a restart by replaying this log. UNIQUE(doc_id, client, seq) makes
 *            a duplicate op impossible, even if the in-memory check fails.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Op } from "../shared/crdt";
import type { Role } from "../shared/protocol";

export type DocRow = { id: string; title: string; owner: string; created_at: number; updated_at: number; content: string };

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        username   TEXT PRIMARY KEY,
        pass_hash  TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        owner      TEXT NOT NULL REFERENCES users(username),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content    TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS members (
        doc_id   TEXT NOT NULL REFERENCES docs(id),
        username TEXT NOT NULL REFERENCES users(username),
        role     TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        PRIMARY KEY (doc_id, username)
      );
      CREATE TABLE IF NOT EXISTS ops (
        doc_id TEXT NOT NULL REFERENCES docs(id),
        n      INTEGER NOT NULL,
        client TEXT NOT NULL,
        seq    INTEGER NOT NULL,
        body   TEXT NOT NULL,
        PRIMARY KEY (doc_id, n),
        UNIQUE (doc_id, client, seq)
      );
    `);
  }

  // ----- users -----
  createUser(username: string, passHash: string): boolean {
    const res = this.db
      .query("INSERT OR IGNORE INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)")
      .run(username, passHash, Date.now());
    return res.changes === 1;
  }

  getPasswordHash(username: string): string | null {
    const row = this.db.query<{ pass_hash: string }, [string]>("SELECT pass_hash FROM users WHERE username = ?").get(username);
    return row?.pass_hash ?? null;
  }

  userExists(username: string): boolean {
    return this.getPasswordHash(username) !== null;
  }

  // ----- documents and access control -----
  createDoc(id: string, title: string, owner: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("INSERT INTO docs (id, title, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, title, owner, now, now);
      this.db.query("INSERT INTO members (doc_id, username, role) VALUES (?, ?, 'owner')").run(id, owner);
    })();
  }

  getDoc(id: string): DocRow | null {
    return this.db.query<DocRow, [string]>("SELECT * FROM docs WHERE id = ?").get(id);
  }

  listDocs(username: string) {
    return this.db
      .query<{ id: string; title: string; owner: string; role: Role; updated_at: number }, [string]>(
        `SELECT d.id, d.title, d.owner, m.role, d.updated_at
         FROM docs d JOIN members m ON m.doc_id = d.id
         WHERE m.username = ? ORDER BY d.updated_at DESC`,
      )
      .all(username);
  }

  getRole(docId: string, username: string): Role | null {
    const row = this.db
      .query<{ role: Role }, [string, string]>("SELECT role FROM members WHERE doc_id = ? AND username = ?")
      .get(docId, username);
    return row?.role ?? null;
  }

  setMember(docId: string, username: string, role: Exclude<Role, "owner">): void {
    this.db
      .query("INSERT INTO members (doc_id, username, role) VALUES (?, ?, ?) ON CONFLICT (doc_id, username) DO UPDATE SET role = excluded.role")
      .run(docId, username, role);
  }

  members(docId: string) {
    return this.db.query<{ username: string; role: Role }, [string]>("SELECT username, role FROM members WHERE doc_id = ? ORDER BY username").all(docId);
  }

  // ----- operation log -----
  loadOps(docId: string): Op[] {
    return this.db
      .query<{ body: string }, [string]>("SELECT body FROM ops WHERE doc_id = ? ORDER BY n")
      .all(docId)
      .map((r) => JSON.parse(r.body) as Op);
  }

  /** Append integrated ops (n = firstN, firstN+1, ...) and save the current text, in one transaction. */
  appendOps(docId: string, firstN: number, ops: Op[], content: string): void {
    const insert = this.db.query("INSERT INTO ops (doc_id, n, client, seq, body) VALUES (?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      ops.forEach((op, i) => insert.run(docId, firstN + i, op.client, op.seq, JSON.stringify(op)));
      this.db.query("UPDATE docs SET content = ?, updated_at = ? WHERE id = ?").run(content, Date.now(), docId);
    })();
  }

  close(): void {
    this.db.close();
  }
}
