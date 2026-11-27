/**
 * Passwords: argon2id hash (Bun.password). The database never stores a plaintext password.
 * Tokens: "<base64url payload>.<base64url HMAC-SHA256>", payload = { sub: username, exp }.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: "argon2id" });
export const verifyPassword = (password: string, hash: string) => Bun.password.verify(password, hash);

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest();

export function signToken(username: string, secret: string, ttlMs: number): string {
  const payload = b64url(JSON.stringify({ sub: username, exp: Date.now() + ttlMs }));
  return `${payload}.${b64url(sign(payload, secret))}`;
}

/** Returns the username, or null if the token is missing, forged or expired. */
export function verifyToken(token: string | null | undefined, secret: string): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof sub === "string" && typeof exp === "number" && exp > Date.now() ? sub : null;
  } catch {
    return null;
  }
}
