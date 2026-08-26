export type DisplayMode = "inline" | "fullscreen" | "pip";

export type DisplayModeBridge = {
  requestDisplayMode?: (input: { mode: DisplayMode }) => Promise<{ mode?: DisplayMode } | void>;
};

export async function requestHostDisplayMode(
  bridge: DisplayModeBridge | undefined,
  mode: DisplayMode,
): Promise<DisplayMode | null> {
  if (!bridge?.requestDisplayMode) return null;
  const result = await bridge.requestDisplayMode({ mode });
  return result && typeof result === "object" && typeof result.mode === "string"
    ? result.mode
    : mode;
}
