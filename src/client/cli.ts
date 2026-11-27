/**
 * Terminal client. One process = one client node.
 *   bun src/client/cli.ts --user bob --password matkhau123 --doc <id>
 *   bun src/client/cli.ts ... --script "ins 0 Hello; sleep 500; show; quit"
 * Type "help" for the command list.
 */
import { parseArgs } from "node:util";
import { makeLogger } from "../shared/log";
import { SyncClient, waitUntil } from "./sync-client";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: process.env.SERVER_URL ?? "http://localhost:3000" },
    user: { type: "string" },
    password: { type: "string" },
    doc: { type: "string" },
    register: { type: "boolean", default: false },
    script: { type: "string" },
  },
});

if (!args.user || !args.password || !args.doc) {
  console.error("Usage: bun src/client/cli.ts --user <name> --password <pw> --doc <docId> [--server URL] [--register] [--script 'cmd; cmd']");
  process.exit(2);
}

const HELP = `Commands:
  show                 print the document
  ins <pos> <text>     insert text at position (\\n = new line)
  app <text>           append text at the end
  del <pos> <len>      delete <len> characters from <pos>
  offline              disconnect and stay offline (edits wait in the outbox)
  online               connect again
  break                simulate a network failure (automatic reconnect)
  users                list connected users
  status               connection, versions, unsaved ops
  sleep <ms>           wait
  wait-saved           wait until the server acknowledges every local op
  quit`;

async function authenticate(): Promise<string> {
  const call = (path: string) =>
    fetch(`${args.server}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: args.user, password: args.password }),
    });
  let res = args.register ? await call("/api/register") : await call("/api/login");
  if (args.register && res.status === 409) res = await call("/api/login");
  const body = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(`login failed: ${body.error ?? res.status}`);
  return body.token;
}

const replica = `${args.user}-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
const log = makeLogger(replica);
const client = new SyncClient({ server: args.server!, token: await authenticate(), docId: args.doc, username: args.user, replica, log });

const show = () => console.log(`  ┌ v${client.doc.version} (server v${client.serverVersion}, unsaved ${client.unsavedCount})\n  └ ${JSON.stringify(client.doc.text())}`);
client.onChange = show;
client.onPresence = (users, reason) => log("PRESENCE", { reason, online: users.map((u) => u.user).join(",") });

client.connect();
await waitUntil(() => client.isJoined, 15_000, "join");
show();

async function run(line: string): Promise<boolean> {
  const [cmd = "", ...rest] = line.trim().split(" ");
  const text = (from: number) => rest.slice(from).join(" ").replace(/\\n/g, "\n");
  try {
    switch (cmd) {
      case "":
        break;
      case "show":
        show();
        break;
      case "ins":
        client.insert(Number(rest[0]), text(1));
        show();
        break;
      case "app":
        client.insert(client.doc.text().length, text(0));
        show();
        break;
      case "del":
        client.delete(Number(rest[0]), Number(rest[1]));
        show();
        break;
      case "offline":
        client.disconnect("cli offline command");
        break;
      case "online":
        client.connect();
        break;
      case "break":
        client.breakConnection();
        break;
      case "users":
        client.users.forEach((u) => console.log(`  ${u.user} (${u.replica})`));
        break;
      case "status":
        console.log(`  status=${client.status} role=${client.role} server=${client.serverId} local_v=${client.doc.version} server_v=${client.serverVersion} unsaved=${client.unsavedCount}`);
        break;
      case "sleep":
        await Bun.sleep(Number(rest[0]) || 0);
        break;
      case "wait-saved":
        await waitUntil(() => client.unsavedCount === 0 && client.isJoined, 30_000, "ack of all ops");
        break;
      case "quit":
      case "exit":
        return false;
      default:
        console.log(HELP);
    }
  } catch (err) {
    console.log(`  error: ${(err as Error).message}`);
  }
  return true;
}

if (args.script) {
  for (const line of args.script.split(";")) if (!(await run(line))) break;
} else {
  console.log('Type "help" for commands.');
  for await (const line of console) if (!(await run(line))) break;
}
await waitUntil(() => client.unsavedCount === 0, 5_000, "ack before exit").catch(() => log("EXIT", { unsaved: client.unsavedCount }, "UNSAVED"));
client.disconnect("quit");
process.exit(0);
