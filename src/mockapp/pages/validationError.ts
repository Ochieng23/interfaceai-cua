import type { Member } from "../data";
import { MIN_DEPOSIT } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** Re-rendered form with a validation error when the initial deposit is below MIN_DEPOSIT.
 * A business outcome, not a crash. The literal text here is what outcomes/cu-console.yaml's
 * `validation_error_min_deposit` entry matches on. */
export function renderSubaccountValidationErrorPage(
  cfg: AppConfig,
  member: Member,
  attempted: { accountType: string; initialDeposit: string }
): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Open sub-account</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Member: ${escapeHtml(member.name)} (${escapeHtml(member.id)})</p>
  <p class="err">Validation error: the initial deposit must be at least ${MIN_DEPOSIT.toFixed(2)}.</p>
  <form method="POST" action="${cfg.prefix}/member/${member.id}/subaccount/confirm">
    <table class="r">
      <tr><td>
        <label>Account type
          <select name="accountType">
            <option value="Savings Sub-Account" ${attempted.accountType === "Savings Sub-Account" ? "selected" : ""}>Savings Sub-Account</option>
            <option value="Christmas Club" ${attempted.accountType === "Christmas Club" ? "selected" : ""}>Christmas Club</option>
            <option value="Vacation Fund" ${attempted.accountType === "Vacation Fund" ? "selected" : ""}>Vacation Fund</option>
          </select>
        </label>
      </td></tr>
      <tr><td><label>Initial deposit amount <input type="text" name="initialDeposit" value="${escapeHtml(attempted.initialDeposit)}"></label></td></tr>
      <tr><td><input type="submit" value="Continue"></td></tr>
    </table>
  </form>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
