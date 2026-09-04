export const TERMINAL_TASK_STATUS_VALUES = [
  "COMPLETE",
  "COMPLETE_WITH_TOOL_ERRORS",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "REVIEW_REQUIRED",
  "REJECTED",
] as const;

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUS_VALUES);

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status.toUpperCase());
}
