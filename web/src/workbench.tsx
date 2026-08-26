import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  initialWorkbenchState,
  reduceWorkbenchEvent,
  type TerminalRow,
  type WorkbenchEvent,
  type WorkbenchState,
} from "./state.js";
import "./workbench.css";

type LiveMetadata = {
  ticket?: string;
  streamUrl?: string;
  snapshotUrl?: string;
  expiresAt?: number;
  targetType?: "task" | "monitor";
  targetId?: string;
};

type BridgeMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

type HostBridge = {
  toolResponseMetadata?: unknown;
  callTool?: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  notifyIntrinsicHeight?: (height: number) => void;
  requestDisplayMode?: (mode: "inline" | "fullscreen" | "pip") => Promise<unknown>;
};

const terminalStatuses = new Set(["COMPLETE", "CANCELLED", "FAILED", "BLOCKED"]);

function hostBridge(): HostBridge | undefined {
  return (window as Window & { openai?: HostBridge }).openai;
}

function findLiveMetadata(value: unknown): LiveMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record["cptr/live"];
  if (direct && typeof direct === "object" && "ticket" in direct) return direct as LiveMetadata;
  for (const key of ["_meta", "params", "result", "toolResult"]) {
    const found = findLiveMetadata(record[key]);
    if (found) return found;
  }
  return null;
}

function useLiveMetadata(): LiveMetadata | null {
  const [metadata, setMetadata] = useState<LiveMetadata | null>(() => findLiveMetadata(hostBridge()?.toolResponseMetadata));
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent) return;
      if (event.data?.method !== "ui/notifications/tool-result") return;
      const found = findLiveMetadata(event.data.params);
      if (found) setMetadata(found);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return metadata;
}

