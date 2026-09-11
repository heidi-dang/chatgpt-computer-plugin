import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView, isNearTerminalTail, normalizeTerminalText } from "../web/src/terminal-view.js";

test("default widget matches the ChatGPT Terminal live surface", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [{
      id: "row-1",
      sequence: 7,
      timestamp: "2026-09-02T00:00:00Z",
      tone: "stdout",
      text: "\u001b[31;1mERROR\u001b[0m const answer = \"ok\"; --force /tmp/demo 42",
    }, {
      id: "row-2",
      sequence: 8,
      timestamp: "2026-09-02T00:00:01Z",
      tone: "success",
      text: "PASS 12 tests",
      effect: "overflow",
    }],
    status: "RUNNING",
    connection: "live",
    machineLabel: "CPTR Computer",
    targetLabel: "task · task-1",
    canStop: true,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /CHATGPT LIVE TERMINAL/);
  assert.match(html, /CPTR Computer/);
  assert.match(html, /task · task-1/);
  assert.match(html, />LIVE</);
  assert.match(html, /SSE LIVE/);
  assert.match(html, /class="terminal-frame"/);
  assert.match(html, /class="terminal-output"/);
  assert.match(html, /class="terminal-footer"/);
  assert.match(html, /term-red term-bold/);
  assert.match(html, /term-keyword/);
  assert.match(html, /term-string/);
  assert.match(html, /term-option/);
  assert.match(html, /term-path/);
  assert.match(html, /term-number/);
  assert.match(html, /term-success/);
  assert.match(html, /term-overflow/);
  assert.equal(html.includes("terminal-seq"), false);
  assert.doesNotMatch(html, />Stop</);
  assert.doesNotMatch(html, />Copy</);
  assert.doesNotMatch(html, />Pin</);
  assert.doesNotMatch(html, />Expand</);
  assert.doesNotMatch(html, /aria-label="Terminal actions"/);
  assert.equal(html.includes("2 lines"), false);
  assert.equal(html.includes("›_"), false);
});

test("terminal text normalization matches the ChatGPT Terminal control-byte contract", () => {
  assert.equal(normalizeTerminalText("\u001b[32mgreen\u001b[0m\r\nnext\b!"), "green\nnex!");
  assert.equal(normalizeTerminalText("\u001b]0;title\u0007prompt\rprogress"), "prompt\nprogress");
});

test("terminal empty state uses the reference waiting transcript without synthetic commands", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "connecting terminal session",
    targetLabel: "Waiting for terminal session…",
    canStop: false,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /Terminal UI ready\./);
  assert.match(html, /Connecting to computer/);
  assert.match(html, /Waiting for terminal session…/);
  assert.match(html, /Waiting for terminal stream…/);
  assert.match(html, /SSE CONNECTING/);
  assert.equal(html.includes("$ "), false);
  assert.equal(html.includes("mock"), false);
  assert.equal(html.includes("terminal-empty"), false);
});

test("idle prompt lifecycle renders LIVE when the persistent prompt SSE is healthy", () => {
  const live = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "prompt live",
    machineLabel: "CPTR Computer",
    targetLabel: "Waiting for terminal session…",
  }));
  assert.match(live, />LIVE</);
  assert.match(live, /SSE LIVE/);
  assert.doesNotMatch(live, />DISCONNECTED</);

  const reconnecting = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "reconnecting prompt activity",
    machineLabel: "CPTR Computer",
    targetLabel: "Waiting for terminal session…",
  }));
  assert.match(reconnecting, />RECONNECTING</);
  assert.match(reconnecting, /SSE RECONNECTING/);
  assert.doesNotMatch(reconnecting, />DISCONNECTED</);
});

test("iOS remount with no target reports transport recovery instead of a false disconnect", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf("function usePromptActivity("), source.indexOf("function useMcpBridge("));

  assert.match(
    promptHook,
    /const \[status, setStatus\] = useState\("READY"\);/,
    "an unbound Workbench should remain ready while its prompt transport connects or recovers",
  );
  assert.doesNotMatch(
    promptHook,
    /const \[status, setStatus\] = useState\("CONNECTING"\);/,
    "transport startup must still remain separate from the execution lifecycle state",
  );

  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "reconnecting prompt activity",
    machineLabel: "CPTR Computer",
    targetLabel: "Waiting for terminal session…",
  }));

  assert.match(html, /CPTR Computer/);
  assert.match(html, />RECONNECTING</);
  assert.match(html, /SSE RECONNECTING/);
  assert.doesNotMatch(html, />DISCONNECTED</);
});

