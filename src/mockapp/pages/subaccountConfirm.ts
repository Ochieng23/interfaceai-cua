import type { Member } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** POST /member/:id/subaccount/confirm — the "are you sure?" review screen.
 *
 * Opening a sub-account is irreversible (SPEC §9), so there has to be a distinct
 * confirm-then-submit boundary: this screen only reviews the choice and POSTs to
 * /member/:id/subaccount/submit, which is the step that actually mutates data.
 */
export function renderSubaccountConfirmPage(
  cfg: AppConfig,
  member: Member,
  chosen: { accountType: string; initialDeposit: number }
): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Confirm sub-account</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Please review before continuing. This action cannot be undone.</p>
  <table class="r">
    <tr><td>Member</td><td>${escapeHtml(member.name)} (${escapeHtml(member.id)})</td></tr>
    <tr><td>Account type</td><td>${escapeHtml(chosen.accountType)}</td></tr>
    <tr><td>Initial deposit</td><td>${chosen.initialDeposit.toFixed(2)}</td></tr>
  </table>
  <form method="POST" action="${cfg.prefix}/member/${member.id}/subaccount/submit">
    <input type="hidden" name="accountType" value="${escapeHtml(chosen.accountType)}">
    <input type="hidden" name="initialDeposit" value="${chosen.initialDeposit.toFixed(2)}">
    <input type="submit" value="Confirm and open account">
  </form>
  <p><a href="${cfg.prefix}/member/${member.id}">Cancel</a></p>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
