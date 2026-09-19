import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** GET / — the frameset-style shell: a top nav area plus a same-origin <iframe> pointing
 * at the member search page. This forces frame-scoped locator handling downstream. */
export function renderShellPage(cfg: AppConfig): string {
  const body = `
<table class="c1">
  <tr><td class="hdr">
    <table class="c1"><tr>
      <td><h1>${escapeHtml(cfg.title)}</h1></td>
      <td align="right">
        <a href="${cfg.prefix}/">Home</a> |
        <a href="${cfg.prefix}/login">Log out</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td>
    <iframe src="${cfg.prefix}/members/search" width="100%" height="600" frameborder="1" title="Member search"></iframe>
  </td></tr>
</table>
`;
  return renderLayout(cfg, body);
}
