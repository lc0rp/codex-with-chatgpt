import type { Command } from "commander";
import path from "node:path";
import { configureSharedConnection, disableSharedConnection, readSharedConnection, SHARED_CONNECTION_ID } from "../config/connection.js";
import { canonicalRoots } from "../workspace/router.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { withBridgeLock } from "../process/lock.js";
import { Workspace } from "../workspace/manager.js";
import { createRun, readRun } from "../session/runs.js";
import type { ConversationMode } from "../session/state.js";

const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

async function requireStopped(): Promise<void> {
  const observation = await findBridgeObservation(SHARED_CONNECTION_ID);
  if (observation.state !== "stopped") throw new Error("Stop the shared bridge with c2c stop before changing its approved roots or disabling shared mode.");
}

export function registerSharedCommands(program: Command): void {
  const connection = program.command("connection").description("Configure the machine-wide shared connection (explicit opt-in)");
  connection.command("get").option("-w, --workspace <path>", "ignored; machine-wide").option("--json")
    .action(() => print({ connectionId: SHARED_CONNECTION_ID, mode: readSharedConnection() ? "shared" : "single", config: readSharedConnection() }));
  connection.command("configure")
    .description("Approve these local roots for one shared connector; existing workspace tokens stay unchanged")
    .requiredOption("--allow-root <paths...>", "absolute directories to approve, including subdirectories")
    .option("-w, --workspace <path>", "ignored; machine-wide").option("--json")
    .action(async (opts: { allowRoot: string[] }) => {
      const roots = canonicalRoots(opts.allowRoot);
      await withBridgeLock(SHARED_CONNECTION_ID, async () => {
        if (JSON.stringify(readSharedConnection()?.allowedRoots) !== JSON.stringify(roots)) await requireStopped();
        print({ ok: true, connectionId: SHARED_CONNECTION_ID, mode: "shared", ...configureSharedConnection(roots), reauthorize: true });
      });
    });
  connection.command("disable").option("-w, --workspace <path>", "ignored; machine-wide").option("--json")
    .action(async () => {
      await withBridgeLock(SHARED_CONNECTION_ID, async () => { await requireStopped(); disableSharedConnection(); });
      print({ ok: true, mode: "single", message: "Legacy workspace state and shared grants were preserved." });
    });

  const run = program.command("run").description("Create or inspect isolated local-workspace / ChatGPT-Project run context");
  run.command("create").option("-w, --workspace <path>")
    .option("--run-id <id>", "unique run ID (generated when omitted)")
    .option("--project-url <url>", "overrides the saved Project preference for this run")
    .option("--url <url>", "ChatGPT conversation URL for this run")
    .option("--mode <mode>", "project or long-chat")
    .option("--codex-thread-id <id>")
    .option("--json")
    .action((opts: { workspace?: string; runId?: string; projectUrl?: string; url?: string; mode?: string; codexThreadId?: string }) => {
      if (opts.mode && opts.mode !== "project" && opts.mode !== "long-chat") throw new Error("mode must be project or long-chat");
      const workspace = new Workspace(path.resolve(opts.workspace ?? process.cwd()));
      print(createRun(workspace, { runId: opts.runId, codexThreadId: opts.codexThreadId, session: { projectUrl: opts.projectUrl, url: opts.url, conversationMode: opts.mode as ConversationMode | undefined } }));
    });
  run.command("get").option("-w, --workspace <path>").requiredOption("--run-id <id>").option("--json")
    .action((opts: { workspace?: string; runId: string }) => {
      const workspace = new Workspace(path.resolve(opts.workspace ?? process.cwd()));
      print(readRun(opts.runId, workspace.id));
    });
}
