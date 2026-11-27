/**
 * Test helpers. Every test file starts the real server as a separate OS process
 * (bun src/server/main.ts) on a free port with its own SQLite file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SyncClient, waitUntil, type SyncOptions } from "../src/client/sync-client";
import type { Role } from "../src/shared/protocol";

export { waitUntil };
export const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
export const PASSWORD = "matkhau123";

export type TestServer = {
  url: string;
  dbPath: string;
  logs: string[];
  waitForLog(re: RegExp, timeoutMs?: number): Promise<string>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  restart(): Promise<void>;
};

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ds04-test-")), "test.sqlite");
  const logs: string[] = [];
  let port = 0;
  let proc: Subprocess<"ignore", "pipe", "pipe">;

  const waitForLog = async (re: RegExp, timeoutMs = 8000, from = 0) => {
    let found: string | undefined;
    await waitUntil(() => (found = logs.slice(from).find((l) => re.test(l))) !== undefined, timeoutMs, `server log ${re}`);
    return found!;
  };

  const launch = async () => {
    const from = logs.length;
    proc = Bun.spawn(["bun", "src/server/main.ts"], {
      env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DB_PATH: dbPath, TOKEN_SECRET: SECRET, SERVER_ID: "server-test", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const onLine = (line: string) => {
      logs.push(line);
      if (process.env.SHOW_SERVER_LOG) console.log(line);
    };
    pumpLines(proc.stdout, onLine);
    pumpLines(proc.stderr, onLine);
    const line = await waitForLog(/SERVER_START/, 8000, from);
    port = Number(line.match(/:(\d+)\//)![1]);
  };

  await launch();
  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    dbPath,
    logs,
    waitForLog: (re, timeoutMs) => waitForLog(re, timeoutMs),
    async kill(signal = "SIGTERM") {
      proc.kill(signal);
      await proc.exited;
    },
    restart: launch,
  };
}

export async function post(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function register(srv: TestServer, username: string): Promise<string> {
  const res = await post(`${srv.url}/api/register`, { username, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Create a document owned by `owner` and share it with the other users. */
export async function newDoc(srv: TestServer, owner: string, shareWith: Record<string, Exclude<Role, "owner">> = {}) {
  const res = await post(`${srv.url}/api/docs`, { title: "Test document" }, owner);
  for (const [username, role] of Object.entries(shareWith)) {
    const s = await post(`${srv.url}/api/docs/${res.body.id}/members`, { username, role }, owner);
    if (s.status !== 200) throw new Error(`share: ${s.status}`);
  }
  return res.body.id as string;
}

/** Connected client with short timeouts, so fault tests run fast. */
export async function openClient(srv: TestServer, token: string, username: string, docId: string, opts: Partial<SyncOptions> = {}) {
  const client = new SyncClient({
    server: srv.url,
    token,
    username,
    docId,
    ackTimeoutMs: 1000,
    heartbeatMs: 1000,
    maxBackoffMs: 400,
    ...opts,
  });
  client.connect();
  await waitUntil(() => client.isJoined, 5000, `${username} join`);
  return client;
}

/** All clients have the same text, nothing unsaved, and the same number of ops. */
export async function converged(clients: SyncClient[], timeoutMs = 8000) {
  await waitUntil(
    () =>
      clients.every((c) => c.isJoined && c.unsavedCount === 0) &&
      new Set(clients.map((c) => c.doc.text())).size === 1 &&
      new Set(clients.map((c) => c.doc.version)).size === 1,
    timeoutMs,
    "convergence",
  );
  return clients[0]!.doc.text();
}

export async function exportText(srv: TestServer, token: string, docId: string) {
  const res = await fetch(`${srv.url}/api/docs/${docId}/export`, { headers: { authorization: `Bearer ${token}` } });
  return res.text();
}

/** A bare WebSocket for protocol-level tests (malformed input, duplicates, impersonation). */
export async function rawSocket(srv: TestServer, token: string) {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/ws?token=${token}`);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  return {
    ws,
    inbox,
    send: (msg: unknown) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
    /** Wait for the next message of a type that arrives after this call. */
    async next(type: string, timeoutMs = 3000) {
      const start = inbox.length;
      let msg: any;
      await waitUntil(() => (msg = inbox.slice(start).find((m) => m.type === type)) !== undefined, timeoutMs, `message ${type}`);
      return msg;
    },
    close: () => ws.close(),
  };
}
