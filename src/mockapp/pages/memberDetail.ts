import type { Member } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** GET /member/:id detail page — name, member since, Savings balance, Checking balance,
 * and an "Open sub-account" link. */
export function renderMemberDetailPage(cfg: AppConfig, member: Member): string {
  const subRows = member.subAccounts
    .map(
      (sa) =>
        `<tr><td>${escapeHtml(sa.accountNumber)}</td><td>${escapeHtml(sa.accountType)}</td><td>${money(sa.balance)}</td></tr>`
    )
    .join("\n");
  const subTable = member.subAccounts.length
    ? `<h3>Sub-accounts</h3><table class="r"><tr><th>Account #</th><th>Type</th><th>Balance</th></tr>${subRows}</table>`
    : "";

  const body = `
<table class="c1"><tr><td class="hdr"><h2>Member detail</h2></td></tr></table>
<table class="r">
  <tr><td>Member ID</td><td>${escapeHtml(member.id)}</td></tr>
  <tr><td>Name</td><td>${escapeHtml(member.name)}</td></tr>
  <tr><td>Member since</td><td>${escapeHtml(member.memberSince)}</td></tr>
  <tr><td>Savings balance</td><td>${money(member.savings)}</td></tr>
  <tr><td>Checking balance</td><td>${money(member.checking)}</td></tr>
</table>
${subTable}
<p><a href="${cfg.prefix}/member/${member.id}/subaccount/new">Open sub-account</a></p>
<p><a href="${cfg.prefix}/members/search">New search</a></p>
`;
  return renderLayout(cfg, body);
}
