// Client-side integration tests: real-time sync, concurrency, offline/reconnect, performance smoke.
// Server = separate process. Clients = SyncClient instances with their own WebSocket connections.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncClient } from "../src/client/sync-client";
import { converged, exportText, newDoc, openClient, register, startServer, waitUntil, type TestServer } from "./helpers";

let srv: TestServer;
const tok: Record<string, string> = {};
const opened: SyncClient[] = [];

beforeAll(async () => {
  srv = await startServer();
  for (const name of ["alice", "bob", "carol", "dave"]) tok[name] = await register(srv, name);
});
afterAll(async () => {
  opened.forEach((c) => c.disconnect());
  await srv.kill();
});

/** New document shared by alice with bob and carol; one client per user. */
async function threeClients() {
  const docId = await newDoc(srv, tok.alice!, { bob: "editor", carol: "editor" });
  const clients = await Promise.all(["alice", "bob", "carol"].map((u) => openClient(srv, tok[u]!, u, docId)));
  opened.push(...clients);
  return { docId, a: clients[0]!, b: clients[1]!, c: clients[2]!, all: clients };
}

describe("Functional", () => {
  test("[F4] three clients open the same document and see three active users", async () => {
    const { all } = await threeClients();
    await waitUntil(() => all.every((c) => c.users.length === 3), 3000, "presence of 3 users");
    expect(new Set(all[0]!.users.map((u) => u.user))).toEqual(new Set(["alice", "bob", "carol"]));
  });

  test("[F5] one client inserts text, the other clients receive it", async () => {
    const { a, all } = await threeClients();
    a.insert(0, "Xin chào DS04");
    expect(await converged(all)).toBe("Xin chào DS04");
  });

  test("[F6] one client deletes text, the other clients receive it", async () => {
    const { a, b, all } = await threeClients();
    a.insert(0, "Hello brave world");
    await converged(all);
    b.delete(5, 6);
    expect(await converged(all)).toBe("Hello world");
  });

  test("[F7] a client that joins later receives the full document", async () => {
    const { docId, a, b, all } = await threeClients();
    a.insert(0, "first ");
    b.insert(0, "second ");
    await converged(all);
    const late = await openClient(srv, tok.alice!, "alice", docId);
    opened.push(late);
    expect(await converged([...all, late])).toBe(a.doc.text());
  });

  test("[F9] active user list updates when a client leaves", async () => {
    const { a, c } = await threeClients();
    await waitUntil(() => a.users.length === 3, 3000, "3 users");
    c.disconnect();
    await waitUntil(() => a.users.length === 2, 3000, "2 users after leave");
    expect(a.users.map((u) => u.user)).not.toContain("carol");
  });
});

describe("Concurrency", () => {
  test("[C1] two clients insert at the same position at the same time: all clients converge, both texts kept", async () => {
    const { a, b, all } = await threeClients();
    a.insert(0, "AB");
    await converged(all);
    a.insert(1, "xx"); // both edits leave before either sees the other one
    b.insert(1, "yy");
    const text = await converged(all);
    expect(text).toMatch(/^A(xxyy|yyxx)B$/);
  });

  test("[C2] one client inserts while another deletes the same range: all clients converge, the insert survives", async () => {
    const { a, b, all } = await threeClients();
    a.insert(0, "0123456789");
    await converged(all);
    a.delete(2, 6);
    b.insert(5, "NEW");
    expect(await converged(all)).toBe("01NEW89");
  });

  test("[C3] three clients make 100 random edits each at the same time: all clients and the server converge", async () => {
    const { docId, all } = await threeClients();
    const edit = async (c: SyncClient, seed: number) => {
      let s = seed;
      const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
      for (let i = 0; i < 100; i++) {
        const len = c.doc.text().length;
        if (len > 3 && rand() < 0.35) c.delete(Math.floor(rand() * (len - 2)), 1 + Math.floor(rand() * 2));
        else c.insert(Math.floor(rand() * (len + 1)), String.fromCharCode(97 + Math.floor(rand() * 26)));
        if (i % 10 === 0) await Bun.sleep(Math.floor(rand() * 8));
      }
    };
    await Promise.all(all.map((c, i) => edit(c, i + 1)));
    const text = await converged(all, 10_000);
    expect(await exportText(srv, tok.alice!, docId)).toBe(text);
  });
});

describe("Fault tolerance", () => {
  test("[R1] a client goes offline, edits offline, others keep editing; after reconnect all clients converge", async () => {
    const { a, b, c, all } = await threeClients();
    a.insert(0, "shared base");
    await converged(all);

    c.disconnect("test: network down");
    await waitUntil(() => a.users.length === 2, 3000, "server sees carol offline");
    a.insert(0, "[alice] ");
    b.insert(b.doc.text().length, " [bob]");
    c.insert(0, "[carol offline] "); // stays in carol's outbox
    expect(c.unsavedCount).toBeGreaterThan(0);
    await converged([a, b]);

    c.connect();
    const text = await converged(all);
    expect(text).toContain("[alice] ");
    expect(text).toContain(" [bob]");
    expect(text).toContain("[carol offline] ");
    expect(text).toContain("shared base");
  });

  test("[R1b] the connection breaks while a batch is in flight: the client reconnects by itself and resends", async () => {
    const { a, b, all } = await threeClients();
    a.insert(0, "before break ");
    a.breakConnection(); // socket dies right after the send; the ack is lost
    a.insert(a.doc.text().length, "after break");
    b.insert(0, ">> ");
    const text = await converged(all);
    expect(text).toBe(">> before break after break");
  });
});

describe("Performance", () => {
  test("[P1] 10 clients x 30 ops: p95 propagation latency under 500 ms and all converge", async () => {
    const docId = await newDoc(srv, tok.alice!, { bob: "editor", carol: "editor", dave: "editor" });
    const names = ["alice", "bob", "carol", "dave"];
    const clients = await Promise.all(Array.from({ length: 10 }, (_, i) => openClient(srv, tok[names[i % 4]!]!, names[i % 4]!, docId)));
    opened.push(...clients);

    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    clients.forEach((c) => {
      c.onChange = (ops) => ops.forEach((op) => sentAt.has(op.id) && latencies.push(performance.now() - sentAt.get(op.id)!));
    });
    for (let round = 0; round < 30; round++) {
      for (const c of clients) c.insert(0, "x").forEach((op) => sentAt.set(op.id, performance.now()));
      await Bun.sleep(5);
    }
    await converged(clients, 15_000);
    latencies.sort((x, y) => x - y);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    console.log(`[P1] deliveries=${latencies.length} p50=${latencies[Math.floor(latencies.length / 2)]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    expect(clients[0]!.doc.text().length).toBe(300);
    expect(p95).toBeLessThan(500);
  });
});
