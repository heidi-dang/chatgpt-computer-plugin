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

export function TerminalView({
  rows,
  status,
  connection,
  targetLabel,
  actionStatus,
  updateCenter,
  canStop,
  onStop,
  onCopy,
  onPin,
  onExpand,
}: TerminalViewProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [rows, follow]);

  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
  };

  return <section className="terminal-card" aria-label="CPTR live terminal">
    <header className="terminal-header">
      <div className="terminal-identity">
        <span className="terminal-mark" aria-hidden="true">›_</span>
        <div>
          <strong>Live Terminal</strong>
          <span className="terminal-target" title={targetLabel}>{targetLabel}</span>
        </div>
      </div>
      <div className={`terminal-status terminal-status-${status.toLowerCase()}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span>{status}</span>
      </div>
    </header>

    {updateCenter}

    <div className="terminal-meta">
      <span>{connection}</span>
      <span>{rows.length ? `${rows.length} lines` : "waiting for output"}</span>
    </div>

    <div
      className="terminal-viewport"
      ref={viewport}
      onScroll={onScroll}
      tabIndex={0}
      aria-label="Live redacted terminal transcript"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {rows.length ? rows.map((row) => <div className={`terminal-row terminal-${row.tone}`} key={row.id}>
        <span className="terminal-seq" aria-hidden="true">{row.label ?? row.sequence}</span>
        <code>{row.text}</code>
      </div>) : <div className="terminal-empty">
        <strong>Terminal ready</strong>
        <span>CPTR tool activity and real command output will appear here.</span>
      </div>}
    </div>

    <footer className="terminal-actions" aria-label="Live terminal controls">
      <div className="terminal-actions-primary">
        <button className="danger" disabled={!canStop} onClick={onStop}>Stop</button>
        <button disabled={!rows.length} onClick={onCopy}>Copy</button>
        <button onClick={onPin}>Pin</button>
        <button onClick={onExpand}>Expand</button>
        {!follow && <button onClick={() => setFollow(true)}>Latest</button>}
      </div>
      {actionStatus && <span className="action-status" role="status">{actionStatus}</span>}
    </footer>
  </section>;
}
