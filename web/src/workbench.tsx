import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  eventTerminatesWorkbench,
  initialWorkbenchState,
  isTerminalWorkbenchStatus,
  LiveTargetSession,
  reduceWorkbenchEvent,
  reduceWorkbenchEvents,
  workbenchTargetIdentity,
  type WorkbenchEvent,
  type WorkbenchState,
} from "./state.js";
import { requestHostDisplayMode, type DisplayModeBridge } from "./display-mode.js";
import { TerminalView } from "./terminal-view.js";
import "./workbench.css";

type LiveMetadata = {
  ticket?: string;
  streamUrl?: string;
  snapshotUrl?: string;
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
};

type HostBridge = DisplayModeBridge & {
  toolResponseMetadata?: unknown;
  callTool?: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  notifyIntrinsicHeight?: (height: number) => void;
};

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

function useLiveMetadata(): [LiveMetadata | null, React.Dispatch<React.SetStateAction<LiveMetadata | null>>] {
  const [metadata, setMetadata] = useState<LiveMetadata | null>(() => findLiveMetadata(hostBridge()?.toolResponseMetadata));
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent || event.data?.method !== "ui/notifications/tool-result") return;
      const found = findLiveMetadata(event.data.params);
      if (found) setMetadata(found);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return [metadata, setMetadata];
}

function useMcpBridge() {
  const pending = useRef(new Map<string | number, (value: unknown) => void>());
  useEffect(() => {
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.id === undefined) return;
      const resolve = pending.current.get(message.id);
      if (!resolve) return;
      pending.current.delete(message.id);
      resolve(message.result);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: `init-${crypto.randomUUID()}`,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        capabilities: {},
        clientInfo: { name: "cptr-live-terminal", version: "0.4.0" },
      },
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

function useLiveSession(
  meta: LiveMetadata | null,
  setMeta: React.Dispatch<React.SetStateAction<LiveMetadata | null>>,
  setState: React.Dispatch<React.SetStateAction<WorkbenchState>>,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const [connection, setConnection] = useState("waiting for live terminal");
  const liveTarget = useRef(new LiveTargetSession());
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  useEffect(() => {
    if (liveTarget.current.bind(meta?.targetType, meta?.targetId, meta?.workspaceId)) {
      setState(initialWorkbenchState());
    }
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("waiting for a CPTR task or monitor");
      return;
    }

    const controller = new AbortController();
    let retryTimer: number | undefined;
    let stopped = false;
    let terminalSeen = false;
    let retryAttempts = 0;

    const renewTicket = async (): Promise<boolean> => {
      if (!meta.targetType || !meta.targetId || liveTarget.current.renewalAttempts >= 2) return false;
      liveTarget.current.renewalAttempts += 1;
      setConnection("renewing session");
      try {
        const response = await callToolRef.current("cptr_render_live_terminal", {
          target_type: meta.targetType,
          target_id: meta.targetId,
          ...(meta.targetType === "command" && meta.workspaceId ? { workspace_id: meta.workspaceId } : {}),
        });
        const renewed = findLiveMetadata(response);
        if (!renewed?.ticket || !renewed.streamUrl || !renewed.snapshotUrl) return false;
        setMeta(renewed);
        return true;
      } catch {
        return false;
      }
    };

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
    };
  }, [meta?.ticket, meta?.streamUrl, meta?.snapshotUrl, meta?.targetType, meta?.targetId, meta?.workspaceId, setMeta, setState]);

  return connection;
}

function targetLabel(meta: LiveMetadata | null): string {
  if (!meta?.targetType || !meta.targetId) return "Ready for real CPTR activity";
  const id = meta.targetId.length > 34
    ? `${meta.targetId.slice(0, 16)}…${meta.targetId.slice(-10)}`
    : meta.targetId;
  return `${meta.targetType} · ${id}`;
}

function Workbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [actionStatus, setActionStatus] = useState("");
  const callTool = useMcpBridge();
  const [meta, setMeta] = useLiveMetadata();
  const connection = useLiveSession(meta, setMeta, setState, callTool);
  const visibleTarget = useRef<string | null>(null);
  const isCommand = meta?.targetType === "command" && !!meta.targetId && !!meta.workspaceId;
  const canControl = !!meta?.targetType && ["RUNNING", "WORKING", "CONNECTING", "APPROVAL_REQUIRED"].includes(state.status);

  useEffect(() => {
    const identity = workbenchTargetIdentity(meta?.targetType, meta?.targetId, meta?.workspaceId);
    if (visibleTarget.current === identity) return;
    visibleTarget.current = identity;
    setActionStatus("");
  }, [meta?.targetType, meta?.targetId, meta?.workspaceId]);

  useEffect(() => {
    hostBridge()?.notifyIntrinsicHeight?.(Math.min(680, Math.max(280, document.body.scrollHeight)));
  }, [state.status, state.transcript.length, connection, actionStatus]);

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

  return <main className="terminal-workbench" aria-label="CPTR live terminal">
    <TerminalView
      rows={state.transcript}
      status={state.status}
      connection={connection}
      targetLabel={targetLabel(meta)}
      actionStatus={actionStatus}
      canStop={canControl}
      onStop={() => void stop()}
      onCopy={() => void copyTranscript()}
      onPin={() => void pin()}
      onExpand={() => void expand()}
    />
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
