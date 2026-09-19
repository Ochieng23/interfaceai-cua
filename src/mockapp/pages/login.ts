import { type AppConfig, renderLayout, escapeHtml } from "./layout";

/** Login form. Real, working <label>s (implicit association via wrapping — no id/for,
 * since no id attributes are allowed anywhere in this app). This is NOT the deliberately
 * broken control; every field here has a normal accessible name. */
export function renderLoginPage(cfg: AppConfig, opts?: { error?: string }): string {
  const errorHtml = opts?.error
    ? `<tr><td colspan="2" class="err">${escapeHtml(opts.error)}</td></tr>`
    : "";
  const body = `
<table class="c1"><tr><td class="hdr"><h1>${escapeHtml(cfg.title)}</h1></td></tr></table>
<table class="r">
  <tr><td>
    <form method="POST" action="${cfg.prefix}/login">
      <table class="r">
        ${errorHtml}
        <tr>
          <td><label>Username <input type="text" name="username"></label></td>
        </tr>
        <tr>
          <td><label>Password <input type="password" name="password"></label></td>
        </tr>
        <tr>
          <td><input type="submit" value="Log in"></td>
        </tr>
      </table>
    </form>
  </td></tr>
</table>
`;
  return renderLayout(cfg, body);
}
