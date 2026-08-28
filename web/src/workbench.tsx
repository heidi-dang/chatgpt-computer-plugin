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
import { requestHostDisplayMode, type DisplayModeBridge } from "./display-mode.js";
import { DirectWorkersView, type DirectWorkerTab } from "./direct-workers-view.js";
import { TerminalView } from "./terminal-view.js";
import { PluginUpdateCenter } from "./plugin-update.js";
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
  expiresAt?: number;
  streamingEnabled?: boolean;
};

type PromptEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "mcp.tool" | "direct.worker" | "live.bind";
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
  };
};

function hostBridge(): HostBridge | undefined {
  return (window as Window & { openai?: HostBridge }).openai;
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
  setMeta: React.Dispatch<React.SetStateAction<LiveMetadata | null>>,
  setState: React.Dispatch<React.SetStateAction<WorkbenchState>>,
  streamingEnabled: boolean,
) {
  const prompt = useRef<PromptMetadata | null>(findPromptMetadata(hostBridge()?.toolResponseMetadata));
  const cursor = useRef(0);
  const [connection, setConnection] = useState("connecting prompt activity");

  useEffect(() => {
    if (!streamingEnabled) {
      setConnection("live streaming disabled");
      return;
    }
    const meta = prompt.current;
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("prompt activity unavailable");
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    let retryTimer: number | undefined;
    let retryAttempts = 0;

    const applyEvent = (event: PromptEvent) => {
      if (event.sequence <= cursor.current) return;
      cursor.current = event.sequence;
      if (event.type === "mcp.tool") {
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
      }
    };

    const applySnapshot = async () => {
      const url = new URL(meta.snapshotUrl!, window.location.href);
      url.searchParams.set("after", String(cursor.current));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${meta.ticket}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`prompt snapshot unavailable (${response.status})`);
      const value = await response.json() as { replay?: { events?: PromptEvent[]; last_sequence?: number } };
      for (const event of value.replay?.events ?? []) applyEvent(event);
      if (typeof value.replay?.last_sequence === "number") cursor.current = Math.max(cursor.current, value.replay.last_sequence);
    };

    const scheduleRetry = (run: () => void) => {
      if (retryAttempts >= 8 || stopped) {
        setConnection("prompt reconnect limit reached");
        return;
      }
      retryTimer = window.setTimeout(run, Math.min(15000, 1000 * 2 ** retryAttempts));
      retryAttempts += 1;
      setConnection("reconnecting prompt activity");
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
        if (!response.ok || !response.body) throw new Error(`prompt stream unavailable (${response.status})`);
        retryAttempts = 0;
        setConnection("prompt live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data: string[] = [];
        const dispatch = () => {
          if (!data.length) return;
          try { applyEvent(JSON.parse(data.join("\n")) as PromptEvent); }
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
        setConnection(error instanceof Error ? error.message : "prompt stream error");
        scheduleRetry(consume);
      }
    };
    void consume();
    return () => { stopped = true; controller.abort(); if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [setMeta, setState, streamingEnabled]);

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

    const controller = new AbortController();
    let retryTimer: number | undefined;
    let renewalTimer: number | undefined;
    let stopped = false;
    let terminalSeen = false;
    let retryAttempts = 0;

    const renewTicket = async (): Promise<boolean> => {
      if (!meta.targetType || !meta.targetId || !meta.renewUrl || liveTarget.current.renewalAttempts >= 2) return false;
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
          if (!renewed && !stopped) setConnection("ticket renewal failed");
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
          if (!(await renewTicket())) setConnection("ticket renewal failed");
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
          if (!(await renewTicket())) setConnection("ticket renewal failed");
          return;
        }
        setConnection(error instanceof Error ? error.message : "stream error");
        scheduleRetry(consume);
      }
    };

    void consume();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
    };
  }, [meta?.ticket, meta?.streamUrl, meta?.snapshotUrl, meta?.renewUrl, meta?.expiresAt, meta?.targetType, meta?.targetId, meta?.workspaceId, setMeta, setState, streamingEnabled]);

  return connection;
}

function targetLabel(meta: LiveMetadata | null): string {
  if (!meta?.targetType || !meta.targetId) return "Ready for real CPTR activity";
  const id = meta.targetId.length > 34
    ? `${meta.targetId.slice(0, 16)}…${meta.targetId.slice(-10)}`
    : meta.targetId;
  return `${meta.targetType} · ${id}`;
}

function structuredToolResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  const result = record.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return structuredToolResult(result);
  }
  return record;
}

function formatGitStatus(value: Record<string, unknown>): string {
  const files = Array.isArray(value.files) ? value.files : [];
  if (!files.length) return "No changed files.";
  return files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const record = item as Record<string, unknown>;
    return `${String(record.status ?? "changed").padEnd(10)} ${String(record.path ?? "")}`.trimEnd();
  }).filter(Boolean).join("\n");
}

function OwnedWorkbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [actionStatus, setActionStatus] = useState("");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [selectedWorkerTab, setSelectedWorkerTab] = useState<DirectWorkerTab>("activity");
  const [workerChanges, setWorkerChanges] = useState("");
  const [workerTerminal, setWorkerTerminal] = useState("");
  const callTool = useMcpBridge();
  const promptMetadata = findPromptMetadata(hostBridge()?.toolResponseMetadata);
  const liveStreamingEnabled = promptMetadata?.streamingEnabled === true;
  const updateManifestUrl = promptMetadata?.streamUrl
    ? new URL("/plugin/update", promptMetadata.streamUrl).toString()
    : undefined;
  const [meta, setMeta] = useState<LiveMetadata | null>(null);
  const promptConnection = usePromptActivity(setMeta, setState, liveStreamingEnabled);
  const targetConnection = useLiveSession(meta, setMeta, setState, liveStreamingEnabled);
  const hasWorkers = state.workerOrder.length > 0;
  const connection = hasWorkers ? promptConnection : meta?.targetId ? targetConnection : promptConnection;
  const selectedWorker = selectedWorkerId ? state.workers[selectedWorkerId] : undefined;
  const visibleTarget = useRef<string | null>(null);
  const autoPinAttempted = useRef(false);
  const isCommand = meta?.targetType === "command" && !!meta.targetId && !!meta.workspaceId;
  const canControl = !!meta?.targetType && ["RUNNING", "WORKING", "CONNECTING", "APPROVAL_REQUIRED"].includes(state.status);
  const displayStatus = meta?.targetType && meta.targetId
    ? state.status
    : state.transcript.length ? "ACTIVE" : "READY";

  useEffect(() => {
    if (!state.workerOrder.length) return;
    if (selectedWorkerId && state.workers[selectedWorkerId]) return;
    setSelectedWorkerId(state.workerOrder[0] ?? null);
  }, [selectedWorkerId, state.workerOrder, state.workers]);

  useEffect(() => {
    setWorkerChanges("");
    setWorkerTerminal("");
    setSelectedWorkerTab("activity");
  }, [selectedWorkerId]);

  useEffect(() => {
    const identity = workbenchTargetIdentity(meta?.targetType, meta?.targetId, meta?.workspaceId);
    if (visibleTarget.current === identity) return;
    visibleTarget.current = identity;
    setActionStatus("");
  }, [meta?.targetType, meta?.targetId, meta?.workspaceId]);

  useEffect(() => {
    if (!liveStreamingEnabled || autoPinAttempted.current) return;
    autoPinAttempted.current = true;
    void requestHostDisplayMode(hostBridge(), "pip")
      .then((granted) => {
        if (granted === "pip") setActionStatus("terminal pinned");
      })
      .catch(() => undefined);
  }, [liveStreamingEnabled]);

  useEffect(() => {
    hostBridge()?.notifyIntrinsicHeight?.(Math.min(760, Math.max(280, document.body.scrollHeight)));
  }, [state.status, state.transcript.length, state.workerOrder.length, selectedWorkerTab, connection, actionStatus]);

  const stop = async () => {
    if (!meta?.targetType || !meta.targetId) return;
    setActionStatus("requesting stop…");
    try {
      if (isCommand) {
        await callTool("cptr_code_cancel_command", {
          workspace_id: meta.workspaceId!,
          command_id: meta.targetId,
        });
      } else if (meta.targetType === "task") {
        await callTool("cptr_cancel_task", { task_id: meta.targetId });
      } else {
        await callTool("cptr_cancel_autonomous", { monitor_id: meta.targetId });
      }
      setActionStatus("stop requested");
    } catch {
      setActionStatus("stop request failed");
    }
  };

  const refreshWorkerChanges = async () => {
    if (!selectedWorker?.workspaceId) return;
    setActionStatus("refreshing worker changes…");
    try {
      const value = await callTool("cptr_code_get_git_status", {
        workspace_id: selectedWorker.workspaceId,
        worker_id: selectedWorker.workerId,
      });
      setWorkerChanges(formatGitStatus(structuredToolResult(value)));
      setActionStatus("worker changes refreshed");
    } catch {
      setActionStatus("could not refresh worker changes");
    }
  };

  const refreshWorkerTerminal = async () => {
    if (!selectedWorker?.workspaceId) return;
    const commandId = selectedWorker.activeCommandIds[0]
      ?? selectedWorker.recentCommandIds[selectedWorker.recentCommandIds.length - 1];
    if (!commandId) {
      setWorkerTerminal("No command has run in this worker yet.");
      return;
    }
    setActionStatus("loading recent command tail…");
    try {
      const value = await callTool("cptr_code_get_command", {
        workspace_id: selectedWorker.workspaceId,
        worker_id: selectedWorker.workerId,
        command_id: commandId,
        offset: 0,
        wait_seconds: 0,
        tail_bytes: 32_768,
      });
      const result = structuredToolResult(value);
      setWorkerTerminal(typeof result.output === "string" ? result.output : "No command output available.");
      setActionStatus("recent command tail loaded");
    } catch {
      setActionStatus("could not load command tail");
    }
  };

  const stopWorkerCommand = async () => {
    if (!selectedWorker?.workspaceId || !selectedWorker.activeCommandIds.length) return;
    setActionStatus("requesting worker command stop…");
    try {
      await callTool("cptr_code_cancel_command", {
        workspace_id: selectedWorker.workspaceId,
        worker_id: selectedWorker.workerId,
        command_id: selectedWorker.activeCommandIds[0],
      });
      setActionStatus("worker command stop requested");
    } catch {
      setActionStatus("worker command stop failed");
    }
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(state.transcript.map((row) => row.text).join("\n"));
      setActionStatus("transcript copied");
    } catch {
      setActionStatus("copy unavailable");
    }
  };

  const pin = async () => {
    try {
      const granted = await requestHostDisplayMode(hostBridge(), "pip");
      if (!granted) setActionStatus("pinning is unavailable in this host");
      else if (granted === "pip") setActionStatus("terminal pinned");
      else setActionStatus(`host granted ${granted} mode`);
    } catch {
      setActionStatus("could not pin live terminal");
    }
  };

  const expand = async () => {
    try {
      const granted = await requestHostDisplayMode(hostBridge(), "fullscreen");
      if (!granted) setActionStatus("expanded display is unavailable in this host");
      else if (granted !== "fullscreen") setActionStatus(`host granted ${granted} mode`);
      else setActionStatus("");
    } catch {
      setActionStatus("could not expand live terminal");
    }
  };

  const updateCenter = <PluginUpdateCenter callTool={callTool} manifestUrl={updateManifestUrl} onStatus={setActionStatus} />;

  return <main className="terminal-workbench" aria-label="CPTR live workbench">
    {hasWorkers ? <DirectWorkersView
      workers={state.workers}
      workerOrder={state.workerOrder}
      selectedWorkerId={selectedWorkerId}
      selectedTab={selectedWorkerTab}
      connection={connection}
      actionStatus={actionStatus}
      changesText={workerChanges}
      terminalText={workerTerminal}
      onSelectWorker={setSelectedWorkerId}
      onSelectTab={setSelectedWorkerTab}
      onRefreshChanges={() => void refreshWorkerChanges()}
      onRefreshTerminal={() => void refreshWorkerTerminal()}
      onStopCommand={() => void stopWorkerCommand()}
      canStopCommand={Boolean(selectedWorker?.activeCommandIds.length)}
      onPin={() => void pin()}
      onExpand={() => void expand()}
      updateCenter={updateCenter}
    /> : <TerminalView
      rows={state.transcript}
      updateCenter={updateCenter}
      status={displayStatus}
      connection={connection}
      targetLabel={targetLabel(meta)}
      actionStatus={actionStatus}
      canStop={canControl}
      onStop={() => void stop()}
      onCopy={() => void copyTranscript()}
      onPin={() => void pin()}
      onExpand={() => void expand()}
    />}
  </main>;
}

function Workbench() {
  return <OwnedWorkbench />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
