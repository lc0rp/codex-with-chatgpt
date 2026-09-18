import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { readRun } from "../session/runs.js";
import { redact } from "../logger/index.js";
import { sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  runId?: string;
  taskId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
}

interface OutputIndex {
  nextId: number;
  items: ExecutionOutputMeta[];
}

function outputDir(workspaceId: string, runId?: string): string {
  if (runId) readRun(runId, workspaceId);
  return ensureDir(path.join(getStateDir(), "execution-outputs", workspaceId, ...(runId ? ["runs", runId] : [])));
}

function indexFile(workspaceId: string, runId?: string): string {
  return path.join(outputDir(workspaceId, runId), "index.json");
}

function bodyFile(workspaceId: string, id: number, runId?: string): string {
  return path.join(outputDir(workspaceId, runId), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string, runId?: string): OutputIndex {
  return (
    readJsonIfExists<OutputIndex>(indexFile(workspaceId, runId)) ?? {
      nextId: 1,
      items: [],
    }
  );
}

function writeIndex(workspaceId: string, index: OutputIndex, runId?: string): void {
  writeSecureJson(indexFile(workspaceId, runId), index);
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  runId?: string;
  taskId?: string;
  iteration?: number;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput): ExecutionOutputMeta {
  const runId = input.runId;
  const sanitized = sanitizeExecutionOutput(input.raw);
  const index = readIndex(workspaceId, runId);
  const id = index.nextId;
  const timestamp = new Date().toISOString();
  const allowed = sanitized.allowed;
  const text = allowed ? sanitized.text : "";
  const truncated = allowed ? sanitized.truncated : false;
  const meta: ExecutionOutputMeta = {
    id,
    command: redact(input.command).slice(0, 200),
    exitCode: input.exitCode ?? null,
    timestamp,
    runId,
    taskId: input.taskId,
    iteration: input.iteration,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id, runId);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  while (index.items.length > MAX_OUTPUT_RECORDS) {
    const dropped = index.items.shift();
    if (dropped) {
      fs.rmSync(bodyFile(workspaceId, dropped.id, runId), { force: true });
    }
  }
  writeIndex(workspaceId, index, runId);
  return meta;
}

export function listExecutionOutputs(workspaceId: string, limit = 20, runId?: string): ExecutionOutputMeta[] {
  const items = readIndex(workspaceId, runId).items;
  return items.slice(-Math.max(1, Math.min(50, limit)));
}

export function readExecutionOutput(
  workspaceId: string,
  id: number,
  runId?: string
):
  | { ok: true; meta: ExecutionOutputMeta; text: string }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  const meta = readIndex(workspaceId, runId).items.find((item) => item.id === id);
  if (!meta) return { ok: false, error: "NOT_FOUND" };
  if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
  const file = bodyFile(workspaceId, id, runId);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ok: true, meta, text };
}