test("Direct Coding Worker metadata never clears an already-bound live command target", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf("function usePromptActivity("), source.indexOf("function useMcpBridge("));
  const workerBranch = promptHook.slice(promptHook.indexOf("event.type === \"direct.worker\""), promptHook.indexOf("event.type === \"live.bind\""));

  assert.match(workerBranch, /appendDirectWorkerActivity/);
  assert.doesNotMatch(
    workerBranch,
    /setMeta\(null\)/,
    "worker lifecycle metadata must not detach the Workbench from the command SSE target that live.bind just selected",
  );
});

test("terminal final command state exposes the real exit code in the compact footer", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [{
      id: "row-exit",
      sequence: 9,
      timestamp: "2026-09-02T00:00:02Z",
      tone: "success",
      text: "Command exited with code 0.",
    }],
    status: "COMPLETE",
    connection: "live",
    targetLabel: "command · cmd-1",
    canStop: false,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, />WAITING</);
  assert.match(html, /SSE LIVE/);
  assert.match(html, /EXIT 0/);
  assert.match(html, /data-success="true"/);
});

test("terminal keeps ChatGPT lifecycle separate from transient SSE reconnect state", () => {
  const running = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "RUNNING",
    connection: "reconnecting",
    machineLabel: "CPTR Computer",
    targetLabel: "command · cmd-running",
    canStop: true,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));
  assert.match(running, />WORKING</);
  assert.match(running, /SSE RECONNECTING/);
  assert.doesNotMatch(running, />RECONNECTING</);

  const completed = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [{
      id: "row-exit-reconnect",
      sequence: 10,
      timestamp: "2026-09-04T00:00:00Z",
      tone: "success",
      text: "Command exited with code 0.",
    }],
    status: "COMPLETE",
    connection: "reconnecting prompt activity",
    machineLabel: "CPTR Computer",
    targetLabel: "command · cmd-complete",
    canStop: false,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));
  assert.match(completed, />WAITING</);
  assert.match(completed, /SSE RECONNECTING/);
  assert.match(completed, /EXIT 0/);
  assert.doesNotMatch(completed, />EXITED</);
});

