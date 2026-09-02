import React, { useEffect, useRef, useState } from "react";
import type { TerminalRow } from "./state.js";

export type TerminalViewProps = {
  rows: TerminalRow[];
  status: string;
  connection: string;
  targetLabel: string;
  actionStatus?: string;
  updateCenter?: React.ReactNode;
  canStop: boolean;
  onStop: () => void;
  onCopy: () => void;
  onPin: () => void;
  onExpand: () => void;
};

type TerminalDisplayState = "connecting" | "live" | "reconnecting" | "offline" | "exited" | "closed" | "failed";

type RichToken = {
  text: string;
  className?: string;
};

const TERM_RE = /(^.*?[$#>]\s)([\w./:+-]+)?|(^\s*(?:\/\/|#\s)[^\n]*)|\b(ERROR|FAIL|FATAL|EXCEPTION)\b|\b(WARN(?:ING)?)\b|\b(PASS|SUCCESS|DONE|OK)\b|("[^"\n]*"|'[^'\n]*')|(--?[\w-]+)|((?:~|\.{1,2})?\/[^\s"';|&]+)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|class|if|else|for|while|return|import|from|export|async|await|new|true|false|null|undefined)\b/gim;
const TERM_KIND = ["", "prompt", "command", "comment", "error", "warning", "success", "string", "option", "path", "number", "keyword"];
const ANSI_SGR_RE = /\u001b\[([0-9;]*)m/g;
const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

function highlightPlainText(input: string): RichToken[] {
  const tokens: RichToken[] = [];
  let end = 0;
  TERM_RE.lastIndex = 0;
  for (const match of input.matchAll(TERM_RE)) {
    const at = match.index ?? 0;
    if (at > end) tokens.push({ text: input.slice(end, at) });
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
  if (end < input.length) tokens.push({ text: input.slice(end) });
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

function displayState(status: string, connection: string): TerminalDisplayState {
  const normalizedStatus = status.toUpperCase();
  if (["FAILED", "BLOCKED", "REJECTED", "COMPLETE_WITH_TOOL_ERRORS"].includes(normalizedStatus)) return "failed";
  if (normalizedStatus === "CANCELLED") return "closed";
  if (normalizedStatus === "COMPLETE") return "exited";

  const normalizedConnection = connection.toLowerCase();
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
  targetLabel,
}: TerminalViewProps) {
  const output = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const state = displayState(status, connection);
  const exitCode = exitCodeFromRows(rows);

  useEffect(() => {
    if (!follow) return;
    const element = output.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [rows, follow]);

  const onScroll = () => {
    const element = output.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  };

  return <section className="terminal-shell" data-state={state} aria-label="CPTR live terminal">
    <header className="terminal-header">
      <div className="terminal-identity">
        <div className="terminal-kicker">CHATGPT LIVE TERMINAL</div>
        <div className="terminal-machine-row">
          <span className="terminal-machine">CPTR Computer</span>
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
        aria-live="polite"
        aria-relevant="additions text"
      >
        {rows.length ? rows.map((row) => <React.Fragment key={row.id}>
          <span className={`terminal-line terminal-${row.tone} term-overflow`}>{richTerminalText(row.text)}</span>{"\n"}
        </React.Fragment>) : <>Terminal UI ready.{"\n"}Waiting for terminal stream…</>}
      </pre>
    </section>

    <footer className="terminal-footer">
      <span>shell</span>
      <span>SSE {state === "live" ? "LIVE" : state === "connecting" ? "CONNECTING" : state === "reconnecting" ? "RECONNECTING" : "OFFLINE"}</span>
      {exitCode === null ? null : <span className="terminal-exit" data-success={exitCode === 0 ? "true" : "false"}>EXIT {exitCode}</span>}
    </footer>
  </section>;
}
