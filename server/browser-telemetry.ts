export function telemetryInputForTool(toolName: string, value: unknown): unknown {
  if (toolName !== "cptr_user_chrome" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const safe: Record<string, unknown> = { ...input };
  if (typeof safe.expression === "string") safe.expression = "[REDACTED_BROWSER_EXPRESSION]";
  const payload = input.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const source = payload as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source).slice(0, 100)) {
      if (/^(?:text|expression|value|password|prompt_text|approval_token)$/i.test(key)) {
        projected[key] = "[REDACTED_BROWSER_INPUT]";
      } else {
        projected[key] = item;
      }
    }
    safe.payload = projected;
  }
  return safe;
}
