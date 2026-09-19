// Failure-injection middleware for the CU Console mock app.
//
// Dev-only surface, NOT part of the "real" app a teller would use: GET /__inject?mode=...
// sets a one-shot cookie recording an injection mode. That mode is applied to the very next
// request that comes in (any route), then the cookie is cleared so behavior reverts to
// normal ("none") automatically. This lets the replay/discovery system exercise recoverable
// and hard failures deterministically without a special test harness.
//
// Design note on "dialog" and "stuck": both need a forward control that POSTs "back to the
// original URL to continue". Doing that literally (form action = the original URL) would
// collide with routes that already have a distinct POST handler at that same path (e.g.
// POST /members/search means "run a search", not "continue past the interstitial"). Instead
// both render a form that POSTs to a dedicated /__inject/continue endpoint carrying the
// original URL in a hidden field; that endpoint 303-redirects the browser back to it, which
// re-issues the original GET. Functionally equivalent (POST happens, then the original page
// continues) without the route collision.
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./pages/layout";
import { renderApplicationErrorPage } from "./pages/applicationError";
import { renderSessionNoticePage } from "./pages/sessionNotice";
import { renderStuckPage } from "./pages/stuck";
import { destroySession, parseCookieHeader } from "./session";

export type InjectMode = "slow" | "error" | "dialog" | "stuck" | "expire" | "none";

const VALID_MODES: readonly InjectMode[] = ["slow", "error", "dialog", "stuck", "expire", "none"];

export const INJECT_COOKIE = "cu_inject";

function isInjectMode(value: unknown): value is InjectMode {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

/** GET /__inject?mode=slow|error|dialog|stuck|expire|none — sets the one-shot cookie.
 * Intentionally excluded from injectionMiddleware below (it's the control route, not a
 * "matching request" to be injected into). */
export function handleInjectRoute(req: Request, res: Response): void {
  const mode = req.query.mode;
  if (!isInjectMode(mode)) {
    res.status(400).send("bad mode; expected one of " + VALID_MODES.join("|"));
    return;
  }
  res.cookie(INJECT_COOKIE, mode, { httpOnly: true, path: "/" });
  res.status(200).send(`injection mode set to "${mode}" for the next request`);
}

/** POST /__inject/continue — used by the dialog/stuck interstitials' OK button to hop back
 * to the URL that was in flight when the injection fired. */
export function handleInjectContinue(req: Request, res: Response): void {
  const requested = typeof req.body?.next === "string" ? req.body.next : "/";
  // Only ever hop back to a same-origin, relative path. In normal use `next` is always a
  // same-origin URL this server itself rendered into the hidden field, but this is a POST
  // endpoint reachable directly, so guard against it being used as an open redirect.
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  res.redirect(303, next);
}

/** The injection-behavior middleware itself. Must run AFTER the one-shot cookie is read
 * (it reads + clears it here) and after req.body is available for routes that need it,
 * but that doesn't matter for this middleware's own logic. */
export function injectionMiddleware(cfg: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The control route itself is exempt — setting a new mode should never be affected by
    // a mode set by a previous call.
    if (req.path === "/__inject" || req.path === "/__inject/continue") {
      next();
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const rawMode = cookies[INJECT_COOKIE];
    const mode: InjectMode = isInjectMode(rawMode) ? rawMode : "none";

    if (mode !== "none") {
      // One-shot: clear it now so this fires exactly once, regardless of what happens below.
      res.clearCookie(INJECT_COOKIE, { path: "/" });
    }

    const originalUrl = req.originalUrl;

    switch (mode) {
      case "none":
        next();
        return;
      case "slow":
        setTimeout(next, 6000);
        return;
      case "dialog":
        res.status(200).send(renderSessionNoticePage(cfg, originalUrl));
        return;
      case "error":
        res.status(500).send(renderApplicationErrorPage(cfg));
        return;
      case "stuck":
        res.status(200).send(renderStuckPage(cfg, originalUrl));
        return;
      case "expire":
        destroySession(req);
        next();
        return;
      default:
        next();
    }
  };
}
