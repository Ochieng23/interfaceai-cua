import { type AppConfig, renderLayout } from "./layout";

/** Injected by inject.ts in "error" mode: a hard failure, HTTP 500. The literal text here
 * is what outcomes/cu-console.yaml's `application_error` entry matches on. */
export function renderApplicationErrorPage(cfg: AppConfig): string {
  const body = `
<table class="c1"><tr><td class="hdr"><h2>Application error</h2></td></tr></table>
<table class="r"><tr><td>
  <p>Application error. Something went wrong while processing your request.</p>
</td></tr></table>
`;
  return renderLayout(cfg, body);
}
