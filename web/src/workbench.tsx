import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  appendMcpToolActivity,
  eventTerminatesWorkbench,
  initialWorkbenchState,
  isTerminalWorkbenchStatus,
  LiveTargetSession,
  reduceWorkbenchEvent,
  reduceWorkbenchEvents,
  workbenchTargetIdentity,
  type McpToolActivity,
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

const TERMINAL_COORDINATION_CHANNEL = "cptr-live-terminal:v1";
const TERMINAL_OWNER_KEY = "cptr-live-terminal-owner:v1";
const TERMINAL_OWNER_TTL_MS = 5_000;
const TERMINAL_OWNER_REFRESH_MS = 1_500;

type TerminalOwnerLease = { instanceId: string; expiresAt: number };
type TerminalCoordinationMessage =
  | { type: "live"; sender: string; value: LiveMetadata }
  | { type: "activity"; sender: string; value: McpToolActivity };

function hostBridge(): HostBridge | undefined {
  return (window as Window & { openai?: HostBridge }).openai;
}

function createTerminalChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(TERMINAL_COORDINATION_CHANNEL) : null;
  } catch {
    return null;
  }
}

function readOwnerLease(): TerminalOwnerLease | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_OWNER_KEY);
    if (!raw) return null;
    const lease = JSON.parse(raw) as Partial<TerminalOwnerLease>;
    if (typeof lease.instanceId !== "string" || typeof lease.expiresAt !== "number" || lease.expiresAt <= Date.now()) {
      window.localStorage.removeItem(TERMINAL_OWNER_KEY);
      return null;
    }
    return lease as TerminalOwnerLease;
  } catch {
    return null;
  }
}

function writeOwnerLease(instanceId: string): boolean {
  try {
    window.localStorage.setItem(TERMINAL_OWNER_KEY, JSON.stringify({
      instanceId,
      expiresAt: Date.now() + TERMINAL_OWNER_TTL_MS,
    } satisfies TerminalOwnerLease));
    return readOwnerLease()?.instanceId === instanceId;
  } catch {
    return false;
  }
}

