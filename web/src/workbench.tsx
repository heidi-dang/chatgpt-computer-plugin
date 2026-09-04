import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  appendDirectWorkerActivity,
  appendMcpToolActivity,
  eventTerminatesWorkbench,
  initialWorkbenchState,
  isTerminalWorkbenchStatus,
  LiveTargetSession,
  reduceWorkbenchEvent,
  reduceWorkbenchEvents,
  workbenchTargetIdentity,
  type DirectWorkerActivity,
  type McpToolActivity,
  type WorkbenchEvent,
  type WorkbenchState,
} from "./state.js";
import type { DisplayModeBridge } from "./display-mode.js";
import { TerminalView } from "./terminal-view.js";
import { BrowserSurface } from "./browser-surface.js";
import { CPTR_APP_VERSION } from "./version.js";
import "./workbench.css";

type LiveMetadata = {
  ticket?: string;
  streamUrl?: string;
  snapshotUrl?: string;
  renewUrl?: string;
  expiresAt?: number;
  targetType?: "task" | "monitor" | "command";
  targetId?: string;
  workspaceId?: string;
};

type BridgeMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type HostBridge = DisplayModeBridge & {
  toolResponseMetadata?: unknown;
  callTool?: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  notifyIntrinsicHeight?: (height: number) => void;
};

type PromptMetadata = {
  ticket?: string;
  streamUrl?: string;
  snapshotUrl?: string;
  renewUrl?: string;
  browserFrameUrl?: string;
  browserInputUrl?: string;
  expiresAt?: number;
  streamingEnabled?: boolean;
};

type BrowserSurfaceState = {
  action: string;
  deviceId?: string;
  sessionId?: string;
  mode: "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL" | "DISCONNECTED";
  owner?: string;
  epoch?: number;
  hostname?: string;
};

type PromptEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "mcp.tool" | "direct.worker" | "live.bind" | "browser.surface";
  payload?: {
    tool_name?: unknown;
    summary?: unknown;
    status?: unknown;
    arguments_json?: unknown;
    result_json?: unknown;
    error?: unknown;
    live?: LiveMetadata;
    worker_id?: unknown;
    workspace_id?: unknown;
    name?: unknown;
    responsibility?: unknown;
    repo_path?: unknown;
    changed_file_count?: unknown;
    changed_paths?: unknown;
    active_command_ids?: unknown;
    recent_command_ids?: unknown;
    action?: unknown;
    device_id?: unknown;
    session_id?: unknown;
    state?: unknown;
    owner?: unknown;
    epoch?: unknown;
    hostname?: unknown;
  };
};

function hostBridge(): HostBridge | undefined {
  return (window as Window & { openai?: HostBridge }).openai;
}

function useWorkbenchAutoSize() {
  const lastHeight = useRef(0);

  useEffect(() => {
    let frame: number | undefined;
    const workbench = document.querySelector<HTMLElement>(".terminal-workbench");
    const report = () => {
      frame = undefined;
      const height = Math.ceil(workbench?.getBoundingClientRect().height ?? 0);
      if (height <= 0 || Math.abs(height - lastHeight.current) < 2) return;
      lastHeight.current = height;
      hostBridge()?.notifyIntrinsicHeight?.(height);
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height },
      }, "*");
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(report);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    if (workbench) observer?.observe(workbench);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);
}

function findPromptMetadata(value: unknown): PromptMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record["cptr/prompt"];
  if (direct && typeof direct === "object" && "ticket" in direct) return direct as PromptMetadata;
  for (const key of ["_meta", "params", "result", "toolResult"]) {
    const found = findPromptMetadata(record[key]);
    if (found) return found;
  }
  return null;
}