function useMcpBridge() {
  const pending = useRef(new Map<string | number, (value: unknown) => void>());
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.id === undefined) return;
      const resolve = pending.current.get(message.id);
      if (resolve) {
        pending.current.delete(message.id);
        resolve(message.result);
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: `init-${crypto.randomUUID()}`,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "cptr-live-terminal", version: "0.2.0" } },
    }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (name: string, args: Record<string, unknown>) => {
    if (hostBridge()?.callTool) return hostBridge()!.callTool!(name, args);
    const id = `call-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      pending.current.set(id, resolve);
      window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "*");
    });
  };
}

function useLiveSession(meta: LiveMetadata | null, setState: React.Dispatch<React.SetStateAction<WorkbenchState>>) {
  const [connection, setConnection] = useState("waiting for live terminal");
  const cursor = useRef(0);
  useEffect(() => {
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("live metadata unavailable");
      return;
    }
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let stopped = false;
    let terminalSeen = false;
    let retryAttempts = 0;

    const applySnapshot = async () => {
      const snapshotUrl = new URL(meta.snapshotUrl!, window.location.href);
      snapshotUrl.searchParams.set("after", String(cursor.current));
      const response = await fetch(snapshotUrl, {
        headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`snapshot unavailable (${response.status})`);
      const value = await response.json() as { snapshot?: { status?: string }; replay?: { events?: WorkbenchEvent[]; last_sequence?: number } };
      for (const event of value.replay?.events ?? []) {
        if (event.sequence > cursor.current) {
          cursor.current = event.sequence;
          setState((current) => reduceWorkbenchEvent(current, event));
        }
      }
      const status = value.snapshot?.status;
      if (typeof status === "string") {
        setState((current) => ({ ...current, status: status.toUpperCase() }));
        terminalSeen = terminalStatuses.has(status.toUpperCase());
      }
      const lastSequence = value.replay?.last_sequence;
      if (typeof lastSequence === "number") cursor.current = Math.max(cursor.current, lastSequence);
    };

    const scheduleRetry = (run: () => void) => {
      if (retryAttempts >= 8) {
        setConnection("reconnect limit reached");
        return;
      }
      const delay = Math.min(15_000, 1_000 * 2 ** retryAttempts);
      retryAttempts += 1;
      retryTimer = window.setTimeout(run, delay);
      setConnection("reconnecting");
    };

    const consume = async () => {
      try {
        setConnection("recovering session");
        await applySnapshot();
        if (terminalSeen || stopped) return;
        const streamUrl = new URL(meta.streamUrl!, window.location.href);
        streamUrl.searchParams.set("after", String(cursor.current));
        setConnection("connecting");
        const response = await fetch(streamUrl, {
          headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "text/event-stream", "Last-Event-ID": String(cursor.current) },
          signal: controller.signal,
        });
        if ([401, 403, 404, 410].includes(response.status)) {
          setConnection(`stream unavailable (${response.status})`);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`stream unavailable (${response.status})`);
        retryAttempts = 0;
        setConnection("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "message";
        let data: string[] = [];
        const dispatch = () => {
          if (!data.length) return;
          try {
            const value = JSON.parse(data.join("\n")) as WorkbenchEvent | { snapshot?: { status?: string } };
            if (eventName === "snapshot") {
              const status = (value as { snapshot?: { status?: string } }).snapshot?.status;
              if (typeof status === "string") {
                setState((current) => ({ ...current, status: status.toUpperCase() }));
                terminalSeen = terminalStatuses.has(status.toUpperCase());
              }
            } else {
              const event = value as WorkbenchEvent;
              if (event.sequence > cursor.current) {
                cursor.current = event.sequence;
                setState((current) => reduceWorkbenchEvent(current, event));
              }
              const status = typeof event.payload?.status === "string" ? event.payload.status.toUpperCase() : "";
              if (event.type.endsWith(".terminal") || terminalStatuses.has(status)) terminalSeen = true;
            }
          } catch {
            setConnection("received invalid event");
          }
          eventName = "message";
          data = [];
        };
        while (!stopped) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line === "") dispatch();
            else if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
        }
        if (!stopped && !terminalSeen) scheduleRetry(consume);
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        setConnection(error instanceof Error ? error.message : "stream error");
        scheduleRetry(consume);
      }
    };

    void consume();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [meta?.ticket, meta?.streamUrl, meta?.snapshotUrl, meta?.targetType, meta?.targetId, setState]);
  return connection;
}

function eventText(event: WorkbenchEvent): string {
  const payload = event.payload ?? {};
  const text = payload.text ?? payload.summary ?? payload.message ?? payload.status ?? payload.path ?? "event";
  return String(text).slice(0, 500);
}

function EventList({ events, empty }: { events: WorkbenchEvent[]; empty: string }) {
  if (!events.length) return <p className="empty">{empty}</p>;
  return <div className="event-list">{events.slice().reverse().map((event) => (
    <article className="event" key={event.event_id}>
      <div className="event-top"><span className="event-type">{event.type}</span><time>{new Date(event.timestamp).toLocaleTimeString()}</time></div>
      <p>{eventText(event)}</p>
      <small>seq {event.sequence}{event.worker_task_id ? ` · worker ${event.worker_task_id}` : ""}</small>
    </article>
  ))}</div>;
}

function TerminalViewport({ rows }: { rows: TerminalRow[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" });
  }, [rows, follow]);
  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
  };
  if (!rows.length) return <p className="empty">The agent has not emitted safe terminal output yet.</p>;
  return <div className="terminal-shell">
    <div className="terminal-toolbar"><span>Redacted live terminal</span>{!follow && <button onClick={() => setFollow(true)}>Jump to latest</button>}</div>
    <div className="terminal-viewport" ref={viewport} onScroll={onScroll} tabIndex={0} aria-label="Live agent terminal transcript">
      {rows.map((row) => <div className={`terminal-row terminal-${row.tone}`} key={row.id}><span className="terminal-seq">{row.sequence}</span><code>{row.text}</code></div>)}
    </div>
  </div>;
}

function Workbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [tab, setTab] = useState("Terminal");
  const [steerText, setSteerText] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const callTool = useMcpBridge();
  const meta = useLiveMetadata();
  const connection = useLiveSession(meta, setState);
  const canControl = !!meta?.targetType && ["RUNNING", "WORKING", "CONNECTING", "APPROVAL_REQUIRED"].includes(state.status);

  useEffect(() => {
    hostBridge()?.notifyIntrinsicHeight?.(Math.min(760, Math.max(360, document.body.scrollHeight)));
  }, [state, tab, actionStatus]);

  const stop = async () => {
    if (!meta?.targetType || !meta.targetId) return;
    setActionStatus("requesting stop…");
    try {
      await callTool(meta.targetType === "task" ? "cptr_cancel_task" : "cptr_cancel_autonomous", meta.targetType === "task" ? { task_id: meta.targetId } : { monitor_id: meta.targetId });
      setActionStatus("stop requested; waiting for server confirmation");
    } catch {
      setActionStatus("stop request failed");
    }
  };

  const steer = async () => {
    const content = steerText.trim();
    if (!content || !meta?.targetType || !meta.targetId) return;
    setActionStatus("sending steering…");
    try {
      const idempotency_key = crypto.randomUUID();
      await callTool(meta.targetType === "task" ? "cptr_send_message" : "cptr_steer_autonomous", meta.targetType === "task" ? { task_id: meta.targetId, content, idempotency_key } : { monitor_id: meta.targetId, content, idempotency_key });
      setSteerText("");
      setActionStatus("steering queued");
    } catch {
      setActionStatus("steering request failed");
    }
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(state.transcript.map((row) => row.text).join("\n"));
      setActionStatus("redacted transcript copied");
    } catch {
      setActionStatus("copy unavailable");
    }
  };

  const expand = async () => {
    if (!hostBridge()?.requestDisplayMode) {
      setActionStatus("expanded display is unavailable in this host");
      return;
    }
    try {
      await hostBridge()!.requestDisplayMode!("fullscreen");
    } catch {
      setActionStatus("could not expand live terminal");
    }
  };

  const tabs: Record<string, React.ReactNode> = {
    Terminal: <TerminalViewport rows={state.transcript} />,
    Activity: <EventList events={state.activity} empty="No agent activity yet." />,
    Tools: <EventList events={state.tools} empty="No tool calls yet." />,
    Changes: <EventList events={state.changes} empty="No file-change events yet." />,
    Evidence: <EventList events={state.evidence} empty="No verification evidence yet." />,
  };
  const counts: Record<string, number> = { Terminal: state.transcript.length, Activity: state.activity.length, Tools: state.tools.length, Changes: state.changes.length, Evidence: state.evidence.length };

  return <main className="workbench terminal-workbench" aria-label="CPTR live agent terminal">
    <header className="header">
      <div><p className="eyebrow">CPTR LIVE TERMINAL</p><h1>{meta?.targetType === "monitor" ? "Autonomous monitor" : "Task activity"}</h1><p className="subtle">{meta?.targetId ?? "Waiting for a task or monitor"}</p></div>
      <div className={`status status-${state.status.toLowerCase()}`}><span className="status-dot" />{state.status}<small>{connection}</small></div>
    </header>
    <section className="controls" aria-label="Task controls">
      <button className="danger" disabled={!canControl} onClick={() => void stop()}>Stop</button>
      <div className="steer"><input value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder="Send a scoped follow-up…" aria-label="Steering message" disabled={!canControl} /><button onClick={() => void steer()} disabled={!canControl || !steerText.trim()}>Steer</button></div>
      <button onClick={() => void copyTranscript()} disabled={!state.transcript.length}>Copy</button>
      <button onClick={() => void expand()}>Expand</button>
      {actionStatus && <span className="action-status" role="status">{actionStatus}</span>}
    </section>
    <nav className="tabs" aria-label="Live terminal views">{Object.keys(tabs).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}<span>{counts[name]}</span></button>)}</nav>
    <section className="panel">{tabs[tab]}</section>
    <footer className="footer"><span>Live sequence {state.lastSequence}</span><span>Server-authoritative · redacted · bounded view</span></footer>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
