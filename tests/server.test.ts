// Server-side tests: accounts, documents, access control, security, crash recovery, duplicate and out-of-order ops.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncClient } from "../src/client/sync-client";
import { TextDoc } from "../src/shared/crdt";
import { converged, exportText, newDoc, openClient, PASSWORD, post, rawSocket, register, startServer, waitUntil, type TestServer } from "./helpers";

let srv: TestServer;
const tok: Record<string, string> = {};
const opened: SyncClient[] = [];

beforeAll(async () => {
  srv = await startServer();
  for (const name of ["alice", "bob", "carol", "eve"]) tok[name] = await register(srv, name);
});
afterAll(async () => {
  opened.forEach((c) => c.disconnect());
  await srv.kill();
});

/** Build valid ops for a replica without a SyncClient (protocol-level tests). */
const localReplica = (docId: string, replica: string) => new TextDoc(docId, replica);

describe("Functional: accounts and documents", () => {
  test("[F1] register and log in; wrong password, duplicate name and bad name are refused", async () => {
    const reg = await post(`${srv.url}/api/register`, { username: "frank", password: PASSWORD });
    expect(reg.status).toBe(201);
    expect((await post(`${srv.url}/api/login`, { username: "frank", password: PASSWORD })).status).toBe(200);
    expect((await post(`${srv.url}/api/login`, { username: "frank", password: "wrong-password" })).status).toBe(401);
    expect((await post(`${srv.url}/api/register`, { username: "frank", password: PASSWORD })).status).toBe(409);
    expect((await post(`${srv.url}/api/register`, { username: "Bad Name!", password: PASSWORD })).status).toBe(400);
  });

  test("[F2] create a document, list it, read its metadata", async () => {
    const created = await post(`${srv.url}/api/docs`, { title: "Báo cáo nhóm 13" }, tok.alice);
    expect(created.status).toBe(201);
    const list = (await (await fetch(`${srv.url}/api/docs`, { headers: { authorization: `Bearer ${tok.alice}` } })).json()) as any[];
    expect(list.find((d) => d.id === created.body.id)).toMatchObject({ title: "Báo cáo nhóm 13", role: "owner" });
    const meta = (await (await fetch(`${srv.url}/api/docs/${created.body.id}`, { headers: { authorization: `Bearer ${tok.alice}` } })).json()) as any;
    expect(meta.members).toEqual([{ username: "alice", role: "owner" }]);
  });

  test("[F3] the owner shares a document; other users cannot share it", async () => {
    const docId = await newDoc(srv, tok.alice!, { bob: "editor" });
    const bobList = (await (await fetch(`${srv.url}/api/docs`, { headers: { authorization: `Bearer ${tok.bob}` } })).json()) as any[];
    expect(bobList.some((d) => d.id === docId && d.role === "editor")).toBe(true);
    const byBob = await post(`${srv.url}/api/docs/${docId}/members`, { username: "carol", role: "editor" }, tok.bob);
    expect(byBob.status).toBe(403);
  });

  test("[F8] the document is saved: export returns the latest text and SQLite holds it", async () => {
    const docId = await newDoc(srv, tok.alice!);
    const a = await openClient(srv, tok.alice!, "alice", docId);
    opened.push(a);
    a.insert(0, "Nội dung đã lưu");
    await converged([a]);
    expect(await exportText(srv, tok.alice!, docId)).toBe("Nội dung đã lưu");
    const db = new Database(srv.dbPath, { readonly: true });
    const row = db.query("SELECT content FROM docs WHERE id = ?").get(docId) as { content: string };
    const opsCount = db.query("SELECT COUNT(*) AS n FROM ops WHERE doc_id = ?").get(docId) as { n: number };
    db.close();
    expect(row.content).toBe("Nội dung đã lưu");
    expect(opsCount.n).toBe("Nội dung đã lưu".length);
  });
});