function usePromptActivity(
  promptMetadata: PromptMetadata | null,
  setPromptMetadata: React.Dispatch<React.SetStateAction<PromptMetadata | null>>,
  setMeta: React.Dispatch<React.SetStateAction<LiveMetadata | null>>,
  setState: React.Dispatch<React.SetStateAction<WorkbenchState>>,
  setBrowserSurface: React.Dispatch<React.SetStateAction<BrowserSurfaceState | null>>,
  setSurfaceMode: React.Dispatch<React.SetStateAction<"terminal" | "browser">>,
  streamingEnabled: boolean,
) {
  const cursor = useRef(0);
  const [connection, setConnection] = useState("connecting prompt activity");

  useEffect(() => {
    if (!streamingEnabled) {
      setConnection("live streaming disabled");
      return;
    }
    const meta = promptMetadata;
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("prompt activity unavailable");
      return;
    }
    let controller = new AbortController();
    let stopped = false;
    let retryTimer: number | undefined;
    let retryAttempts = 0;

    const applyEvent = (event: PromptEvent, isLiveEvent = false) => {
      if (event.sequence <= cursor.current) return;
      cursor.current = event.sequence;
      if (event.type === "mcp.tool") {
        const toolName = typeof event.payload?.tool_name === "string" ? event.payload.tool_name : "";
        if (toolName === "cptr_open_live_workbench" || toolName === "cptr_render_live_terminal") return;
        setState((current) => appendMcpToolActivity(current, {
          event_id: event.event_id,
          timestamp: event.timestamp,
          type: "mcp.tool",
          payload: {
            tool_name: event.payload?.tool_name,
            summary: event.payload?.summary,
            status: event.payload?.status,
            arguments_json: event.payload?.arguments_json,
            result_json: event.payload?.result_json,
            error: event.payload?.error,
          },
        }));
      } else if (event.type === "direct.worker") {
        const payload = event.payload;
        if (typeof payload?.worker_id !== "string") return;
        // Direct workers use compact prompt activity. Do not bind the widget to
        // a raw command stream; terminal output is fetched on demand per lane.
        setMeta(null);
        setState((current) => appendDirectWorkerActivity(current, {
          event_id: event.event_id,
          timestamp: event.timestamp,
          type: "direct.worker",
          payload: {
            worker_id: payload.worker_id,
            workspace_id: payload.workspace_id,
            name: payload.name,
            responsibility: payload.responsibility,
            repo_path: payload.repo_path,
            status: payload.status,
            summary: payload.summary,
            changed_file_count: payload.changed_file_count,
            changed_paths: payload.changed_paths,
            active_command_ids: payload.active_command_ids,
            recent_command_ids: payload.recent_command_ids,
          },
        } as DirectWorkerActivity));
      } else if (event.type === "live.bind" && event.payload?.live) {
        setMeta(event.payload.live);
      } else if (event.type === "browser.surface") {
        const payload = event.payload ?? {};
        const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
        // Discovery/pairing activity is not a renderable browser surface. Keep
        // the terminal visible until CPTR has bound a real browser session.
        if (!sessionId) return;
        const stateValue = typeof payload.state === "string" ? payload.state : "OBSERVING";
        const owner = typeof payload.owner === "string" ? payload.owner : undefined;
        const mode = owner === "none"
          ? "DISCONNECTED"
          : (["OBSERVING", "AGENT_CONTROL", "HANDOFF_REQUIRED", "HUMAN_CONTROL", "DISCONNECTED"] as const)
              .includes(stateValue as BrowserSurfaceState["mode"])
            ? stateValue as BrowserSurfaceState["mode"]
            : "OBSERVING";
        setBrowserSurface({
          action: typeof payload.action === "string" ? payload.action : "unknown",
          ...(typeof payload.device_id === "string" ? { deviceId: payload.device_id } : {}),
          sessionId,
          mode,
          ...(owner ? { owner } : {}),
          ...(typeof payload.epoch === "number" ? { epoch: payload.epoch } : {}),
          ...(typeof payload.hostname === "string" ? { hostname: payload.hostname } : {}),
        });
        if (isLiveEvent && owner !== "none") setSurfaceMode("browser");
      }
    };

    const applySnapshot = async () => {
      const url = new URL(meta.snapshotUrl!, window.location.href);
      url.searchParams.set("after", String(cursor.current));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`prompt snapshot unavailable (${response.status})`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      const value = await response.json() as { replay?: { events?: PromptEvent[]; last_sequence?: number } };
      for (const event of value.replay?.events ?? []) applyEvent(event, false);
      if (typeof value.replay?.last_sequence === "number") cursor.current = Math.max(cursor.current, value.replay.last_sequence);
    };

    const renewPromptTicket = async (): Promise<boolean> => {
      if (!meta.renewUrl) return false;
      setConnection("renewing prompt activity");
      try {
        const response = await fetch(new URL(meta.renewUrl, window.location.href), {
          method: "POST",
          headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return false;
        const renewed = await response.json() as PromptMetadata;
        if (!renewed.ticket || !renewed.streamUrl || !renewed.snapshotUrl || !renewed.renewUrl) return false;
        setPromptMetadata(renewed);
        return true;
      } catch {
        return false;
      }
    };

    const scheduleRetry = (run: () => void) => {
      if (stopped) return;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempts, 4));
      retryAttempts += 1;
      retryTimer = window.setTimeout(run, delay);
      setConnection(navigator.onLine === false ? "offline" : "reconnecting prompt activity");
    };

    const consume = async () => {
      try {
        await applySnapshot();
        if (stopped) return;
        const url = new URL(meta.streamUrl!, window.location.href);
        url.searchParams.set("after", String(cursor.current));
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "text/event-stream", "Last-Event-ID": String(cursor.current) },
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!(await renewPromptTicket())) scheduleRetry(consume);
          return;
        }
        if (!response.ok || !response.body) {
          const error = new Error(`prompt stream unavailable (${response.status})`) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        retryAttempts = 0;
        setConnection("prompt live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data: string[] = [];
        const dispatch = () => {
          if (!data.length) return;
          try { applyEvent(JSON.parse(data.join("\n")) as PromptEvent, true); }
          catch { setConnection("received invalid prompt event"); }
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
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
        }
        if (!stopped && data.length) dispatch();
        if (!stopped) scheduleRetry(consume);
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        const status = error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
        if (status === 401) {
          if (!(await renewPromptTicket())) scheduleRetry(consume);
          return;
        }
        setConnection(error instanceof Error ? error.message : "prompt stream error");
        scheduleRetry(consume);
      }
    };

    const wake = () => {
      if (stopped) return;
      retryAttempts = 0;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller.abort();
      controller = new AbortController();
      retryTimer = window.setTimeout(() => void consume(), 0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void consume();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [promptMetadata?.ticket, promptMetadata?.streamUrl, promptMetadata?.snapshotUrl, promptMetadata?.renewUrl, setPromptMetadata, setMeta, setState, streamingEnabled]);

  return connection;
}

function useMcpBridge() {
  const pending = useRef(new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>());
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.id === undefined) return;
      const request = pending.current.get(message.id);
      if (!request) return;
      pending.current.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? `MCP bridge error ${message.error.code ?? "unknown"}`));
      } else {
        request.resolve(message.result);
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: `init-${crypto.randomUUID()}`,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        capabilities: {},
        clientInfo: { name: "cptr-live-terminal", version: CPTR_APP_VERSION },
      },
    }, "*");
    return () => {
      window.removeEventListener("message", onMessage);
      for (const request of pending.current.values()) request.reject(new Error("MCP bridge closed"));
      pending.current.clear();
    };
  }, []);

  return useCallback((name: string, args: Record<string, unknown>) => {
    if (hostBridge()?.callTool) return hostBridge()!.callTool!(name, args);
    const id = `call-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "*");
    });
  }, []);
}

function useLiveSession(
  meta: LiveMetadata | null,
  setMeta: React.Dispatch<React.SetStateAction<LiveMetadata | null>>,
  setState: React.Dispatch<React.SetStateAction<WorkbenchState>>,
  streamingEnabled: boolean,
) {
  const [connection, setConnection] = useState("waiting for live terminal");
  const liveTarget = useRef(new LiveTargetSession());

  useEffect(() => {
    if (!streamingEnabled) {
      setConnection("live streaming disabled");
      return;
    }
    if (liveTarget.current.bind(meta?.targetType, meta?.targetId, meta?.workspaceId)) {
      setState((current) => ({ ...current, status: "CONNECTING", lastSequence: 0 }));
    }
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("activity feed ready");
      return;
    }

    let controller = new AbortController();
    let retryTimer: number | undefined;
    let renewalTimer: number | undefined;
    let stopped = false;
    let terminalSeen = false;
    let retryAttempts = 0;

    const renewTicket = async (): Promise<boolean> => {
      if (!meta.targetType || !meta.targetId || !meta.renewUrl) return false;
      liveTarget.current.renewalAttempts += 1;
      setConnection("renewing session");
      try {
        const response = await fetch(new URL(meta.renewUrl, window.location.href), {
          method: "POST",
          headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return false;
        const renewed = await response.json() as LiveMetadata;
        const sameTarget =
          renewed.targetType === meta.targetType &&
          renewed.targetId === meta.targetId &&
          (meta.targetType !== "command" || renewed.workspaceId === meta.workspaceId);
        if (!sameTarget || !renewed.ticket || !renewed.streamUrl || !renewed.snapshotUrl || !renewed.renewUrl) return false;
        liveTarget.current.renewalAttempts = 0;
        setMeta(renewed);
        return true;
      } catch {
        return false;
      }
    };

    if (typeof meta.expiresAt === "number" && meta.renewUrl) {
      const renewInMs = Math.max(1_000, meta.expiresAt - Date.now() - 60_000);
      renewalTimer = window.setTimeout(() => {
        void renewTicket().then((renewed) => {
          if (!renewed && !stopped) scheduleRetry(consume);
        });
      }, renewInMs);
    }

    const unavailable = (status: number) => {
      const error = new Error(`live session unavailable (${status})`) as Error & { status?: number };
      error.status = status;
      return error;
    };

    const applySnapshot = async () => {
      const snapshotUrl = new URL(meta.snapshotUrl!, window.location.href);
      snapshotUrl.searchParams.set("after", String(liveTarget.current.cursor));
      const response = await fetch(snapshotUrl, {
        headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw unavailable(response.status);
      const value = await response.json() as {
        snapshot?: { status?: string };
        replay?: { events?: WorkbenchEvent[]; last_sequence?: number };
      };
      const status = value.snapshot?.status;
      if (typeof status === "string") {
        setState((current) => ({ ...current, status: status.toUpperCase() }));
        terminalSeen = isTerminalWorkbenchStatus(status);
      }
      const replayEvents = (value.replay?.events ?? []).filter((event) => event.sequence > liveTarget.current.cursor);
      for (const event of replayEvents) {
        liveTarget.current.cursor = event.sequence;
        if (eventTerminatesWorkbench(event)) terminalSeen = true;
      }
      if (replayEvents.length) setState((current) => reduceWorkbenchEvents(current, replayEvents));
      const lastSequence = value.replay?.last_sequence;
      if (typeof lastSequence === "number") {
        liveTarget.current.cursor = Math.max(liveTarget.current.cursor, lastSequence);
      }
    };

    const scheduleRetry = (run: () => void) => {
      if (stopped) return;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempts, 4));
      retryAttempts += 1;
      retryTimer = window.setTimeout(run, delay);
      setConnection(navigator.onLine === false ? "offline" : "reconnecting");
    };

    const consume = async () => {
      try {
        setConnection("recovering session");
        await applySnapshot();
        if (terminalSeen || stopped) return;
        const streamUrl = new URL(meta.streamUrl!, window.location.href);
        streamUrl.searchParams.set("after", String(liveTarget.current.cursor));
        setConnection("connecting");
        const response = await fetch(streamUrl, {
          headers: {
            Authorization: `Bearer ${meta.ticket}`,
            Accept: "text/event-stream",
            "Last-Event-ID": String(liveTarget.current.cursor),
          },
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!(await renewTicket())) scheduleRetry(consume);
          return;
        }
        if ([403, 404, 410].includes(response.status)) {
          setConnection(`stream unavailable (${response.status})`);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`stream unavailable (${response.status})`);

        retryAttempts = 0;
        liveTarget.current.renewalAttempts = 0;
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
                terminalSeen = isTerminalWorkbenchStatus(status);
              }
            } else {
              const event = value as WorkbenchEvent;
              if (event.sequence > liveTarget.current.cursor) {
                liveTarget.current.cursor = event.sequence;
                setState((current) => reduceWorkbenchEvent(current, event));
              }
              if (eventTerminatesWorkbench(event)) terminalSeen = true;
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
        if (!stopped && data.length) dispatch();
        if (!stopped && !terminalSeen) scheduleRetry(consume);
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        const status = error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
        if (status === 401) {
          if (!(await renewTicket())) scheduleRetry(consume);
          return;
        }
        setConnection(error instanceof Error ? error.message : "stream error");
        scheduleRetry(consume);
      }
    };

    const wake = () => {
      if (stopped || terminalSeen) return;
      retryAttempts = 0;
      liveTarget.current.renewalAttempts = 0;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller.abort();
      controller = new AbortController();
      retryTimer = window.setTimeout(() => void consume(), 0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void consume();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [meta?.ticket, meta?.streamUrl, meta?.snapshotUrl, meta?.renewUrl, meta?.expiresAt, meta?.targetType, meta?.targetId, meta?.workspaceId, setMeta, setState, streamingEnabled]);

  return connection;
}

function targetLabel(meta: LiveMetadata | null): string {
  if (!meta?.targetType || !meta.targetId) return "Waiting for terminal session…";
  const id = meta.targetId.length > 34
    ? `${meta.targetId.slice(0, 16)}…${meta.targetId.slice(-10)}`
    : meta.targetId;
  return `${meta.targetType} · ${id}`;
}

function OwnedWorkbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [actionStatus, setActionStatus] = useState("");
  useMcpBridge();
  const [promptMetadata, setPromptMetadata] = useState<PromptMetadata | null>(() => findPromptMetadata(hostBridge()?.toolResponseMetadata));
  const liveStreamingEnabled = promptMetadata?.streamingEnabled === true;
  const [meta, setMeta] = useState<LiveMetadata | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<"terminal" | "browser">("terminal");
  const [browserSurface, setBrowserSurface] = useState<BrowserSurfaceState | null>(null);
  const [terminalViewState, setTerminalViewState] = useState({ follow: true, scrollTop: 0 });
  const promptConnection = usePromptActivity(promptMetadata, setPromptMetadata, setMeta, setState, setBrowserSurface, setSurfaceMode, liveStreamingEnabled);
  const targetConnection = useLiveSession(meta, setMeta, setState, liveStreamingEnabled);
  const connection = meta?.targetId && !isTerminalWorkbenchStatus(state.status) ? targetConnection : promptConnection;
  const visibleTarget = useRef<string | null>(null);
  const displayStatus = meta?.targetType && meta.targetId ? state.status : "CONNECTING";

  useEffect(() => {
    const identity = workbenchTargetIdentity(meta?.targetType, meta?.targetId, meta?.workspaceId);
    if (visibleTarget.current === identity) return;
    visibleTarget.current = identity;
    setActionStatus("");
  }, [meta?.targetType, meta?.targetId, meta?.workspaceId]);

  useWorkbenchAutoSize();

  return <main className="terminal-workbench" aria-label="CPTR live computer">
    <div className="surface-switch" role="group" aria-label="Live computer surface">
      <button type="button" aria-pressed={surfaceMode === "terminal"} onClick={() => setSurfaceMode("terminal")}>Terminal</button>
      <button type="button" aria-pressed={surfaceMode === "browser"} onClick={() => setSurfaceMode("browser")}>Browser</button>
    </div>
    {surfaceMode === "browser"
      ? <BrowserSurface
          frameUrl={promptMetadata?.browserFrameUrl}
          inputUrl={promptMetadata?.browserInputUrl}
          ticket={promptMetadata?.ticket}
          sessionId={browserSurface?.sessionId}
          epoch={browserSurface?.epoch}
          active={surfaceMode === "browser"}
          released={browserSurface?.owner === "none" || browserSurface?.mode === "DISCONNECTED"}
          connection={connection}
          mode={browserSurface?.mode ?? "DISCONNECTED"}
          hostname={browserSurface?.hostname ?? "CPTR User Chrome"}
          actionLabel={actionStatus || browserSurface?.action || "Waiting for browser session"}
        />
      : <TerminalView
          rows={state.transcript}
          status={displayStatus}
          connection={connection}
          machineLabel={meta?.targetId || promptConnection === "prompt live" ? "CPTR Computer" : "Connecting to computer"}
          targetLabel={targetLabel(meta)}
          follow={terminalViewState.follow}
          scrollTop={terminalViewState.scrollTop}
          onFollowChange={(follow) => setTerminalViewState((current) => ({ ...current, follow }))}
          onScrollTopChange={(scrollTop) => setTerminalViewState((current) => ({ ...current, scrollTop }))}
        />}
  </main>;
}

function Workbench() {
  return <OwnedWorkbench />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
