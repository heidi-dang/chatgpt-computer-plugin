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
  workspace_id: z.string().min(1).max(200),
  goal: z.string().min(1).max(100_000),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const messageSchema = {
  task_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
};
