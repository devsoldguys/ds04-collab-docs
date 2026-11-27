/**
 * Server configuration. All values come from environment variables
 * (Bun loads .env automatically). See .env.example.
 */
import { randomBytes } from "node:crypto";

export type Config = {
  serverId: string;
  host: string;
  port: number;
  dbPath: string;
  tokenSecret: string;
  tokenTtlMs: number;
  maxMessageBytes: number;
  maxDocChars: number;
  maxPendingOps: number;
  heartbeatTimeoutMs: number;
  production: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const num = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  let tokenSecret = env.TOKEN_SECRET ?? "";
  if (tokenSecret.length < 32) {
    if (env.NODE_ENV === "production") throw new Error("TOKEN_SECRET must be set (32+ characters) in production");
    tokenSecret = randomBytes(32).toString("hex");
    console.warn("[config] TOKEN_SECRET is not set: using a random secret. Tokens become invalid after a restart.");
  }

  return {
    serverId: env.SERVER_ID || "server-1",
    host: env.HOST || "0.0.0.0",
    port: env.PORT ? Number(env.PORT) : 3000, // 0 = any free port (tests)
    dbPath: env.DB_PATH || "./data/ds04.sqlite",
    tokenSecret,
    tokenTtlMs: num("TOKEN_TTL_HOURS", 12) * 3600_000,
    maxMessageBytes: num("MAX_MESSAGE_BYTES", 256 * 1024),
    maxDocChars: num("MAX_DOC_CHARS", 200_000),
    maxPendingOps: num("MAX_PENDING_OPS", 2_000),
    heartbeatTimeoutMs: num("HEARTBEAT_TIMEOUT_MS", 15_000),
    production: env.NODE_ENV === "production",
  };
}
