import { type AppConfig, renderLayout } from "./layout";

/** Shared "no such member" result — used both by a search miss and by GET /member/:id
 * when :id isn't in the data table. The literal text here ("No member found") is what
 * outcomes/cu-console.yaml's `member_not_found` entry matches on. */
export function renderMemberNotFoundPage(cfg: AppConfig): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Member search</h2></td></tr></table>
<table class="r"><tr><td>
  <p>No member found.</p>
  <p><a href="${cfg.prefix}/members/search">New search</a></p>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
