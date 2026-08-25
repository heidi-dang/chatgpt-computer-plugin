export const WORKBENCH_RESOURCE_URI = "ui://cptr/live-workbench.html";

export async function createWorkbenchResource(bundle: string, connectDomain?: string, styles = "") {
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
          prefersBorder: true,
          csp: { connectDomains: connectDomain ? [connectDomain] : [], resourceDomains: [] },
        },
      },
    }],
  };
}
