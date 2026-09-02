import { resolveWorkbenchHotReload, type WorkbenchHotReload } from "../workbench-assets.js";

export const WORKBENCH_RESOURCE_URI = "ui://cptr/live-workbench.html";

const CRITICAL_TERMINAL_GEOMETRY = `<style>
html,body,#root{margin:0;width:100%;min-width:0;min-height:100%;background:transparent}
.terminal-workbench{width:100%;min-width:0;margin:0;padding:0}
.terminal-shell{box-sizing:border-box;display:grid;grid-template-rows:auto minmax(140px,1fr) auto;width:100%;min-height:260px;overflow:hidden}
@media(max-width:560px){.terminal-shell{grid-template-rows:auto minmax(0,1fr) auto;min-height:240px;max-height:none}}
@media(max-width:390px){.terminal-shell{min-height:220px}}
</style>`;

const STATIC_TERMINAL_SHELL = `<main class="terminal-workbench" aria-label="CPTR live workbench">
  <section class="terminal-shell" data-terminal-static-shell data-state="connecting" aria-label="CPTR live terminal">
    <header class="terminal-header">
      <div class="terminal-identity">
        <div class="terminal-kicker">CHATGPT LIVE TERMINAL</div>
        <div class="terminal-machine-row">
          <span class="terminal-machine">Connecting to computer</span>
          <span class="terminal-status" data-state="connecting" role="status" aria-live="polite">
            <span class="state-dot" aria-hidden="true"></span><span>CONNECTING</span>
          </span>
        </div>
        <div class="terminal-path">Waiting for terminal session…</div>
      </div>
    </header>
    <section class="terminal-frame" aria-label="Real-time ChatGPT terminal activity over SSE">
      <pre class="terminal-output" tabindex="0" aria-label="Live terminal output" aria-live="off">Terminal UI ready.
Waiting for terminal stream…</pre>
    </section>
    <footer class="terminal-footer"><span>shell</span><span>SSE CONNECTING</span></footer>
  </section>
</main>`;

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

export async function createWorkbenchResource(
  bundle: string,
  connectDomain?: string,
  styles = "",
  hotReload: WorkbenchHotReload = resolveWorkbenchHotReload({ bundle, styles }),
) {
  const widgetDomain = validateWorkbenchDomain(connectDomain);
  const reloadScript = hotReload.enabled
    ? `<script>(()=>{const embedded=${JSON.stringify(hotReload.buildId)};const key="cptr-workbench-build:v1";let current=embedded;try{current=sessionStorage.getItem(key)||embedded;sessionStorage.setItem(key,current);}catch{}const css=document.createElement("link");css.rel="stylesheet";css.href=${JSON.stringify(`${widgetDomain}/__cptr/dev/workbench.css`)}+"?build="+encodeURIComponent(current);document.head.appendChild(css);const script=document.createElement("script");script.type="module";script.src=${JSON.stringify(`${widgetDomain}/__cptr/dev/workbench.js`)}+"?build="+encodeURIComponent(current);document.body.appendChild(script);const source=new EventSource(${JSON.stringify(`${widgetDomain}/__cptr/dev/reload`)});source.onmessage=(event)=>{const next=event.data;if(!next||next===current)return;current=next;try{sessionStorage.setItem(key,next);}catch{}source.close();location.reload();};})()</script>`
    : "";
  const assetMarkup = hotReload.enabled
    ? CRITICAL_TERMINAL_GEOMETRY
    : `<style>${styles}</style><script type="module">${bundle}</script>`;
  const text = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark">
<title>CPTR Live Terminal</title>${assetMarkup}</head><body><div id="root">${STATIC_TERMINAL_SHELL}</div>${reloadScript}</body></html>`;
  return {
    contents: [{
      uri: WORKBENCH_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      text,
      _meta: {
        ui: {
          domain: widgetDomain,
          prefersBorder: false,
          csp: {
            connectDomains: [widgetDomain],
            resourceDomains: hotReload.enabled ? [widgetDomain] : [],
          },
        },
      },
    }],
  };
}
