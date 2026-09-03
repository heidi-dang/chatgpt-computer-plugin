import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView, normalizeTerminalText } from "../web/src/terminal-view.js";

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
  assert.equal(html.includes(">Stop<"), false);
  assert.equal(html.includes(">Copy<"), false);
  assert.equal(html.includes(">Pin<"), false);
  assert.equal(html.includes(">Expand<"), false);
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

test("terminal CSS preserves the reference desktop and mobile geometry", () => {
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(css, /\.terminal-workbench\s*\{[^}]*width:\s*100%[^}]*margin:\s*0[^}]*padding:\s*0/);
  assert.doesNotMatch(css, /\.terminal-workbench\s*\{[^}]*max-width:/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*height:\s*clamp\(260px, 36vw, 360px\)/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*min-height:\s*260px/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*max-height:\s*360px/);
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
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*height:\s*clamp\(220px, 62vw, 280px\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*min-height:\s*220px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*max-height:\s*280px/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*min-height:\s*210px/);
  assert.equal(css.includes("82vh"), false);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.terminal-output\s*\{[\s\S]*font-size:\s*11\.5px/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*\.terminal-output\s*\{\s*font-size:\s*11px/);
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
  assert.match(source, /const promptConnection = usePromptActivity\(/);
  assert.match(source, /const connection = meta\?\.targetId && !isTerminalWorkbenchStatus\(state\.status\) \? targetConnection : promptConnection/);
  assert.doesNotMatch(source, /meta\?\.targetId \? targetConnection : "connecting terminal session"/);
  assert.match(source, /promptConnection === "prompt live" \? "CPTR Computer" : "Connecting to computer"/);
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
});

test("terminal view memoizes stable rows and frame-coalesces follow scrolling", () => {
  const source = readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8");

  assert.match(source, /const TerminalLine = React\.memo\(/);
  assert.match(source, /<TerminalLine key=\{row\.id\} row=\{row\} \/>/);
  assert.match(source, /window\.requestAnimationFrame\(/);
  assert.match(source, /window\.cancelAnimationFrame\(/);
});

test("Workbench switches terminal and browser inside one persistent root", () => {
  const source = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
  const browserSource = readFileSync(new URL("../web/src/browser-surface.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(source, /useState<"terminal" \| "browser">\("terminal"\)/);
  assert.match(source, /<BrowserSurface/);
  assert.match(source, /<TerminalView/);
  assert.match(source, /createRoot\(root\)\.render\(<Workbench \/>\)/);
  assert.equal((source.match(/createRoot\(/g) ?? []).length, 1);
  assert.match(browserSource, /canvasRef/);
  assert.match(browserSource, /context\.drawImage\(/);
  assert.doesNotMatch(browserSource, /setState\([^)]*frame/);
  assert.match(css, /\.browser-canvas\s*\{[^}]*touch-action:\s*none/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.browser-shell/);
});
