// Shared HTML wrapper. Server-rendered HTML strings only — no template engine, no client JS,
// per SPEC §1 and §12. Deliberately legacy: table-based layout, generic (non-semantic) classes
// only (c1, r), no ids, no data-testid anywhere in this file or any page file.

export type Tenant = "a" | "b";

export interface AppConfig {
  tenant: Tenant;
  prefix: string; // "" for tenant a, "/portal" for tenant b
  title: string; // page <title> / masthead text
  searchButtonLabel: string; // "Search" (a) or "Find member" (b) — text NEXT TO the
  // alt-less image button, not the button's own accessible name.
}

export function makeAppConfig(): AppConfig {
  const tenant: Tenant = process.env.TENANT === "b" ? "b" : "a";
  if (tenant === "b") {
    return {
      tenant,
      prefix: "/portal",
      title: "Member Portal — Second Federal CU",
      searchButtonLabel: "Find member",
    };
  }
  return {
    tenant,
    prefix: "",
    title: "CU Console — First Federal CU",
    searchButtonLabel: "Search",
  };
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wraps a body fragment in the tenant-aware page shell. Tenant B gets a different
 * inline color scheme; both are plain <style> blocks, no external CSS. */
export function renderLayout(cfg: AppConfig, bodyContent: string): string {
  const bg = cfg.tenant === "b" ? "#0b3d2e" : "#26314f";
  const accent = cfg.tenant === "b" ? "#e8f5e9" : "#eef1f7";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(cfg.title)}</title>
<style>
body { font-family: Verdana, Geneva, sans-serif; font-size: 13px; margin: 0; background: #ffffff; color: #000000; }
table.c1 { border-collapse: collapse; width: 100%; }
table.c1 td { padding: 4px; }
table.r { border-collapse: collapse; }
table.r td, table.r th { border: 1px solid #999999; padding: 4px 8px; }
.hdr { background: ${bg}; color: ${accent}; padding: 8px 12px; }
.err { color: #a30000; font-weight: bold; }
</style>
</head>
<body>
${bodyContent}
</body>
</html>
`;
}