describe("Security", () => {
  test("[S1] WebSocket without a valid token is refused (401)", async () => {
    expect((await fetch(`${srv.url}/ws`)).status).toBe(401);
    expect((await fetch(`${srv.url}/ws?token=forged.token`)).status).toBe(401);
    const tampered = tok.alice!.slice(0, -2) + (tok.alice!.endsWith("A") ? "BB" : "AA");
    expect((await fetch(`${srv.url}/ws?token=${tampered}`)).status).toBe(401);
    expect((await fetch(`${srv.url}/api/docs`)).status).toBe(401);
  });

  test("[S2] a non-member cannot join; a viewer cannot edit", async () => {
    const docId = await newDoc(srv, tok.alice!, { bob: "viewer" });

    const eve = await rawSocket(srv, tok.eve!);
    eve.send({ type: "join", doc: docId, replica: "eve-aaaa1111", sv: {} });
    expect((await eve.next("error")).code).toBe("FORBIDDEN");
    eve.close();

    const bob = await rawSocket(srv, tok.bob!);
    bob.send({ type: "join", doc: docId, replica: "bob-bbbb2222", sv: {} });
    expect((await bob.next("joined")).role).toBe("viewer");
    const ops = localReplica(docId, "bob-bbbb2222").insertText(0, "hack");
    bob.send({ type: "ops", doc: docId, batch: "b1", ops });
    expect((await bob.next("error")).code).toBe("FORBIDDEN");
    bob.close();
    expect(await exportText(srv, tok.alice!, docId)).toBe("");
  });

  test("[S3] a client cannot use another user's identity (replica ID / op client ID)", async () => {
    const docId = await newDoc(srv, tok.alice!, { eve: "editor" });
    const eve = await rawSocket(srv, tok.eve!);
    eve.send({ type: "join", doc: docId, replica: "alice-cccc3333", sv: {} });
    expect((await eve.next("error")).code).toBe("BAD_REPLICA");

    eve.send({ type: "join", doc: docId, replica: "eve-dddd4444", sv: {} });
    await eve.next("joined");
    const forged = localReplica(docId, "alice-cccc3333").insertText(0, "fake");
    eve.send({ type: "ops", doc: docId, batch: "f1", ops: forged });
    expect((await eve.next("error")).code).toBe("BAD_REPLICA");
    eve.close();
    expect(await exportText(srv, tok.alice!, docId)).toBe("");
  });

  test("[S4] malformed JSON, invalid ops and oversized messages are refused; the connection stays usable", async () => {
    const docId = await newDoc(srv, tok.alice!);
    const s = await rawSocket(srv, tok.alice!);
    s.send("{not json");
    expect((await s.next("error")).code).toBe("BAD_MESSAGE");
    s.send({ type: "join", doc: docId, replica: "alice-eeee5555", sv: {} });
    await s.next("joined");
    const [op] = localReplica(docId, "alice-eeee5555").insertText(0, "a");
    s.send({ type: "ops", doc: docId, batch: "x1", ops: [{ ...op, char: "too long" }] });
    expect((await s.next("error")).code).toBe("BAD_MESSAGE");
    s.send({ type: "ops", doc: docId, batch: "x2", ops: [{ ...op, after: "../../etc/passwd" }] });
    expect((await s.next("error")).code).toBe("BAD_MESSAGE");
    s.send(JSON.stringify({ type: "ping", t: 1, pad: "x".repeat(300_000) }));
    expect((await s.next("error")).code).toBe("TOO_LARGE");
    s.send({ type: "ping", t: 42 });
    expect((await s.next("pong")).t).toBe(42);
    s.close();
    await srv.waitForLog(/WS_ERROR .*code=TOO_LARGE.*result=REJECTED/);
  });

  test("[S5] passwords are stored as argon2id hashes, never as plaintext", () => {
    const db = new Database(srv.dbPath, { readonly: true });
    const rows = db.query("SELECT pass_hash FROM users").all() as { pass_hash: string }[];
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.pass_hash.startsWith("$argon2id$")).toBe(true);
      expect(r.pass_hash).not.toContain(PASSWORD);
    }
  });
});

