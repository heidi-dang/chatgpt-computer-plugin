import { z } from "zod";

export const workspaceIdSchema = { workspace_id: z.string().min(1).max(200) };
export const taskIdSchema = { task_id: z.string().min(1).max(200) };
export const monitorIdSchema = { monitor_id: z.string().min(1).max(200) };

export const startTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const monitorAutonomousSchema = {
  action: z
    .enum(["create", "status", "events", "evidence", "steer", "cancel", "approve"])
    .default("create"),
  monitor_id: z.string().min(1).max(200).optional(),
  workspace_id: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(100_000).optional(),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100).optional(),
  model_id: z.string().min(1).max(500).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(50_000).optional(),
  approval_id: z.string().min(1).max(200).optional(),
  approved: z.boolean().optional(),
};

export const messageSchema = {
  task_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
};
