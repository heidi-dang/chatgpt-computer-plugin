import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initialWorkbenchState, reduceWorkbenchEvent, type WorkbenchEvent, type WorkbenchState } from "./state.js";
import "./workbench.css";

type LiveMetadata = {
  ticket?: string;
  streamUrl?: string;
  expiresAt?: number;
  targetType?: "task" | "monitor";
  targetId?: string;
};

type BridgeMessage = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown };

const terminalStatuses = new Set(["COMPLETE", "CANCELLED", "FAILED", "BLOCKED"]);

function metadataFromEnvironment(): LiveMetadata | null {
  const openai = (window as Window & { openai?: { toolResponseMetadata?: unknown } }).openai;
  const value = openai?.toolResponseMetadata;
  if (!value || typeof value !== "object") return null;
  const live = (value as Record<string, unknown>)["cptr/live"];
  return live && typeof live === "object" ? live as LiveMetadata : null;
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
  const [metadata, setMetadata] = useState<LiveMetadata | null>(() => metadataFromEnvironment());
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
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
      params: { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "cptr-live-workbench", version: "0.1.0" } },
    }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (name: string, args: Record<string, unknown>) => {
    const openai = (window as Window & { openai?: { callTool?: (tool: string, input: Record<string, unknown>) => Promise<unknown> } }).openai;
    if (openai?.callTool) return openai.callTool(name, args);
    const id = `call-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      pending.current.set(id, resolve);
      window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "*");
    });
  };
}

function useLiveStream(meta: LiveMetadata | null, setState: React.Dispatch<React.SetStateAction<WorkbenchState>>) {
  const [connection, setConnection] = useState("waiting for CPTR stream");
  const cursor = useRef(0);
  useEffect(() => {
    if (!meta?.ticket || !meta.streamUrl) {
      setConnection("live metadata unavailable");
      return;
    }
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let stopped = false;
    let terminalSeen = false;
    let retryAttempts = 0;
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
        const url = new URL(meta.streamUrl!, window.location.href);
        url.searchParams.set("after", String(cursor.current));
        setConnection("connecting");
        const response = await fetch(url, {
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
        let eventId = "";
        let data: string[] = [];
        const dispatch = () => {
          if (!data.length) return;
          try {
            const event = JSON.parse(data.join("\n")) as WorkbenchEvent;
            if (event.sequence > cursor.current) {
              cursor.current = event.sequence;
              setState((state) => reduceWorkbenchEvent(state, event));
            }
            const eventStatus = typeof event.payload?.status === "string" ? event.payload.status.toUpperCase() : "";
            if (event.type.endsWith(".terminal") || terminalStatuses.has(eventStatus)) terminalSeen = true;
          } catch {
            setConnection("received invalid event");
          }
          eventId = "";
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
            else if (line.startsWith("id:")) eventId = line.slice(3).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (eventId && Number(eventId) > cursor.current) cursor.current = Number(eventId);
        }
        if (!stopped && !terminalSeen) {
          scheduleRetry(consume);
        }
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
  }, [meta?.ticket, meta?.streamUrl, meta?.targetType, meta?.targetId, setState]);
  return connection;
}

function prettyEvent(event: WorkbenchEvent): string {
  const payload = event.payload ?? {};
  const text = payload.text ?? payload.message ?? payload.status ?? payload.path ?? "event";
  return String(text).slice(0, 500);
}

function EventList({ events, empty }: { events: WorkbenchEvent[]; empty: string }) {
  if (!events.length) return <p className="empty">{empty}</p>;
  return <div className="event-list">{events.slice().reverse().map((event) => (
    <article className="event" key={event.event_id}>
      <div className="event-top"><span className="event-type">{event.type}</span><time>{new Date(event.timestamp).toLocaleTimeString()}</time></div>
      <p>{prettyEvent(event)}</p>
      <small>seq {event.sequence}{event.worker_task_id ? ` · worker ${event.worker_task_id}` : ""}</small>
    </article>
  ))}</div>;
}

function Workbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [tab, setTab] = useState("Activity");
  const [steerText, setSteerText] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const callTool = useMcpBridge();
  const meta = useLiveMetadata();
  const connection = useLiveStream(meta, setState);
  const canStop = !!meta?.targetType && ["RUNNING", "WORKING", "CONNECTING"].includes(state.status);

  useEffect(() => {
    const openai = (window as Window & { openai?: { notifyIntrinsicHeight?: (height: number) => void; requestDisplayMode?: (mode: string) => Promise<unknown> } }).openai;
    openai?.notifyIntrinsicHeight?.(Math.min(720, Math.max(360, document.body.scrollHeight)));
  }, [state, tab, actionStatus]);

  const stop = async () => {
    if (!meta?.targetType || !meta.targetId) return;
    setActionStatus("stopping…");
    try {
      await callTool(meta.targetType === "task" ? "cptr_cancel_task" : "cptr_cancel_autonomous", meta.targetType === "task" ? { task_id: meta.targetId } : { monitor_id: meta.targetId });
      setActionStatus("stop requested");
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

  const tabEvents: Record<string, WorkbenchEvent[]> = { Activity: state.activity, Terminal: state.terminal, Tools: state.tools, Changes: state.changes, Evidence: state.evidence };
  return <main className="workbench" aria-label="CPTR Live Workbench">
    <header className="header">
      <div><p className="eyebrow">CPTR LIVE WORKBENCH</p><h1>{meta?.targetType === "monitor" ? "Autonomous monitor" : "Task activity"}</h1><p className="subtle">{meta?.targetId ?? "Waiting for a task or monitor"}</p></div>
      <div className={`status status-${state.status.toLowerCase()}`}><span className="status-dot" />{state.status}<small>{connection}</small></div>
    </header>
    <section className="controls" aria-label="Task controls">
      <button className="danger" disabled={!canStop} onClick={() => void stop()}>Stop</button>
      <div className="steer"><input value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder="Send a scoped follow-up…" aria-label="Steering message" disabled={!canStop} /><button onClick={() => void steer()} disabled={!canStop || !steerText.trim()}>Steer</button></div>
      {actionStatus && <span className="action-status" role="status">{actionStatus}</span>}
    </section>
    <nav className="tabs" aria-label="Workbench views">{Object.keys(tabEvents).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}<span>{tabEvents[name].length}</span></button>)}</nav>
    <section className="panel"><EventList events={tabEvents[tab]} empty={`No ${tab.toLowerCase()} activity yet.`} /></section>
    <footer className="footer"><span>Live sequence {state.lastSequence}</span><span>Server-authoritative activity · bounded view</span></footer>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
