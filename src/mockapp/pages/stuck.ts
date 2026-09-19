import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** Injected by inject.ts in "stuck" mode: the only forward control's accessible name is
 * randomized on every render, so no fixed locator can target it — this is meant to force
 * escalation to a human rather than be recoverable automatically. */
export function renderStuckPage(cfg: AppConfig, continueUrl: string): string {
  const randomLabel = `Continue-${Math.random().toString(36).slice(2, 8)}`;
  const body = `
<table class="c1"><tr><td class="hdr"><h2>One more step</h2></td></tr></table>
<table class="r"><tr><td>
  <p>This screen requires manual confirmation to proceed.</p>
  <form method="POST" action="/__inject/continue">
    <input type="hidden" name="next" value="${escapeHtml(continueUrl)}">
    <input type="submit" value="${escapeHtml(randomLabel)}">
  </form>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