describe("Fault tolerance and recovery", () => {
  test("[R2] the server crashes (SIGKILL) and restarts: document restored, clients reconnect and converge", async () => {
    const own = await startServer();
    const t = { alice: await register(own, "alice"), bob: await register(own, "bob"), carol: await register(own, "carol") };
    const docId = await newDoc(own, t.alice, { bob: "editor", carol: "editor" });
    const clients = [await openClient(own, t.alice, "alice", docId), await openClient(own, t.bob, "bob", docId), await openClient(own, t.carol, "carol", docId)];
    const [a, b, c] = clients as [SyncClient, SyncClient, SyncClient];
    a.insert(0, "Before the crash.");
    await converged(clients);

    await own.kill("SIGKILL"); // no shutdown hook runs
    await waitUntil(() => clients.every((x) => x.status !== "online"), 3000, "clients notice the crash");
    b.insert(b.doc.text().length, " Bob wrote this while the server was down.");

    await own.restart();
    await own.waitForLog(/ROOM_LOAD .*ops=17/); // replayed from the op log
    c.insert(0, ">> ");
    const text = await converged(clients, 10_000);
    expect(text).toBe(">> Before the crash. Bob wrote this while the server was down.");
    expect(await exportText(own, t.alice, docId)).toBe(text);
    clients.forEach((x) => x.disconnect());
    await own.kill();
  });

  test("[R3] the same batch arrives twice: the server applies it once", async () => {
    const docId = await newDoc(srv, tok.alice!);
    const s = await rawSocket(srv, tok.alice!);
    s.send({ type: "join", doc: docId, replica: "alice-ffff6666", sv: {} });
    await s.next("joined");
    const ops = localReplica(docId, "alice-ffff6666").insertText(0, "once");
    s.send({ type: "ops", doc: docId, batch: "dup-1", ops });
    expect(await s.next("ack")).toMatchObject({ applied: 4, duplicates: 0 });
    s.send({ type: "ops", doc: docId, batch: "dup-1", ops }); // retry after a lost ack
    expect(await s.next("ack")).toMatchObject({ applied: 0, duplicates: 4 });
    s.close();
    expect(await exportText(srv, tok.alice!, docId)).toBe("once");
    await srv.waitForLog(/OPS .*batch=dup-1 .*result=DUPLICATE/);
  });

  test("[R4] ops arrive out of order: the server buffers them until the missing ops arrive", async () => {
    const docId = await newDoc(srv, tok.alice!);
    const s = await rawSocket(srv, tok.alice!);
    s.send({ type: "join", doc: docId, replica: "alice-gggg7777", sv: {} });
    await s.next("joined");
    const ops = localReplica(docId, "alice-gggg7777").insertText(0, "abcd");
    s.send({ type: "ops", doc: docId, batch: "late", ops: ops.slice(2) });
    expect(await s.next("ack")).toMatchObject({ applied: 0, buffered: 2 });
    s.send({ type: "ops", doc: docId, batch: "early", ops: ops.slice(0, 2) });
    expect(await s.next("ack")).toMatchObject({ applied: 4, buffered: 0 });
    s.close();
    expect(await exportText(srv, tok.alice!, docId)).toBe("abcd");
  });

  test("[R5] a silent client (no heartbeat) is detected and marked offline", async () => {
    const own = await startServer({ HEARTBEAT_TIMEOUT_MS: "1000" });
    const t = { alice: await register(own, "alice"), bob: await register(own, "bob") };
    const docId = await newDoc(own, t.alice, { bob: "editor" });
    const a = await openClient(own, t.alice, "alice", docId, { heartbeatMs: 300 });
    const silent = await rawSocket(own, t.bob); // joins, then never sends a ping
    silent.send({ type: "join", doc: docId, replica: "bob-hhhh8888", sv: {} });
    await waitUntil(() => a.users.length === 2, 3000, "bob online");
    const t0 = Date.now();
    await waitUntil(() => a.users.length === 1, 5000, "bob marked offline");
    console.log(`[R5] failure detection time: ${Date.now() - t0} ms`);
    await own.waitForLog(/HEARTBEAT_TIMEOUT .*replica=bob-hhhh8888.*result=OFFLINE/);
    a.disconnect();
    await own.kill();
  });
});
