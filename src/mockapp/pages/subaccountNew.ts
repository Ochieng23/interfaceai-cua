import type { Member } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** GET /member/:id/subaccount/new — the initial sub-account-opening form. */
export function renderSubaccountNewPage(cfg: AppConfig, member: Member): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Open sub-account</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Member: ${escapeHtml(member.name)} (${escapeHtml(member.id)})</p>
  <form method="POST" action="${cfg.prefix}/member/${member.id}/subaccount/confirm">
    <table class="r">
      <tr><td>
        <label>Account type
          <select name="accountType">
            <option value="Savings Sub-Account">Savings Sub-Account</option>
            <option value="Christmas Club">Christmas Club</option>
            <option value="Vacation Fund">Vacation Fund</option>
          </select>
        </label>
      </td></tr>
      <tr><td><label>Initial deposit amount <input type="text" name="initialDeposit"></label></td></tr>
      <tr><td><input type="submit" value="Continue"></td></tr>
    </table>
  </form>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
