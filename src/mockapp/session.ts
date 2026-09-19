// Hand-rolled session handling. Per SPEC §0.6 / the task brief: no express-session or any
// session middleware package — just an opaque cookie value mapped to an in-memory Map.
// Single process, no persistence beyond process lifetime.
import type { Request } from "express";
import crypto from "node:crypto";

export interface SessionData {
  loggedIn: boolean;
}

export const SESSION_COOKIE = "cu_sid";

export const sessions: Map<string, SessionData> = new Map();

/** Parse a raw `Cookie` request header into a name -> value map. Hand-rolled because
 * cookie-parser is not in the approved dependency list; Express's own res.cookie()/
 * res.clearCookie() are used for writing (those ship with express core). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function getSessionId(req: Request): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE];
}

export function getSession(req: Request): SessionData | undefined {
  const sid = getSessionId(req);
  if (!sid) return undefined;
  return sessions.get(sid);
}

export function createSession(): string {
  const sid = crypto.randomBytes(16).toString("hex");
  sessions.set(sid, { loggedIn: true });
  return sid;
}

/** Used by the `expire` injection: kills the session server-side so the next request that
 * needs one gets redirected to /login as if the session died mid-flow. */
export function destroySession(req: Request): void {
  const sid = getSessionId(req);
  if (sid) sessions.delete(sid);
}
