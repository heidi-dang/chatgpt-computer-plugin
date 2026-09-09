import type { IncomingMessage } from "node:http";

export type LiveViewerIdentity = {
  id: string;
  startedAt: number;
};

export type CloseViewer = (reason?: "superseded" | "closed") => void;

type ActiveViewer = LiveViewerIdentity & { close: CloseViewer };

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function liveViewerIdentity(request: IncomingMessage): LiveViewerIdentity | null {
  const id = singleHeader(request, "x-cptr-viewer-id")?.trim();
  const startedAtValue = singleHeader(request, "x-cptr-viewer-started-at")?.trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  if (!startedAtValue || !/^\d{1,16}$/.test(startedAtValue)) return null;
  const startedAt = Number(startedAtValue);
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
  return { id, startedAt };
}

function compare(a: LiveViewerIdentity, b: LiveViewerIdentity): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  return a.id.localeCompare(b.id);
}

export class LiveViewerRegistry {
  private readonly active = new Map<string, ActiveViewer>();

  claim(scope: string, viewer: LiveViewerIdentity | null, close: CloseViewer): "accepted" | "replaced" | "superseded" {
    if (!viewer) return "accepted";
    const current = this.active.get(scope);
    if (current && current.id !== viewer.id && compare(current, viewer) > 0) return "superseded";
    if (current) {
      current.close(current.id !== viewer.id ? "superseded" : "closed");
      this.active.set(scope, { ...viewer, close });
      return "replaced";
    }
    this.active.set(scope, { ...viewer, close });
    return "accepted";
  }

  release(scope: string, viewer: LiveViewerIdentity | null): void {
    if (!viewer) return;
    const current = this.active.get(scope);
    if (current?.id === viewer.id && current.startedAt === viewer.startedAt) this.active.delete(scope);
  }
}
