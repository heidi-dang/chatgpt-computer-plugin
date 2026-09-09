export function telemetryInputForTool(toolName: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (toolName === "cptr_code" && input.action === "materialize_secret") {
    const safe: Record<string, unknown> = { ...input };
    const payload = input.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const projected = { ...(payload as Record<string, unknown>) };
      if (Object.prototype.hasOwnProperty.call(projected, "secret")) {
        projected.secret = "[REDACTED_SECRET_INPUT]";
      }
      safe.payload = projected;
    }
    return safe;
  }
  if (toolName !== "cptr_user_chrome") return value;
  const safe: Record<string, unknown> = { ...input };
  if (typeof safe.pairing_code === "string") safe.pairing_code = "[REDACTED_PAIRING_CODE]";
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
