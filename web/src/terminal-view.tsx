import React, { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalRow } from "./state.js";

export type TerminalViewProps = {
  rows: TerminalRow[];
  status: string;
  connection: string;
  machineLabel?: string;
  targetLabel: string;
  actionStatus?: string;
  updateCenter?: React.ReactNode;
  canStop: boolean;
  onStop: () => void;
  onCopy: () => void;
  onPin: () => void;
  onExpand: () => void;
};

type TerminalDisplayState = "connecting" | "live" | "waiting" | "reconnecting" | "offline" | "exited" | "closed" | "failed";

type RichToken = {
  text: string;
  className?: string;
};

const TERM_RE = /(^.*?[$#>]\s)([\w./:+-]+)?|(^\s*(?:\/\/|#\s)[^\n]*)|\b(ERROR|FAIL|FATAL|EXCEPTION)\b|\b(WARN(?:ING)?)\b|\b(PASS|SUCCESS|DONE|OK)\b|("[^"\n]*"|'[^'\n]*')|(--?[\w-]+)|((?:~|\.{1,2})?\/[^\s"';|&]+)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|class|if|else|for|while|return|import|from|export|async|await|new|true|false|null|undefined)\b/gim;
const TERM_KIND = ["", "prompt", "command", "comment", "error", "warning", "success", "string", "option", "path", "number", "keyword"];
const ANSI_SGR_RE = /\u001b\[([0-9;]*)m/g;
const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const MAX_RENDERED_ROWS = 600;
const MOBILE_RENDERED_ROWS = 320;
const MOBILE_RENDER_QUERY = "(max-width: 560px)";

function initialRenderedRowLimit(): number {
  if (typeof window === "undefined") return MAX_RENDERED_ROWS;
  return window.matchMedia(MOBILE_RENDER_QUERY).matches ? MOBILE_RENDERED_ROWS : MAX_RENDERED_ROWS;
}

/**
 * Byte-for-byte behavioral port of the ChatGPT Terminal UI text normalizer.
 * It removes terminal cursor/control traffic while preserving stable text order.
 */
export function normalizeTerminalText(input: string): string {
  let output = "";
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input[index + 1];
      if (next === "[") {
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index++);
          if (control >= 0x40 && control <= 0x7e) break;
        }
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index);
          if (control === 0x07) {
            index += 1;
            break;
          }
          if (control === 0x1b && input[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += Math.min(2, input.length - index);
      continue;
    }
    if (code === 0x08) {
      output = output.slice(0, -1);
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      if (input.charCodeAt(index + 1) === 0x0a) index += 1;
      output += "\n";
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      index += 1;
      continue;
    }
    output += input[index] ?? "";
    index += 1;
  }
  return output;
}

function highlightPlainText(input: string): RichToken[] {
  const text = normalizeTerminalText(input);
  const tokens: RichToken[] = [];
  let end = 0;
  TERM_RE.lastIndex = 0;
  for (const match of text.matchAll(TERM_RE)) {
    const at = match.index ?? 0;
    if (at > end) tokens.push({ text: text.slice(end, at) });
    if (match[1]) {
      tokens.push({ text: match[1], className: "term-prompt" });
      if (match[2]) tokens.push({ text: match[2], className: "term-command" });
    } else {
      const kindIndex = match.slice(1).findIndex(Boolean) + 1;
      const kind = TERM_KIND[kindIndex];
      tokens.push({ text: match[0], ...(kind ? { className: `term-${kind}` } : {}) });
    }
    end = at + match[0].length;
  }
  if (end < text.length) tokens.push({ text: text.slice(end) });
  return tokens;
}

function richTerminalText(input: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let at = 0;
  let color = "";
  let bold = false;
  let key = 0;

  const append = (text: string) => {
    if (!text) return;
    const tokens = highlightPlainText(text);
    for (const token of tokens) {
      const tokenNode = token.className
        ? <span className={token.className}>{token.text}</span>
        : token.text;
      const styleClass = `${color ? `term-${color}` : ""}${bold ? " term-bold" : ""}`.trim();
      nodes.push(styleClass
        ? <span className={styleClass} key={key++}>{tokenNode}</span>
        : <React.Fragment key={key++}>{tokenNode}</React.Fragment>);
    }
  };

  ANSI_SGR_RE.lastIndex = 0;
  for (const match of input.matchAll(ANSI_SGR_RE)) {
    const position = match.index ?? 0;
    append(input.slice(at, position));
    for (const code of (match[1] || "0").split(";").map(Number)) {
      if (!code) {
        color = "";
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        color = "";
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        color = ANSI_COLORS[code >= 90 ? code - 90 : code - 30] ?? "";
      }
    }
    at = position + match[0].length;
  }
  append(input.slice(at));
  return nodes;
}

const TerminalLine = React.memo(function TerminalLine({ row }: { row: TerminalRow }) {
  return <>
    <span className={`terminal-line terminal-${row.tone}${row.effect === "overflow" ? " term-overflow" : ""}`}>
      {richTerminalText(row.text)}
    </span>{"\n"}
  </>;
});

function displayState(status: string, connection: string): TerminalDisplayState {
  const normalizedStatus = status.toUpperCase();
  if (["FAILED", "BLOCKED", "REJECTED", "COMPLETE_WITH_TOOL_ERRORS"].includes(normalizedStatus)) return "failed";
  if (normalizedStatus === "CANCELLED") return "closed";

  const normalizedConnection = connection.toLowerCase();
  if (normalizedStatus === "COMPLETE") {
    return normalizedConnection.includes("live") && !normalizedConnection.includes("disabled") ? "waiting" : "exited";
  }
  if (normalizedConnection.includes("reconnect")) return "reconnecting";
  if (normalizedConnection.includes("live") && !normalizedConnection.includes("disabled")) return "live";
  if (
    normalizedConnection.includes("connect") ||
    normalizedConnection.includes("recover") ||
    normalizedConnection.includes("renew")
  ) return "connecting";
  return "offline";
}

function exitCodeFromRows(rows: TerminalRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const match = rows[index]?.text.match(/Command exited with code (-?\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

export function TerminalView({
  rows,
  status,
  connection,
  machineLabel = "Connecting to computer",
  targetLabel,
}: TerminalViewProps) {
  const output = useRef<HTMLPreElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [renderedRowLimit, setRenderedRowLimit] = useState(initialRenderedRowLimit);
  const state = displayState(status, connection);
  const exitCode = exitCodeFromRows(rows);
  const hiddenRowCount = Math.max(0, rows.length - renderedRowLimit);
  const visibleRows = useMemo(
    () => hiddenRowCount ? rows.slice(rows.length - renderedRowLimit) : rows,
    [hiddenRowCount, renderedRowLimit, rows],
  );

  useEffect(() => {
    const media = window.matchMedia(MOBILE_RENDER_QUERY);
    const update = () => setRenderedRowLimit(media.matches ? MOBILE_RENDERED_ROWS : MAX_RENDERED_ROWS);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!follow) return;
    const frame = window.requestAnimationFrame(() => {
      const element = output.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleRows, follow]);

  useEffect(() => () => {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
  }, []);

  const onScroll = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const element = output.current;
      if (!element) return;
      setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
    });
  };

  return <section className="terminal-shell" data-state={state} aria-label="CPTR live terminal">
    <header className="terminal-header">
      <div className="terminal-identity">
        <div className="terminal-kicker">CHATGPT LIVE TERMINAL</div>
        <div className="terminal-machine-row">
          <span className="terminal-machine">{machineLabel}</span>
          <span className="terminal-status" data-state={state} role="status" aria-live="polite">
            <span className="state-dot" aria-hidden="true" />
            <span>{state.toUpperCase()}</span>
          </span>
        </div>
        <div className="terminal-path" title={targetLabel}>{targetLabel}</div>
      </div>
    </header>

    <section className="terminal-frame" aria-label="Real-time ChatGPT terminal activity over SSE">
      <pre
        className="terminal-output"
        ref={output}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Live terminal output"
        aria-live="off"
      >
        {hiddenRowCount > 0 && <span className="terminal-history-note">… {hiddenRowCount} earlier lines retained outside the render window{"\n"}</span>}
        {visibleRows.length ? visibleRows.map((row) => <TerminalLine key={row.id} row={row} />) : <>Terminal UI ready.{"\n"}Waiting for terminal stream…</>}
      </pre>
      {!follow && <button className="terminal-latest" type="button" onClick={() => setFollow(true)}>Latest</button>}
    </section>

    <footer className="terminal-footer">
      <span>shell</span>
      <span>SSE {state === "live" || state === "waiting" ? "LIVE" : state === "connecting" ? "CONNECTING" : state === "reconnecting" ? "RECONNECTING" : "OFFLINE"}</span>
      {exitCode === null ? null : <span className="terminal-exit" data-success={exitCode === 0 ? "true" : "false"}>EXIT {exitCode}</span>}
    </footer>
  </section>;
}
