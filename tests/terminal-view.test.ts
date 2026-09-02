import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView } from "../web/src/terminal-view.js";

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
    }],
    status: "RUNNING",
    connection: "live",
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
  assert.equal(html.includes("term-overflow"), false);
  assert.equal(html.includes("terminal-seq"), false);
  assert.equal(html.includes(">Stop<"), false);
  assert.equal(html.includes(">Copy<"), false);
  assert.equal(html.includes(">Pin<"), false);
  assert.equal(html.includes(">Expand<"), false);
  assert.equal(html.includes("2 lines"), false);
  assert.equal(html.includes("›_"), false);
});

test("terminal empty state uses the reference waiting transcript without synthetic commands", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "activity feed ready",
    targetLabel: "Ready for real CPTR activity",
    canStop: false,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /Terminal UI ready\./);
  assert.match(html, /Waiting for terminal stream…/);
  assert.match(html, /SSE OFFLINE/);
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

  assert.match(html, />EXITED</);
  assert.match(html, /EXIT 0/);
  assert.match(html, /data-success="true"/);
});

test("terminal CSS preserves the reference desktop and mobile geometry", () => {
  const css = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");

  assert.match(css, /\.terminal-workbench\s*\{[^}]*width:\s*100%[^}]*margin:\s*0[^}]*padding:\s*0/);
  assert.doesNotMatch(css, /\.terminal-workbench\s*\{[^}]*max-width:/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(260px, 1fr\) auto/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*min-height:\s*380px/);
  assert.match(css, /\.terminal-shell\s*\{[\s\S]*border-radius:\s*20px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*min-height:\s*254px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*font-size:\s*12px/);
  assert.match(css, /\.terminal-output\s*\{[\s\S]*line-height:\s*1\.34/);
  assert.equal(css.includes(".term-overflow"), false);
  assert.equal(css.includes("@keyframes overflow"), false);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*min-height:\s*340px/);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*min-height:\s*320px/);
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
  assert.match(source, /window\.matchMedia\("\(max-width: 390px\)"\)/);
  assert.match(source, /\? 320/);
  assert.match(source, /\? 340/);
  assert.match(source, /: 380/);
  assert.match(source, /notifyIntrinsicHeight\?\.\(height\)/);
  assert.match(source, /method: "ui\/notifications\/size-changed"/);
  assert.match(source, /params: \{ height \}/);
  assert.doesNotMatch(source, /requestHostDisplayMode\(hostBridge\(\), "pip"\)[\s\S]*autoPinAttempted/);
});
