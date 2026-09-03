import React, { useEffect, useRef, useState } from "react";

export type BrowserSurfaceProps = {
  frameUrl?: string;
  inputUrl?: string;
  ticket?: string;
  sessionId?: string;
  epoch?: number;
  active: boolean;
  released?: boolean;
  connection: string;
  mode: "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL" | "DISCONNECTED";
  hostname?: string;
  actionLabel?: string;
};

type HumanInputPayload = {
  input_type: string;
  x?: number;
  y?: number;
  delta_x?: number;
  delta_y?: number;
  button?: string;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: string[];
  pointer_id?: number;
  width?: number;
  height?: number;
  sensitive?: boolean;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function modifiers(event: Pick<KeyboardEvent | PointerEvent | WheelEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): string[] {
  const values: string[] = [];
  if (event.altKey) values.push("Alt");
  if (event.ctrlKey) values.push("Control");
  if (event.metaKey) values.push("Meta");
  if (event.shiftKey) values.push("Shift");
  return values;
}

function buttonName(button: number): string {
  return ["left", "middle", "right", "back", "forward"][button] ?? "none";
}

export function BrowserSurface({
  frameUrl,
  inputUrl,
  ticket,
  sessionId,
  epoch,
  active,
  released = false,
  connection,
  mode,
  hostname = "Chrome",
  actionLabel = "Waiting",
}: BrowserSurfaceProps) {
  const shellRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastFrameId = useRef<string | null>(null);
  const commandSequence = useRef(0);
  const moveInFlight = useRef(false);
  const pendingMove = useRef<HumanInputPayload | null>(null);
  const lastStreamVisible = useRef<boolean | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [frameStatus, setFrameStatus] = useState("Waiting for browser frame…");
  const [frameHealth, setFrameHealth] = useState<"waiting" | "live" | "reconnecting" | "released">("waiting");
  const [returningControl, setReturningControl] = useState(false);
  const browserReleased = Boolean(sessionId) && (released || mode === "DISCONNECTED");

  const canHumanInput = active && !browserReleased && mode === "HUMAN_CONTROL" && Boolean(inputUrl && ticket && sessionId && Number.isInteger(epoch));

  const postInput = async (payload: HumanInputPayload): Promise<void> => {
    if (!canHumanInput || !inputUrl || !ticket || !sessionId || epoch === undefined) return;
    commandSequence.current += 1;
    const commandId = `human_${Date.now().toString(36)}_${commandSequence.current.toString(36)}`;
    await fetch(inputUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ticket}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        session_id: sessionId,
        command_id: commandId,
        expected_epoch: epoch,
        ...payload,
      }),
    });
  };

  const returnToAgent = async (): Promise<void> => {
    if (!canHumanInput || !inputUrl || !ticket || !sessionId || epoch === undefined || returningControl) return;
    setReturningControl(true);
    try {
      const url = new URL("/live/prompt/browser-return", inputUrl);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ticket}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ session_id: sessionId, expected_epoch: epoch }),
      });
      if (!response.ok) throw new Error(`browser return unavailable (${response.status})`);
    } catch {
      setReturningControl(false);
    }
  };

  const flushMove = async (payload: HumanInputPayload): Promise<void> => {
    if (moveInFlight.current) {
      pendingMove.current = payload;
      return;
    }
    moveInFlight.current = true;
    try {
      let next: HumanInputPayload | null = payload;
      while (next) {
        await postInput(next).catch(() => undefined);
        next = pendingMove.current;
        pendingMove.current = null;
      }
    } finally {
      moveInFlight.current = false;
    }
  };

  const normalizedPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return {
      x: clamp01((event.clientX - rect.left) / width),
      y: clamp01((event.clientY - rect.top) / height),
    };
  };

  useEffect(() => {
    setHasFrame(false);
    lastFrameId.current = null;
    if (!sessionId) {
      setFrameHealth("waiting");
      setFrameStatus("No Chrome session is attached yet.");
      return;
    }
    if (browserReleased) {
      setFrameHealth("released");
      setFrameStatus("Browser control released. Chrome debugger is detached.");
      return;
    }
    setFrameHealth("waiting");
    setFrameStatus("Waiting for the first browser frame…");
    const shell = shellRef.current;
    if (!shell || !active || !frameUrl || !ticket) return;
    let intersecting = true;
    let stopped = false;
    let controller: AbortController | null = null;
    let running = false;

    const drawFrame = async (response: Response) => {
      const frameId = response.headers.get("x-cptr-frame-id");
      if (!frameId || frameId === lastFrameId.current) return;
      const blob = await response.blob();
      if (stopped || !intersecting || document.visibilityState === "hidden") return;
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = canvasRef.current;
        if (!canvas || stopped) return;
        const width = Math.max(1, Number(response.headers.get("x-cptr-frame-width")) || bitmap.width);
        const height = Math.max(1, Number(response.headers.get("x-cptr-frame-height")) || bitmap.height);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        context.drawImage(bitmap, 0, 0, width, height);
        lastFrameId.current = frameId;
        setHasFrame(true);
        setFrameHealth("live");
        setFrameStatus("");
      } finally {
        bitmap.close();
      }
    };

    const pageHidden = () => document.visibilityState === "hidden";

    const configureSourceVisibility = (visible: boolean) => {
      if (lastStreamVisible.current === visible || !inputUrl || !ticket || !sessionId || epoch === undefined) return;
      lastStreamVisible.current = visible;
      const url = new URL("/live/prompt/browser-stream", inputUrl);
      void fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ticket}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          session_id: sessionId,
          expected_epoch: epoch,
          visible,
          max_fps: visible ? 10 : 0,
          max_width: visible ? 1280 : 960,
          quality: visible ? 68 : 55,
        }),
      }).catch(() => undefined);
    };

    const poll = async () => {
      if (running || stopped || !intersecting || pageHidden()) return;
      running = true;
      try {
        while (!stopped && intersecting && !pageHidden()) {
          controller = new AbortController();
          const url = new URL(frameUrl, window.location.href);
          url.searchParams.set("session_id", sessionId);
          if (lastFrameId.current) url.searchParams.set("after_frame_id", lastFrameId.current);
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${ticket}`, Accept: "image/jpeg, image/webp" },
            signal: controller.signal,
            cache: "no-store",
          });
          controller = null;
          if (response.status === 204) {
            if (!lastFrameId.current) {
              setFrameHealth("waiting");
              setFrameStatus("Waiting for the first browser frame…");
            }
            continue;
          }
          if (!response.ok) throw new Error(`browser frame unavailable (${response.status})`);
          await drawFrame(response);
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) {
          setFrameHealth("reconnecting");
          setFrameStatus("Browser preview interrupted — reconnecting…");
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
      } finally {
        running = false;
        if (!stopped && intersecting && !pageHidden()) void poll();
      }
    };

    const updateVisibility = () => {
      const visible = intersecting && !pageHidden();
      configureSourceVisibility(visible);
      if (!visible) {
        controller?.abort();
        controller = null;
        return;
      }
      void poll();
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          intersecting = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
          updateVisibility();
        }, { threshold: 0.01 });
    observer?.observe(shell);
    document.addEventListener("visibilitychange", updateVisibility);
    configureSourceVisibility(intersecting && !pageHidden());
    void poll();

    return () => {
      configureSourceVisibility(false);
      stopped = true;
      controller?.abort();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [active, browserReleased, epoch, frameUrl, inputUrl, sessionId, ticket]);

  const promptState = connection.toLowerCase().includes("reconnect")
    ? "reconnecting"
    : connection.toLowerCase().includes("live")
      ? "live"
      : "offline";
  const state = browserReleased
    ? "offline"
    : frameHealth === "live"
      ? "live"
      : frameHealth === "reconnecting" || promptState === "reconnecting"
        ? "reconnecting"
        : promptState === "offline"
          ? "offline"
          : "connecting";
  const statusLabel = browserReleased
    ? "RELEASED"
    : frameHealth === "live"
      ? "LIVE"
      : frameHealth === "reconnecting"
        ? "RECONNECTING"
        : promptState === "offline"
          ? "OFFLINE"
          : "CONNECTING";

  return <section ref={shellRef} className="browser-shell" data-state={state} data-released={browserReleased ? "true" : "false"} aria-label="CPTR live browser">
    <header className="browser-header">
      <div className="browser-identity">
        <div className="browser-kicker">CPTR LIVE COMPUTER · BROWSER</div>
        <div className="browser-machine-row">
          <span className="browser-machine">{hostname}</span>
          <span className="browser-status" data-state={state} role="status" aria-live="polite">
            <span className="state-dot" aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
        </div>
      </div>
      <span className="browser-mode">{browserReleased ? "DISCONNECTED" : mode.replaceAll("_", " ")}</span>
    </header>
    <div className="browser-frame" aria-live="off">
      <canvas
        ref={canvasRef}
        className="browser-canvas"
        tabIndex={canHumanInput ? 0 : -1}
        aria-label={canHumanInput ? "Chrome browser, human control active" : "Chrome browser preview"}
        onPointerMove={(event) => {
          if (!canHumanInput) return;
          void flushMove({ input_type: "pointer_move", ...normalizedPoint(event), pointer_id: event.pointerId, modifiers: modifiers(event.nativeEvent) });
        }}
        onPointerDown={(event) => {
          if (!canHumanInput) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.currentTarget.focus();
          void postInput({ input_type: "pointer_down", ...normalizedPoint(event), pointer_id: event.pointerId, button: buttonName(event.button), modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
        }}
        onPointerUp={(event) => {
          if (!canHumanInput) return;
          void postInput({ input_type: "pointer_up", ...normalizedPoint(event), pointer_id: event.pointerId, button: buttonName(event.button), modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
        }}
        onDoubleClick={(event) => {
          if (!canHumanInput) return;
          void postInput({ input_type: "double_click", ...normalizedPoint(event), button: buttonName(event.button), modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
        }}
        onWheel={(event) => {
          if (!canHumanInput) return;
          event.preventDefault();
          void postInput({ input_type: "wheel", ...normalizedPoint(event), delta_x: event.deltaX, delta_y: event.deltaY, modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
        }}
        onKeyDown={(event) => {
          if (!canHumanInput) return;
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            void postInput({ input_type: "text_input", text: event.key, sensitive: false }).catch(() => undefined);
            event.preventDefault();
            return;
          }
          void postInput({ input_type: "key_down", key: event.key, code: event.code, modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
          event.preventDefault();
        }}
        onKeyUp={(event) => {
          if (!canHumanInput || event.key.length === 1) return;
          void postInput({ input_type: "key_up", key: event.key, code: event.code, modifiers: modifiers(event.nativeEvent) }).catch(() => undefined);
          event.preventDefault();
        }}
      />
      {!hasFrame ? <div className="browser-empty" data-state={frameHealth}>
        <strong>{frameStatus || "Waiting for browser frame…"}</strong>
        <span>{browserReleased
          ? "This browser session is finished and no frame polling is running."
          : frameHealth === "reconnecting"
            ? "Control stays safe while the preview transport reconnects."
            : "The preview will appear here when Chrome publishes its first frame."}</span>
      </div> : null}
      {hasFrame && frameHealth === "reconnecting" ? <div className="browser-frame-badge">Preview reconnecting…</div> : null}
      {mode === "HUMAN_CONTROL" && !browserReleased ? <div className="browser-human-hint">
        <span>Human control · touch, pointer, wheel and keyboard are live</span>
        <button type="button" disabled={returningControl} onClick={() => void returnToAgent()}>
          {returningControl ? "Returning…" : "Return to agent"}
        </button>
      </div> : null}
    </div>
    <footer className="browser-footer">
      <span>{browserReleased ? "browser session released" : actionLabel}</span>
      <span>{browserReleased ? "DISCONNECTED" : mode}</span>
      <span className="browser-connection" data-state={promptState}>{connection.toUpperCase()}</span>
    </footer>
  </section>;
}
