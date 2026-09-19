// CU Console — a deliberately legacy, server-rendered credit-union servicing web app.
// See SPEC.md §12. This is the target the browser-automation system (built in later tasks)
// operates against; the legacy markup (no ids, no test-ids, an alt-less image submit
// button, an iframe, inline onclick handlers) is intentional, not an oversight.
import express, { type NextFunction, type Request, type Response } from "express";

import { findMemberById, MIN_DEPOSIT, openSubAccount, searchMembers } from "./data";
import { handleInjectContinue, handleInjectRoute, injectionMiddleware } from "./inject";
import { makeAppConfig } from "./pages/layout";
import { renderApplicationErrorPage } from "./pages/applicationError";
import { renderLoginPage } from "./pages/login";
import { renderMemberDetailPage } from "./pages/memberDetail";
import { renderMemberNotFoundPage } from "./pages/memberNotFound";
import { renderPermissionDeniedPage } from "./pages/permissionDenied";
import { renderResultsPage } from "./pages/results";
import { renderSearchPage } from "./pages/search";
import { renderShellPage } from "./pages/shell";
import { renderSubaccountConfirmPage } from "./pages/subaccountConfirm";
import { renderSubaccountNewPage } from "./pages/subaccountNew";
import { renderSubaccountSuccessPage } from "./pages/subaccountSuccess";
import { renderSubaccountValidationErrorPage } from "./pages/validationError";
import { createSession, getSession, SESSION_COOKIE } from "./session";

// Read TENANT once at startup, not per-request — the whole process serves one tenant variant.
const cfg = makeAppConfig();

const app = express();
app.use(express.urlencoded({ extended: false }));

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session || !session.loggedIn) {
    res.redirect(303, `${cfg.prefix}/login`);
    return;
  }
  next();
}

/** Loads :id from the route, rendering the shared not-found/permission-denied pages when
 * appropriate. Returns undefined (and has already responded) when the caller should stop. */
function loadMemberOrRespond(req: Request, res: Response) {
  const member = findMemberById(req.params.id);
  if (!member) {
    res.status(404).send(renderMemberNotFoundPage(cfg));
    return undefined;
  }
  if (member.restricted) {
    res.status(403).send(renderPermissionDeniedPage(cfg));
    return undefined;
  }
  return member;
}

// --- Dev-only failure-injection control surface -----------------------------------------
// Not part of the "real" app surface a teller would see; used by the replay/discovery
// harness to force recoverable/hard failures deterministically. Always unprefixed, even
// under TENANT=b. See inject.ts for the one-shot cookie mechanics.
app.get("/__inject", handleInjectRoute);
app.post("/__inject/continue", handleInjectContinue);

// Applied after the one-shot cookie is readable (body parser + the two routes above are
// registered first) and before every "real" route below.
app.use(injectionMiddleware(cfg));

// --- Auth -------------------------------------------------------------------------------
app.get(`${cfg.prefix}/login`, (_req, res) => {
  res.status(200).send(renderLoginPage(cfg));
});

app.post(`${cfg.prefix}/login`, (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expectedUser = process.env.DEMO_USER || "teller";
  const expectedPass = process.env.DEMO_PASS || "demo-pass";

  if (username === expectedUser && password === expectedPass) {
    const sid = createSession();
    res.cookie(SESSION_COOKIE, sid, { httpOnly: true, path: "/" });
    res.redirect(303, `${cfg.prefix}/`);
    return;
  }
  res.status(401).send(renderLoginPage(cfg, { error: "Invalid username or password." }));
});

// --- Shell --------------------------------------------------------------------------------
app.get(`${cfg.prefix}/`, requireSession, (_req, res) => {
  res.status(200).send(renderShellPage(cfg));
});

// --- Member search --------------------------------------------------------------------------
app.get(`${cfg.prefix}/members/search`, requireSession, (_req, res) => {
  res.status(200).send(renderSearchPage(cfg));
});

app.post(`${cfg.prefix}/members/search`, requireSession, (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  const results = searchMembers(query);
  if (results.length === 0) {
    res.status(200).send(renderMemberNotFoundPage(cfg));
    return;
  }
  res.status(200).send(renderResultsPage(cfg, results));
});

// --- Member detail --------------------------------------------------------------------------
app.get(`${cfg.prefix}/member/:id`, requireSession, (req, res) => {
  const member = loadMemberOrRespond(req, res);
  if (!member) return;
  res.status(200).send(renderMemberDetailPage(cfg, member));
});

// --- Open sub-account (irreversible; new -> confirm -> submit) ------------------------------
app.get(`${cfg.prefix}/member/:id/subaccount/new`, requireSession, (req, res) => {
  const member = loadMemberOrRespond(req, res);
  if (!member) return;
  res.status(200).send(renderSubaccountNewPage(cfg, member));
});

app.post(`${cfg.prefix}/member/:id/subaccount/confirm`, requireSession, (req, res) => {
  const member = loadMemberOrRespond(req, res);
  if (!member) return;

  const accountType = typeof req.body?.accountType === "string" ? req.body.accountType : "Savings Sub-Account";
  const rawDeposit = typeof req.body?.initialDeposit === "string" ? req.body.initialDeposit : "";
  const parsed = Number.parseFloat(rawDeposit);

  if (!Number.isFinite(parsed) || parsed < MIN_DEPOSIT) {
    res
      .status(200)
      .send(renderSubaccountValidationErrorPage(cfg, member, { accountType, initialDeposit: rawDeposit }));
    return;
  }
  res.status(200).send(renderSubaccountConfirmPage(cfg, member, { accountType, initialDeposit: parsed }));
});

app.post(`${cfg.prefix}/member/:id/subaccount/submit`, requireSession, (req, res) => {
  const member = loadMemberOrRespond(req, res);
  if (!member) return;

  const accountType = typeof req.body?.accountType === "string" ? req.body.accountType : "Savings Sub-Account";
  const rawDeposit = typeof req.body?.initialDeposit === "string" ? req.body.initialDeposit : "";
  const parsed = Number.parseFloat(rawDeposit);

  // Defensive re-validation: submit should be unreachable with a bad deposit (confirm
  // already gated it), but never trust a client-controlled hidden field blindly.
  if (!Number.isFinite(parsed) || parsed < MIN_DEPOSIT) {
    res
      .status(200)
      .send(renderSubaccountValidationErrorPage(cfg, member, { accountType, initialDeposit: rawDeposit }));
    return;
  }

  const subAccount = openSubAccount(member.id, accountType, parsed);
  res.status(200).send(renderSubaccountSuccessPage(cfg, member, subAccount));
});

// --- Fallback error handler (belt-and-suspenders; injected "error" mode never reaches
// here since it short-circuits earlier, but a genuine bug elsewhere should still render
// the same "Application error" page rather than a bare Express stack trace). ----------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).send(renderApplicationErrorPage(cfg));
});

const port = Number(process.env.PORT) || 4173;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`CU Console (tenant ${cfg.tenant}) listening on http://localhost:${port}${cfg.prefix}/login`);
});
