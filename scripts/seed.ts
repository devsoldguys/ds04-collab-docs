/**
 * Create demo accounts and one shared document.
 *   bun scripts/seed.ts [--server http://localhost:3000]
 * Accounts: alice (owner), bob + carol (editor), dave (viewer).
 * Password: DEMO_PASSWORD from .env; if empty, the script makes a random one and prints it.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { server: { type: "string", default: process.env.SERVER_URL ?? "http://localhost:3000" } } });
const server = values.server!.replace(/\/$/, "");
const password = process.env.DEMO_PASSWORD || crypto.randomUUID().slice(0, 12);

async function call(path: string, body: unknown, token?: string) {
  const res = await fetch(server + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function account(username: string): Promise<string> {
  const reg = await call("/api/register", { username, password });
  if (reg.status === 201) return reg.body.token;
  const login = await call("/api/login", { username, password });
  if (login.status !== 200) throw new Error(`${username}: account exists with another password (set DEMO_PASSWORD)`);
  return login.body.token;
}

const alice = await account("alice");
for (const u of ["bob", "carol", "dave"]) await account(u);
const doc = await call("/api/docs", { title: "Tài liệu demo DS04" }, alice);
for (const [username, role] of [["bob", "editor"], ["carol", "editor"], ["dave", "viewer"]])
  await call(`/api/docs/${doc.body.id}/members`, { username, role }, alice);

console.log(`
Server:    ${server}
Password:  ${password}   (all demo accounts)
Accounts:  alice (owner), bob (editor), carol (editor), dave (viewer)
Document:  ${doc.body.id}
Browser:   ${server}/#/doc/${doc.body.id}   (one tab per user)
CLI:       bun src/client/cli.ts --server ${server} --user bob --password ${password} --doc ${doc.body.id}
`);