function terminalStorageAvailable(): boolean {
  try {
    const probe = `${TERMINAL_OWNER_KEY}:probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function tryClaimTerminal(instanceId: string): boolean {
  if (!terminalStorageAvailable()) return true;
  const current = readOwnerLease();
  if (current && current.instanceId !== instanceId) return false;
  return writeOwnerLease(instanceId);
}

function useTerminalOwnership(): boolean {
  const instanceId = useRef(crypto.randomUUID()).current;
  const [owner, setOwner] = useState(() => tryClaimTerminal(instanceId));

  useEffect(() => {
    const refresh = () => {
      const current = readOwnerLease();
      if (owner) {
        if (!current || current.instanceId === instanceId) {
          if (!writeOwnerLease(instanceId)) setOwner(false);
        } else {
          setOwner(false);
        }
      } else if (!current && tryClaimTerminal(instanceId)) {
        setOwner(true);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== TERMINAL_OWNER_KEY) return;
      const current = readOwnerLease();
      if (current?.instanceId === instanceId) setOwner(true);
      else if (current) setOwner(false);
      else if (tryClaimTerminal(instanceId)) setOwner(true);
    };
    refresh();
    const timer = window.setInterval(refresh, TERMINAL_OWNER_REFRESH_MS);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      const current = readOwnerLease();
      if (current?.instanceId === instanceId) {
        try { window.localStorage.removeItem(TERMINAL_OWNER_KEY); } catch { /* storage unavailable */ }
      }
    };
  }, [instanceId, owner]);

  return owner;
}

function useBridgeRelay() {
  const sender = useRef(crypto.randomUUID()).current;
  useEffect(() => {
    const channel = createTerminalChannel();
    if (!channel) return;
    const publish = (value: unknown) => {
      const live = findLiveMetadata(value);
      if (live) channel.postMessage({ type: "live", sender, value: live } satisfies TerminalCoordinationMessage);
      const activity = findMcpToolActivity(value);
      if (activity) channel.postMessage({ type: "activity", sender, value: activity } satisfies TerminalCoordinationMessage);
    };
    publish(hostBridge()?.toolResponseMetadata);
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent || event.data?.method !== "ui/notifications/tool-result") return;
      publish(event.data.params);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      channel.close();
    };
  }, [sender]);
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

function findMcpToolActivity(value: unknown): McpToolActivity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record["cptr/activity"];
  if (direct && typeof direct === "object") {
    const activity = direct as Record<string, unknown>;
    if (activity.type === "mcp.tool" && typeof activity.event_id === "string" && typeof activity.timestamp === "string") {
      return direct as McpToolActivity;
    }
  }
  for (const key of ["_meta", "params", "result", "toolResult"]) {
    const found = findMcpToolActivity(record[key]);
    if (found) return found;
  }
  return null;
}

function useLiveMetadata(): [LiveMetadata | null, React.Dispatch<React.SetStateAction<LiveMetadata | null>>] {
  const [metadata, setMetadata] = useState<LiveMetadata | null>(() => findLiveMetadata(hostBridge()?.toolResponseMetadata));
  useEffect(() => {
    const channel = createTerminalChannel();
    const onCoordinationMessage = (event: MessageEvent<TerminalCoordinationMessage>) => {
      if (event.data?.type === "live") setMetadata(event.data.value);
    };
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent || event.data?.method !== "ui/notifications/tool-result") return;
      const found = findLiveMetadata(event.data.params);
      if (found) setMetadata(found);
    };
    channel?.addEventListener("message", onCoordinationMessage);
    window.addEventListener("message", onMessage);
    return () => {
      channel?.removeEventListener("message", onCoordinationMessage);
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, []);
  return [metadata, setMetadata];
}

function useMcpToolActivity(setState: React.Dispatch<React.SetStateAction<WorkbenchState>>) {
  useEffect(() => {
    const channel = createTerminalChannel();
    const applyActivity = (activity: McpToolActivity | null) => {
      if (activity) setState((current) => appendMcpToolActivity(current, activity));
    };
    const apply = (value: unknown) => applyActivity(findMcpToolActivity(value));
    const onCoordinationMessage = (event: MessageEvent<TerminalCoordinationMessage>) => {
      if (event.data?.type === "activity") applyActivity(event.data.value);
    };
    apply(hostBridge()?.toolResponseMetadata);
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window.parent || event.data?.method !== "ui/notifications/tool-result") return;
      apply(event.data.params);
    };
    channel?.addEventListener("message", onCoordinationMessage);
    window.addEventListener("message", onMessage);
    return () => {
      channel?.removeEventListener("message", onCoordinationMessage);
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, [setState]);
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
        clientInfo: { name: "cptr-live-terminal", version: "0.5.0" },
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
      setState((current) => ({ ...current, status: "CONNECTING", lastSequence: 0 }));
    }
    if (!meta?.ticket || !meta.streamUrl || !meta.snapshotUrl) {
      setConnection("activity feed ready");
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

function OwnedWorkbench() {
  const [state, setState] = useState(initialWorkbenchState);
  const [actionStatus, setActionStatus] = useState("");
  const callTool = useMcpBridge();
  const [meta, setMeta] = useLiveMetadata();
  useMcpToolActivity(setState);
  const connection = useLiveSession(meta, setMeta, setState, callTool);
  const visibleTarget = useRef<string | null>(null);
  const autoPinAttempted = useRef(false);
  const isCommand = meta?.targetType === "command" && !!meta.targetId && !!meta.workspaceId;
  const canControl = !!meta?.targetType && ["RUNNING", "WORKING", "CONNECTING", "APPROVAL_REQUIRED"].includes(state.status);
  const displayStatus = meta?.targetType && meta.targetId
    ? state.status
    : state.transcript.length ? "ACTIVE" : "READY";

  useEffect(() => {
    const identity = workbenchTargetIdentity(meta?.targetType, meta?.targetId, meta?.workspaceId);
    if (visibleTarget.current === identity) return;
    visibleTarget.current = identity;
    setActionStatus("");
  }, [meta?.targetType, meta?.targetId, meta?.workspaceId]);

  useEffect(() => {
    if (autoPinAttempted.current) return;
    autoPinAttempted.current = true;
    void requestHostDisplayMode(hostBridge(), "pip")
      .then((granted) => {
        if (granted === "pip") setActionStatus("terminal pinned");
      })
      .catch(() => undefined);
  }, []);

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
      status={displayStatus}
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

function Workbench() {
  useBridgeRelay();
  const owner = useTerminalOwnership();

  useEffect(() => {
    if (!owner) hostBridge()?.notifyIntrinsicHeight?.(1);
  }, [owner]);

  return owner ? <OwnedWorkbench /> : null;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