test("terminal and browser CSS share the responsive workbench geometry", () => {
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(css, /\.terminal-workbench\s*\{[^}]*width:\s*100%[^}]*margin:\s*0[^}]*padding:\s*0/);
  assert.doesNotMatch(css, /\.terminal-workbench\s*\{[^}]*max-width:/);
  assert.match(css, /--workbench-surface-height:\s*clamp\(260px, 48vw, 460px\)/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*height:\s*var\(--workbench-surface-height\)/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*min-height:\s*260px/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*max-height:\s*460px/);
  assert.match(css, /\.browser-shell\s*\{[\s\S]*height:\s*var\(--workbench-surface-height\)/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*border-radius:\s*20px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*min-height:\s*134px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*font-size:\s*12px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*line-height:\s*1\.34/);
  assert.match(css, /\.term-overflow\s*\{[^}]*display:\s*inline-block[^}]*max-width:\s*100%[^}]*animation:\s*overflow \.18s steps\(2, end\)/);
  assert.match(css, /@keyframes overflow\s*\{[^}]*transform:\s*translate3d\(0, \.9em, 0\)[\s\S]*transform:\s*translate3d\(0, 0, 0\)/);
  assert.match(css, /\.terminal-frame\s*\{[^}]*contain:\s*layout paint style/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*overscroll-behavior:\s*contain/);
  assert.match(css, /\.terminal-latest\s*\{/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*--workbench-surface-height:\s*clamp\(300px, 76vw, 340px\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.terminal-shell\s*\{[\s\S]*height:\s*var\(--workbench-surface-height\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.browser-shell\s*\{[\s\S]*height:\s*var\(--workbench-surface-height\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*min-height:\s*300px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*max-height:\s*340px/);
  const narrowCardCss = css.slice(
    css.indexOf("@media (max-width: 390px)"),
    css.indexOf("@media (max-width: 560px) and (orientation: landscape)"),
  );
  assert.doesNotMatch(narrowCardCss, /\.browser-shell\s*\{[^}]*\b(?:height|min-height|max-height):/);
  assert.doesNotMatch(narrowCardCss, /\.terminal-shell\s*\{[^}]*\b(?:height|min-height|max-height):/);
  assert.doesNotMatch(css, /\.browser-shell\[data-released="true"\]\s*\{[^}]*\b(?:height|min-height|max-height):/);
  assert.equal(css.includes("82vh"), false);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.terminal-output\s*\{[\s\S]*font-size:\s*11\.5px/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*\.terminal-output\s*\{\s*font-size:\s*11px/);
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /:root\[data-theme="light"\][^{]*\{[^}]*color-scheme:\s*light/);
  assert.match(css, /:root\[data-theme="dark"\][^{]*\{[^}]*color-scheme:\s*dark/);
  assert.match(css, /@media \(prefers-color-scheme: light\)[\s\S]*:root:not\(\[data-theme\]\)/);
  const landscapeCss = css.slice(
    css.indexOf("@media (max-width: 560px) and (orientation: landscape)"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.doesNotMatch(landscapeCss, /\.terminal-shell\s*\{[^}]*\b(?:height|min-height|max-height):/);
  assert.doesNotMatch(landscapeCss, /\.browser-shell\s*\{[^}]*\b(?:height|min-height|max-height):/);
  assert.equal(css.includes(".terminal-toolbar"), false);
  assert.equal(css.includes(".terminal-seq"), false);
  for (const obsoleteSelector of [".terminal-card", ".terminal-meta", ".terminal-actions", ".terminal-mark", ".terminal-target", ".terminal-viewport"]) {
    assert.equal(css.includes(obsoleteSelector), false, `${obsoleteSelector} must not override the reference terminal surface`);
  }
});

test("Workbench reports intrinsic height through both ChatGPT host sizing paths and does not auto-pin", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");

  assert.match(source, /new ResizeObserver\(schedule\)/);
  assert.match(source, /document\.querySelector<HTMLElement>\("\.terminal-workbench"\)/);
  assert.match(source, /getBoundingClientRect\(\)\.height/);
  assert.doesNotMatch(source, /document\.documentElement\.scrollHeight/);
  assert.doesNotMatch(source, /document\.body\.scrollHeight/);
  assert.match(source, /observer\?\.observe\(workbench\)/);
  assert.match(source, /notifyIntrinsicHeight\?\.\(height\)/);
  assert.match(source, /method: "ui\/notifications\/size-changed"/);
  assert.match(source, /params: \{ height \}/);
  assert.doesNotMatch(source, /requestHostDisplayMode\(hostBridge\(\), "pip"\)[\s\S]*autoPinAttempted/);
  assert.doesNotMatch(source, /hasWorkers\s*\?\s*<DirectWorkersView/);
  assert.match(source, /const promptActivity = usePromptActivity\(/);
  assert.match(source, /const connection = meta\?\.targetType === "workbench"/);
  assert.match(source, /meta\?\.targetId && !isTerminalWorkbenchStatus\(state\.status\)/);
  assert.match(source, /: promptActivity\.connection/);
  assert.match(source, /const displayStatus = meta\?\.targetType && meta\.targetId \? state\.status : promptActivity\.status/);
  assert.doesNotMatch(source, /meta\?\.targetId \? targetConnection : "connecting terminal session"/);
  assert.doesNotMatch(source, /displayStatus = meta\?\.targetType && meta\.targetId \? state\.status : "CONNECTING"/);
  assert.match(source, /machineLabel="CPTR Computer"/);
  assert.doesNotMatch(source, /promptActivity\.connection === "prompt live" \? "CPTR Computer" : "Connecting to computer"/);
  assert.match(source, /"Waiting for terminal session…"/);
});

test("terminal view bounds rendered DOM rows and uses a dedicated connection live region", () => {
  const source = readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8");
  assert.match(source, /MAX_RENDERED_ROWS\s*=\s*600/);
  assert.match(source, /MOBILE_RENDERED_ROWS\s*=\s*320/);
  assert.match(source, /MOBILE_RENDER_QUERY\s*=\s*"\(max-width: 560px\)"/);
  assert.match(source, /rows\.slice\(rows\.length - renderedRowLimit\)/);
  assert.match(source, /matchMedia\(MOBILE_RENDER_QUERY\)/);
  assert.match(source, /className="terminal-latest"/);
  assert.match(source, /aria-live="off"/);
  assert.match(source, /terminal-status[^\n]*role="status" aria-live="polite"/);
  assert.match(source, /data-transport=\{transport\}/);
});

test("terminal view memoizes stable rows and frame-coalesces follow scrolling", () => {
  const source = readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8");

  assert.match(source, /const TerminalLine = React\.memo\(/);
  assert.match(source, /<TerminalLine key=\{row\.id\} row=\{row\} \/>/);
  assert.match(source, /const tailFrame = useRef<number \| null>\(null\)/);
  assert.match(source, /if \(tailFrame\.current !== null\) return/);
  assert.match(source, /element\.scrollTop = element\.scrollHeight/);
  assert.match(source, /window\.requestAnimationFrame\(/);
  assert.match(source, /window\.cancelAnimationFrame\(/);
});

test("follow-tail stays enabled near the bottom and pauses when the user scrolls away", () => {
  assert.equal(isNearTerminalTail(1000, 776, 200), true, "24px from tail remains attached");
  assert.equal(isNearTerminalTail(1000, 775, 200), false, "25px from tail pauses follow mode");
  assert.equal(isNearTerminalTail(1000, 600, 200), false);
  assert.equal(isNearTerminalTail(1000, 800, 200), true);
});

test("terminal follow-tail disables browser scroll anchoring and smooth-scroll lag", () => {
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");
  assert.match(css, /\.terminal-output\s*\{[\s\S]*overflow-anchor:\s*none/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*scroll-behavior:\s*auto/);
});

test("terminal follow changes are edge-triggered instead of writing ChatGPT widget state on every scroll frame", () => {
  const source = readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8");

  assert.match(source, /const followRef = useRef\(follow\)/);
  assert.match(source, /followRef\.current = follow/);
  assert.match(source, /if \(value === followRef\.current\) return/);
  assert.match(source, /followRef\.current = value/);
  assert.match(source, /onFollowChange\?\.\(value\)/);
});

test("paired Chrome surface publishing preserves authoritative lease and command ownership", () => {
  const mcpSource = readFileSync(new URL("../server/mcp.ts", import.meta.url), "utf8");
  assert.match(mcpSource, /const nestedLease = recordFrom\(commandPayload\.lease\)/);
  assert.match(mcpSource, /Object\.keys\(topLevelLease\)\.length > 0 \? topLevelLease : nestedLease/);
  assert.match(mcpSource, /action === "command" \|\| action === "approve_evaluate"/);
  assert.match(mcpSource, /semanticOwner === "agent"[\s\S]*\? "AGENT_CONTROL"/);
  assert.match(mcpSource, /result\.epoch \?\? lease\.epoch \?\? input\.expected_epoch/);
  assert.match(mcpSource, /ticketForBrowserSession\(sessionId\) \?\? currentPromptTicket\(\)/);
});

test("Workbench switches terminal and browser inside one persistent root", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const browserSource = readFileSync(new URL("../web/src/browser-surface.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(source, /useState<"terminal" \| "browser">\(restoredUiState\.current\.surfaceMode \?\? "terminal"\)/);
  assert.match(source, /<BrowserSurface/);
  assert.match(source, /if \(!sessionId\) return/);
  assert.match(source, /owner === "none"[\s\S]*\? "DISCONNECTED"/);
  assert.match(source, /released=\{browserSurface\?\.owner === "none"/);
  assert.match(source, /<TerminalView/);
  assert.match(source, /createRoot\(root\)\.render\(<Workbench \/>\)/);
  assert.equal((source.match(/createRoot\(/g) ?? []).length, 1);
  assert.match(browserSource, /canvasRef/);
  assert.match(browserSource, /context\.drawImage\(/);
  assert.match(browserSource, /new IntersectionObserver\(/);
  assert.match(browserSource, /document\.visibilityState === "hidden"/);
  assert.match(browserSource, /controller\?\.abort\(\)/);
  assert.match(browserSource, /createImageBitmap\(blob\)/);
  assert.match(browserSource, /No Chrome session is attached yet/);
  assert.match(browserSource, /Browser control released\. Chrome debugger is detached/);
  assert.match(browserSource, /Browser preview interrupted — reconnecting/);
  assert.match(browserSource, /response\.status === 204[\s\S]*setFrameHealth\("waiting"\)/);
  assert.match(browserSource, /frameHealth === "live"[\s\S]*\? "LIVE"/);
  assert.match(browserSource, /\/live\/prompt\/browser-stream/);
  assert.match(browserSource, /max_fps:\s*requestedVisible \? 10 : 0/);
  assert.match(browserSource, /streamConfigQueue\.current = streamConfigQueue\.current\.then/);
  assert.match(browserSource, /lastStreamConfig\.current = \{ key: requestedKey, visible: requestedVisible \}/);
  assert.match(browserSource, /streamConfigUncertain\.current = true/);
  assert.match(browserSource, /Browser preview setup interrupted — retrying/);
  assert.match(browserSource, /streamConfigRetryAttempts/);
  assert.match(browserSource, /configureSourceVisibility\(false\)/);
  assert.match(browserSource, /mode === "HUMAN_CONTROL"/);
  assert.match(browserSource, /expected_epoch:\s*epoch/);
  assert.match(browserSource, /clamp01\(/);
  assert.match(browserSource, /pendingMove\.current/);
  assert.match(browserSource, /input_type:\s*"pointer_move"/);
  assert.match(browserSource, /input_type:\s*"wheel"/);
  assert.match(browserSource, /input_type:\s*"text_input"/);
  assert.doesNotMatch(source, /useState<BrowserFrame/);
  assert.doesNotMatch(browserSource, /frame:\s*BrowserFrame/);
  assert.match(css, /\.browser-canvas\s*\{[^}]*touch-action:\s*none/);
  assert.match(css, /\.browser-status\[data-state="connecting"\]/);
  assert.match(css, /\.browser-empty\[data-state="released"\] strong/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.browser-shell/);
});

test("Workbench recovery contract survives iOS suspension, replay, and browser lease changes", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const browserSource = readFileSync(new URL("../web/src/browser-surface.tsx", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf("function usePromptActivity("), source.indexOf("function useMcpBridge("));
  const promptConsume = promptHook.slice(promptHook.indexOf("const consume = async () => {"), promptHook.indexOf("const wake = () =>"));

  assert.ok(promptConsume.indexOf("const response = await fetch(url") < promptConsume.indexOf("await applySnapshot()"), "prompt SSE must open before snapshot fallback so startup is not delayed by an extra round trip");
  assert.match(promptConsume, /setConnection\("connecting prompt activity"\)/);
  assert.doesNotMatch(source, /retryAttempts\s*>=\s*8/);
  assert.match(source, /terminalFailure/);
  assert.match(source, /X-CPTR-Viewer-ID/);
  assert.match(source, /X-CPTR-Viewer-Started-At/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /\[401, 403, 410\]\.includes\(response\.status\)/);
  assert.match(promptHook, /if \(stopped \|\| terminalFailure\) return/);
  assert.match(source, /addEventListener\("pageshow"/);
  assert.match(source, /addEventListener\("online"/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /renewUrl/);
  assert.match(source, /visibleBrowserSession\.current !== sessionId/);
  assert.match(source, /if \(shouldAutoOpenBrowser\) setSurfaceMode\("browser"\)/);
  assert.match(browserSource, /keepalive:\s*true/);
  assert.match(browserSource, /if\s*\(!response\.ok\)/);
  assert.match(browserSource, /response\.status\s*===\s*409/);
  assert.match(browserSource, /consecutiveNoFrames/);
  assert.match(browserSource, /viewer_id/);
  assert.match(source, /terminalViewState/);
  assert.match(readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8"), /onScrollTopChange/);
});

test("Workbench consumes standard MCP Apps tool-result notifications to refresh prompt metadata", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const bridge = source.slice(source.indexOf("function useMcpBridge("), source.indexOf("function useLiveSession("));

  assert.match(bridge, /message\.method === "ui\/notifications\/tool-result"/);
  assert.match(bridge, /const source = message\.params \?\? hostBridge\(\)\?\.toolResponseMetadata/);
  assert.match(bridge, /findPromptMetadata\(source\)/);
  assert.match(bridge, /findLiveMetadata\(source\)/);
  assert.match(bridge, /setPromptMetadata\(nextPrompt\)/);
  assert.match(bridge, /setLiveMetadata\(nextLive\)/);
  assert.match(source, /useMcpBridge\(setPromptMetadata, setMeta\)/);
});

test("Workbench follows the documented ChatGPT theme globals without owning host appearance", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const themeHook = source.slice(source.indexOf("function useHostTheme()"), source.indexOf("function useWorkbenchAutoSize()"));

  assert.match(themeHook, /hostBridge\(\)\?\.theme/);
  assert.match(themeHook, /openai:set_globals/);
  assert.match(themeHook, /detail\?\.globals\?\.theme/);
  assert.match(themeHook, /document\.documentElement\.dataset\.theme = value/);
  assert.match(source, /useHostTheme\(\)/);
});

test("browser surface auto-opens once per new session and then preserves the user's selected tab", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf("function usePromptActivity("), source.indexOf("function useMcpBridge("));

  assert.match(promptHook, /const visibleBrowserSession = useRef<string \| null>\(null\)/);
  assert.match(promptHook, /surfacePreference\.current === undefined/);
  assert.match(promptHook, /visibleBrowserSession\.current !== sessionId/);
  assert.match(promptHook, /visibleBrowserSession\.current = sessionId/);
  assert.match(promptHook, /if \(shouldAutoOpenBrowser\) setSurfaceMode\("browser"\)/);
  assert.doesNotMatch(promptHook, /if \(isLiveEvent && owner !== "none"\) setSurfaceMode\("browser"\)/);
});

test("Workbench persists only ephemeral presentation preferences across ChatGPT remounts", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const stateReader = source.slice(source.indexOf("function readWorkbenchUiState("), source.indexOf("function persistWorkbenchUiState("));
  const persistence = source.slice(source.indexOf("function persistWorkbenchUiState("), source.indexOf("function useHostTheme()"));

  assert.match(source, /widgetState\?: unknown/);
  assert.match(source, /setWidgetState\?: \(state: Record<string, unknown>\) => void/);
  assert.match(source, /readWorkbenchUiState\(hostBridge\(\)\?\.widgetState\)/);
  assert.match(stateReader, /record\.surfaceMode === "terminal" \|\| record\.surfaceMode === "browser"/);
  assert.match(stateReader, /typeof record\.terminalFollow === "boolean"/);
  assert.doesNotMatch(stateReader, /ticket|workspace|target|browserSurface|promptMetadata|meta/);
  assert.match(persistence, /next\.surfaceMode === current\.current\.surfaceMode/);
  assert.match(persistence, /next\.terminalFollow === current\.current\.terminalFollow/);
  assert.match(persistence, /return;/);
  assert.match(persistence, /hostBridge\(\)\?\.setWidgetState\?\.\(next\)/);
  assert.match(source, /restoredUiState\.current\.surfaceMode \?\? "terminal"/);
  assert.match(source, /restoredUiState\.current\.terminalFollow \?\? true/);
  assert.match(source, /persistWorkbenchUiState\(persistedUiState, \{ surfaceMode: next \}\)/);
  assert.match(source, /persistWorkbenchUiState\(persistedUiState, \{ terminalFollow: follow \}\)/);
  assert.match(source, /surfacePreference\.current === undefined/);
  assert.doesNotMatch(source, /persistWorkbenchUiState\([^\n]*scrollTop/);
});

test("Workbench collapses to zero height and inhibits retry when superseded by newer Workbench", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(source, /eventName === "superseded"/);
  assert.match(source, /stopTerminalFailure\("superseded by newer Workbench"\)/);
  assert.match(source, /isSuperseded/);
  assert.match(source, /is-superseded/);
  assert.match(css, /\.terminal-workbench\.is-superseded/);
});
