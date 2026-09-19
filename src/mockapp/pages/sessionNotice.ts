import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** Injected by inject.ts in "dialog" mode: a "Session notice" interstitial with an OK
 * button. The OK button POSTs to a dedicated continuation route carrying the original URL,
 * which 303-redirects back to it (see inject.ts for why: reusing the literal original URL
 * as the form action would collide with routes that already have a distinct POST handler,
 * e.g. /members/search). Recoverable via "dismiss". */
export function renderSessionNoticePage(cfg: AppConfig, continueUrl: string): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Session notice</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Your session requires attention before continuing. This is a routine notice.</p>
  <form method="POST" action="/__inject/continue">
    <input type="hidden" name="next" value="${escapeHtml(continueUrl)}">
    <input type="submit" value="OK">
  </form>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
