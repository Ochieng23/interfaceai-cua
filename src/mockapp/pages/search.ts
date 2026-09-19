import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** GET /members/search — the member search form.
 *
 * This page holds the ONE deliberately-broken control in the whole app: the submit is an
 * <input type="image" src="go.gif"> with NO alt attribute at all and no aria-label, per
 * SPEC §12. Every other control in this app (this form's text field included) has a normal
 * accessible name. The plain text next to the button ("Search" / "Find member") is visible
 * copy, not the button's accessible name — the button itself stays nameless on purpose.
 */
export function renderSearchPage(cfg: AppConfig): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Member search</h2></td></tr></table>
<table class="r"><tr><td>
  <form method="POST" action="${cfg.prefix}/members/search">
    <table class="r">
      <tr>
        <td><label>Member ID or name <input type="text" name="query"></label></td>
        <td>${escapeHtml(cfg.searchButtonLabel)}</td>
        <td><input type="image" src="go.gif"></td>
      </tr>
    </table>
  </form>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
