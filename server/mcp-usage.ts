import { getEncoding, getEncodingNameForModel } from "js-tiktoken";

export type NormalizedReportedModel = {
  reported: string | null;
  canonical: string | null;
};

export type TokenEstimate = {
  tokens: number;
  method: string;
  exact_for_model: boolean;
};

const DEFAULT_MAX_EXACT_BYTES = 512_000;
const MIN_MAX_EXACT_BYTES = 1_024;
const MAX_MAX_EXACT_BYTES = 2_000_000;

const MODEL_ALIASES = new Map<string, string>([
  ["gpt-5.6-sol", "gpt-5.6-sol"],
  ["gpt-5.6", "gpt-5.6-sol"],
  ["gpt-5.6-sol-pro", "gpt-5.6-sol-pro"],
  ["gpt-5.6-terra", "gpt-5.6-terra"],
  ["gpt-5.6-luna", "gpt-5.6-luna"],
  ["gpt-5.5", "gpt-5.5"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.3-codex", "gpt-5.3-codex"],
  ["gpt-5.2", "gpt-5.2"],
]);

const encodings = new Map<string, ReturnType<typeof getEncoding>>();

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function sanitizeReportedModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || null;
}

function modelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeReportedModel(value: unknown): NormalizedReportedModel {
  const reported = sanitizeReportedModel(value);
  if (!reported) return { reported: null, canonical: null };
  return {
    reported,
    canonical: MODEL_ALIASES.get(modelKey(reported)) ?? null,
  };
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

export function canonicalToolCallEnvelope(toolName: string, args: unknown): string {
  return stableJson({ name: toolName, arguments: args ?? {} });
}

export function canonicalMcpResultEnvelope(value: unknown): string {
  return stableJson(value);
}

function cachedEncoding(name: string): ReturnType<typeof getEncoding> {
  const existing = encodings.get(name);
  if (existing) return existing;
  const encoding = getEncoding(name as never);
  encodings.set(name, encoding);
  return encoding;
}

export function estimateModelTokens(modelId: string | null, text: string): TokenEstimate {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return { tokens: 0, method: "empty", exact_for_model: false };

  const bytes = Buffer.byteLength(value, "utf8");
  const maxExactBytes = boundedEnvInt(
    "CPTR_MCP_USAGE_MAX_EXACT_BYTES",
    DEFAULT_MAX_EXACT_BYTES,
    MIN_MAX_EXACT_BYTES,
    MAX_MAX_EXACT_BYTES,
  );
  if (bytes > maxExactBytes) {
    return {
      tokens: Math.max(1, Math.ceil(bytes / 4)),
      method: "utf8-byte-fallback",
      exact_for_model: false,
    };
  }

  if (modelId) {
    try {
      const encodingName = getEncodingNameForModel(modelId as never);
      return {
        tokens: cachedEncoding(encodingName).encode(value).length,
        method: `${encodingName}:model-map`,
        exact_for_model: true,
      };
    } catch {
      // Current/recent model IDs may not yet exist in js-tiktoken's model map.
    }
  }

  const encodingName = "o200k_base";
  try {
    return {
      tokens: cachedEncoding(encodingName).encode(value).length,
      method: `${encodingName}:fallback`,
      exact_for_model: false,
    };
  } catch {
    return {
      tokens: Math.max(1, Math.ceil(bytes / 4)),
      method: "utf8-byte-fallback",
      exact_for_model: false,
    };
  }
}
