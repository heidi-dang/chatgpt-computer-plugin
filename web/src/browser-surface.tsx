import React, { useEffect, useRef, useState } from "react";

export type BrowserSurfaceProps = {
  frameUrl?: string;
  ticket?: string;
  sessionId?: string;
  active: boolean;
  connection: string;
  mode: "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL" | "DISCONNECTED";
  hostname?: string;
  actionLabel?: string;
};

export function BrowserSurface({
  frameUrl,
  ticket,
  sessionId,
  active,
  connection,
  mode,
  hostname = "Chrome",
  actionLabel = "Waiting",
}: BrowserSurfaceProps) {
  const shellRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastFrameId = useRef<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !active || !frameUrl || !ticket || !sessionId) return;
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
      } finally {
        bitmap.close();
      }
    };

    const pageHidden = () => document.visibilityState === "hidden";

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
          if (response.status === 204) continue;
          if (!response.ok) throw new Error(`browser frame unavailable (${response.status})`);
          await drawFrame(response);
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
      } finally {
        running = false;
        if (!stopped && intersecting && !pageHidden()) void poll();
      }
    };

    const updateVisibility = () => {
      if (!intersecting || pageHidden()) {
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
    void poll();

    return () => {
      stopped = true;
      controller?.abort();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [active, frameUrl, sessionId, ticket]);

  const state = connection.toLowerCase().includes("reconnect")
    ? "reconnecting"
    : connection.toLowerCase().includes("live")
      ? "live"
      : "offline";

  return <section ref={shellRef} className="browser-shell" data-state={state} aria-label="CPTR live browser">
    <header className="browser-header">
      <div className="browser-identity">
        <div className="browser-kicker">CPTR LIVE COMPUTER · BROWSER</div>
        <div className="browser-machine-row">
          <span className="browser-machine">{hostname}</span>
          <span className="browser-status" data-state={state} role="status" aria-live="polite">
            <span className="state-dot" aria-hidden="true" />
            <span>{state.toUpperCase()}</span>
          </span>
        </div>
      </div>
      <span className="browser-mode">{mode.replaceAll("_", " ")}</span>
    </header>
    <div className="browser-frame" aria-live="off">
      <canvas ref={canvasRef} className="browser-canvas" />
      {!hasFrame ? <div className="browser-empty">Waiting for browser frame…</div> : null}
    </div>
    <footer className="browser-footer">
      <span>{actionLabel}</span>
      <span>{mode}</span>
      <span className="browser-connection">{connection.toUpperCase()}</span>
    </footer>
  </section>;
}
