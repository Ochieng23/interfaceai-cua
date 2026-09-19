import type { Member } from "../data";
import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** POST /members/search results table.
 *
 * Per SPEC §12: at least a couple of rows use an inline onclick as an ALTERNATE navigation
 * path on top of a normal <a href> anchor already inside the row — mimicking how real
 * legacy banking UIs often wire up both. Every row gets this (harmless when there's only
 * one result; demonstrates the pattern whenever a search returns 2+ rows).
 */
export function renderResultsPage(cfg: AppConfig, results: Member[]): string {
  const rows = results
    .map((m) => {
      const href = `${cfg.prefix}/member/${m.id}`;
      return `<tr class="r" onclick="location.href='${href}'">
        <td>${escapeHtml(m.id)}</td>
        <td><a href="${href}">${escapeHtml(m.name)}</a></td>
        <td>${escapeHtml(m.memberSince)}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
<table class="c1"><tr><td class="hdr"><h2>Search results</h2></td></tr></table>
<table class="r">
  <tr><th>Member ID</th><th>Name</th><th>Member since</th></tr>
  ${rows}
</table>
<p><a href="${cfg.prefix}/members/search">New search</a></p>
`;
  return renderLayout(cfg, body);
}
