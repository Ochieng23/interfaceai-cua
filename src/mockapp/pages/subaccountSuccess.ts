import type { Member, SubAccount } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** POST /member/:id/subaccount/submit success page — shows the newly generated account
 * number. This is the actual (irreversible) mutation having already happened. */
export function renderSubaccountSuccessPage(cfg: AppConfig, member: Member, subAccount: SubAccount): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Sub-account opened</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Success. The new sub-account has been opened for ${escapeHtml(member.name)}.</p>
  <table class="r">
    <tr><td>New account number</td><td>${escapeHtml(subAccount.accountNumber)}</td></tr>
    <tr><td>Account type</td><td>${escapeHtml(subAccount.accountType)}</td></tr>
    <tr><td>Opening balance</td><td>${subAccount.balance.toFixed(2)}</td></tr>
  </table>
  <p><a href="${cfg.prefix}/member/${member.id}">Back to member detail</a></p>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
