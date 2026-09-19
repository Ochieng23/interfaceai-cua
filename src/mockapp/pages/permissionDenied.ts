import { type AppConfig, renderLayout } from "./layout";

/** Rendered instead of member detail for restricted members (10007). The literal text
 * here is what outcomes/cu-console.yaml's `permission_denied` entry matches on. */
export function renderPermissionDeniedPage(cfg: AppConfig): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Member detail</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Permission denied. You are not authorized to view this member's account.</p>
  <p><a href="${cfg.prefix}/members/search">New search</a></p>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
