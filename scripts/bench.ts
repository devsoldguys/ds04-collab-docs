/**
 * Performance experiment (workload generator).
 *   bun scripts/bench.ts                         # starts its own server process
 *   bun scripts/bench.ts --server http://host:3000 --clients 5,10,20 --ops 100 --interval 10
 * Each client inserts one character every <interval> ms at a random position.
 * Measures: propagation latency (op created -> applied on another client), ack round trip,
 * throughput, convergence time, server memory and CPU. Writes docs/benchmark.md.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SyncClient, waitUntil } from "../src/client/sync-client";

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    clients: { type: "string", default: "5,10,20,50" },
    ops: { type: "string", default: "100" },
    interval: { type: "string", default: "10" },
  },
});
const OPS = Number(args.ops);
const INTERVAL = Number(args.interval);
const password = "bench-" + crypto.randomUUID().slice(0, 8);

let server = args.server?.replace(/\/$/, "");
let proc: ReturnType<typeof Bun.spawn> | undefined;
if (!server) {
  const db = join(mkdtempSync(join(tmpdir(), "ds04-bench-")), "bench.sqlite");
  const port = String(40000 + Math.floor(Math.random() * 20000));
  proc = Bun.spawn(["bun", "src/server/main.ts"], {
    env: { ...process.env, PORT: port, HOST: "127.0.0.1", DB_PATH: db, NODE_ENV: "production", TOKEN_SECRET: crypto.randomUUID() + crypto.randomUUID(), SERVER_ID: "server-bench" },
    stdout: "ignore",
    stderr: "inherit",
  });
  server = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${server}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(50);
  }
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(server + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json()) as any;
}
const health = async () => (await (await fetch(`${server}/api/health`)).json()) as any;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const users = ["bench1", "bench2", "bench3", "bench4"];
const tokens: Record<string, string> = {};
for (const u of users) tokens[u] = (await post("/api/register", { username: u, password })).token ?? (await post("/api/login", { username: u, password })).token;

type Row = { clients: number; ops: number; seconds: number; throughput: number; p50: number; p95: number; p99: number; ackP50: number; ackP95: number; convergeMs: number; memMB: number; cpuMs: number };
const rows: Row[] = [];

for (const n of args.clients!.split(",").map(Number)) {
  const doc = await post("/api/docs", { title: `bench ${n}` }, tokens.bench1);
  for (const u of users.slice(1)) await post(`/api/docs/${doc.id}/members`, { username: u, role: "editor" }, tokens.bench1);

  const sentAt = new Map<string, number>();
  const latencies: number[] = [];
  const batchSent = new Map<string, number>();
  const ackRtt: number[] = [];
  const clients: SyncClient[] = [];
  for (let i = 0; i < n; i++) {
    const user = users[i % users.length]!;
    const c = new SyncClient({
      server: server!,
      token: tokens[user]!,
      username: user,
      docId: doc.id,
      log: (event, f = {}) => {
        if (event === "SEND" && f.try === 1) batchSent.set(String(f.batch), performance.now());
        if (event === "ACK" && batchSent.has(String(f.batch))) ackRtt.push(performance.now() - batchSent.get(String(f.batch))!);
      },
    });
    c.onChange = (ops) => {
      const now = performance.now();
      for (const op of ops) if (sentAt.has(op.id)) latencies.push(now - sentAt.get(op.id)!);
    };
    c.connect();
    clients.push(c);
  }
  await waitUntil(() => clients.every((c) => c.isJoined), 15_000, "all clients joined");

  const before = await health();
  const t0 = performance.now();
  await Promise.all(
    clients.map(async (c) => {
      for (let i = 0; i < OPS; i++) {
        const pos = Math.floor(Math.random() * (c.doc.text().length + 1));
        for (const op of c.insert(pos, "x")) sentAt.set(op.id, performance.now());
        await Bun.sleep(INTERVAL);
      }
    }),
  );
  const tSent = performance.now();
  await waitUntil(
    () => clients.every((c) => c.unsavedCount === 0 && c.doc.version === n * OPS) && new Set(clients.map((c) => c.doc.text())).size === 1,
    60_000,
    "convergence",
  );
  const tDone = performance.now();
  const after = await health();
  clients.forEach((c) => c.disconnect());

  latencies.sort((a, b) => a - b);
  ackRtt.sort((a, b) => a - b);
  const seconds = (tDone - t0) / 1000;
  const row: Row = {
    clients: n,
    ops: n * OPS,
    seconds: +seconds.toFixed(2),
    throughput: Math.round((n * OPS) / seconds),
    p50: +pct(latencies, 0.5).toFixed(1),
    p95: +pct(latencies, 0.95).toFixed(1),
    p99: +pct(latencies, 0.99).toFixed(1),
    ackP50: +pct(ackRtt, 0.5).toFixed(1),
    ackP95: +pct(ackRtt, 0.95).toFixed(1),
    convergeMs: Math.round(tDone - tSent),
    memMB: after.memoryMB,
    cpuMs: Math.round((after.cpuMicros.user + after.cpuMicros.system - before.cpuMicros.user - before.cpuMicros.system) / 1000),
  };
  rows.push(row);
  console.log(row);
}

const table = [
  "| Clients | Ops total | Time (s) | Throughput (ops/s) | Latency p50 (ms) | p95 (ms) | p99 (ms) | Ack RTT p50 (ms) | Ack RTT p95 (ms) | Convergence after last op (ms) | Server RSS (MB) | Server CPU (ms) |",
  "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.clients} | ${r.ops} | ${r.seconds} | ${r.throughput} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.ackP50} | ${r.ackP95} | ${r.convergeMs} | ${r.memMB} | ${r.cpuMs} |`),
].join("\n");

const report = `# Benchmark results

- Date: ${new Date().toISOString()}
- Server: ${server}${proc ? " (local process started by the script)" : ""}
- Machine: ${process.platform} ${process.arch}, Bun ${Bun.version}
- Workload: every client inserts 1 character every ${INTERVAL} ms at a random position, ${OPS} ops per client.
- Latency = time from op creation on one client to op integration on another client (all clients run in one process, so they share one clock).
- Ack RTT = time from batch send to server ack (the server writes the batch to SQLite before the ack).

${table}

Note: all clients run in one benchmark process. With many clients, this process also uses CPU, so the numbers include client-side cost.
`;
await Bun.write("docs/benchmark.md", report);
console.log("\n" + table + "\n\nWritten: docs/benchmark.md");
proc?.kill();
process.exit(0);
