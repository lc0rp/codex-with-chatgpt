import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { WorkspaceError, type Workspace } from "../workspace/manager.js";
import { mergeSession, readSession, type SavedSession, type SessionPatch } from "./state.js";

export const runIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Invalid run ID");
export interface RunContext {
  runId: string;
  workspaceId: string;
  workspacePath: string;
  codexThreadId?: string;
  createdAt: string;
  session: SavedSession;
}

export function runFile(runId: string): string {
  if (!runIdSchema.safeParse(runId).success) throw new WorkspaceError("INVALID_RUN", "run_id must contain only letters, digits, underscores or hyphens (max 128).");
  return path.join(getStateDir(), "runs", `${runId}.json`);
}

export function readRun(runId: string, workspaceId: string): RunContext {
  const file = runFile(runId);
  if (!fs.existsSync(file)) throw new WorkspaceError("RUN_NOT_FOUND", "Unknown run_id. Create it locally with c2c run create.");
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as RunContext;
  if (run.runId !== runId || run.workspaceId !== workspaceId) {
    throw new WorkspaceError("RUN_WORKSPACE_MISMATCH", "This run_id belongs to a different workspace.");
  }
  return run;
}

/** Exclusive creation prevents another task from silently rebinding an existing run. */
export function createRun(workspace: Workspace, opts: { runId?: string; codexThreadId?: string; session?: SessionPatch } = {}): RunContext {
  const runId = opts.runId ?? randomUUID();
  const defaults = readSession(workspace.id);
  // Only preferences carry over. Active chat pointers/checkpoints belong to a run.
  const patch = Object.fromEntries(Object.entries(opts.session ?? {}).filter(([, value]) => value !== undefined)) as SessionPatch;
  const session = mergeSession(null, {
    taskId: runId,
    conversationMode: patch.conversationMode ?? (patch.projectUrl ? "project" : defaults?.conversationMode),
    projectUrl: defaults?.projectUrl,
    connectorName: defaults?.connectorName,
    ...patch,
  });
  const run: RunContext = { runId, workspaceId: workspace.id, workspacePath: workspace.root, codexThreadId: opts.codexThreadId, createdAt: new Date().toISOString(), session };
  const file = runFile(runId);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(run, null, 2), { mode: 0o600, flag: "wx" });
  return run;
}

export function updateRunSession(runId: string, workspaceId: string, session: SavedSession): RunContext {
  const run = readRun(runId, workspaceId);
  const updated = {
    ...run,
    session: {
      ...session,
      checkpoint: session.checkpoint ? { ...session.checkpoint, projectUrl: session.projectUrl, chatUrl: session.url } : undefined,
    },
  };
  writeSecureJson(runFile(runId), updated);
  return updated;
}
