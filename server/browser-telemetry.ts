const SENSITIVE_ACTIVITY_KEY =
  /(?:^|_)(?:authorization|token|secret|password|passwd|credential|cookie|api[_-]?key|access[_-]?key|identityfile)(?:$|_)|^(?:content|command|stdin|data|prompt|goal|mission|expression|text|value|replacement|target|files|inputs|acceptance_criteria|note|query|pairing_code)$/i;

function redactionLabel(toolName: string, key: string): string {
  if (key === "pairing_code") return "[REDACTED_PAIRING_CODE]";
  if (toolName === "cptr_user_chrome" && key === "expression") {
    return "[REDACTED_BROWSER_EXPRESSION]";
  }
  if (
    toolName === "cptr_user_chrome"
    && /^(?:text|expression|value|password|prompt_text|approval_token)$/i.test(key)
  ) {
    return "[REDACTED_BROWSER_INPUT]";
  }
  if (toolName === "cptr_code" && key === "secret") {
    return "[REDACTED_SECRET_INPUT]";
  }
  return "[REDACTED_ACTIVITY_INPUT]";
}

function projectActivityValue(
  toolName: string,
  value: unknown,
  depth = 0,
): unknown {
  if (depth >= 6) return "[REDACTED_ACTIVITY_DEPTH]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) =>
      projectActivityValue(toolName, entry, depth + 1)
    );
  }
  if (!value || typeof value !== "object") return value;

  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (SENSITIVE_ACTIVITY_KEY.test(key)) {
      projected[key] = redactionLabel(toolName, key);
      continue;
    }
    projected[key] = projectActivityValue(toolName, item, depth + 1);
  }
  return projected;
}

export function telemetryInputForTool(toolName: string, value: unknown): unknown {
  return projectActivityValue(toolName, value);
}
