export const WORKBENCH_RESOURCE_URI = "ui://cptr/live-workbench.html";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

export function validateWorkbenchDomain(value: string | undefined, production = process.env.NODE_ENV === "production"): string {
  if (!value?.trim()) throw new Error("Workbench widget domain is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Workbench widget domain must be an absolute HTTP(S) origin");
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.hostname.includes("*")) {
    throw new Error("Workbench widget domain must be an HTTP(S) origin without a path or credentials");
  }
  if (production && url.protocol !== "https:") {
    throw new Error("Workbench widget domain must use HTTPS in production");
  }
  if (production && isLoopbackHostname(url.hostname)) {
    throw new Error("Workbench widget domain cannot be localhost in production");
  }
  return url.origin;
}

export async function createWorkbenchResource(bundle: string, connectDomain?: string, styles = "") {
  const widgetDomain = validateWorkbenchDomain(connectDomain);
  const text = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CPTR Live Workbench</title><style>${styles}</style></head><body><div id="root"></div><script type="module">${bundle}</script></body></html>`;
  return {
    contents: [{
      uri: WORKBENCH_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      text,
      _meta: {
        ui: {
          domain: widgetDomain,
          prefersBorder: true,
          csp: { connectDomains: [widgetDomain], resourceDomains: [] },
        },
      },
    }],
  };
}
