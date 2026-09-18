import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { createRun, readRun, updateRunSession } from "../src/session/runs.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { AuthStore, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { WorkspaceRouter } from "../src/workspace/router.js";
import { cleanup, git, isolateStateDir, makeGitRepo, write } from "./helpers.js";

let parent: string, state: string, a: string, b: string, plain: string, outside: string;
let bridge: Bridge, client: Client;
const clients: Client[] = [];
const projectA = "https://chatgpt.com/g/g-p-AAA/project";
const projectB = "https://chatgpt.com/g/g-p-BBB/project";

async function connect(roots: string[], scopes: string[] = [...SUPPORTED_SCOPES]): Promise<Client> {
  const tokens = bridge.authStore.issueTokens({ clientId: "shared-tests", scopes, resource: `${bridge.localBaseUrl()}/mcp`, allowedRoots: roots });
  const c = new Client({ name: "shared-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  }));
  clients.push(c);
  return c;
}
async function call(name: string, args: Record<string, unknown>, c = client) {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0].text;
  let data: Record<string, any>;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  return { ...data, isError: result.isError === true };
}
function record(workspace: string, runId: string, label: string): void {
  const ws = new Workspace(workspace);
  const output = saveExecutionOutput(ws.id, { runId, command: "npm test", raw: `${label} passed`, taskId: label });
  appendExecutionRecord(ws.id, { runId, taskId: label, iteration: 1, changedFiles: 1, tests: label, exitStatus: "ok", timestamp: new Date().toISOString(), outputAvailable: true, outputId: output.id });
}

beforeAll(async () => {
  state = isolateStateDir();
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-shared-"));
  a = path.join(parent, "a"); b = path.join(parent, "b"); plain = path.join(parent, "plain");
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-outside-"));
  for (const dir of [a, b, plain]) fs.mkdirSync(dir);
  makeGitRepo(a); makeGitRepo(b); git(b, "checkout", "-b", "second-project");
  write(a, "hello.txt", "unique-alpha\n"); write(b, "hello.txt", "unique-beta\n"); write(plain, "hello.txt", "plain folder\n");
  write(a, ".env", "SECRET=hidden"); write(outside, "hello.txt", "outside data");
  write(a, ".c2cignore", "nested/private/\n"); write(a, "nested/private/hidden.txt", "hidden");
  fs.symlinkSync(outside, path.join(a, "escape"), "dir");
  fs.symlinkSync(b, path.join(a, "other-project"), "dir");
  fs.symlinkSync(a, path.join(parent, "alias-a"), "dir");
  createRun(new Workspace(a), { runId: "run-a", session: { projectUrl: projectA } });
  createRun(new Workspace(a), { runId: "run-a2", session: { projectUrl: projectB } });
  createRun(new Workspace(b), { runId: "run-b", session: { projectUrl: projectB } });
  record(a, "run-a", "alpha"); record(a, "run-a2", "other-chat"); record(b, "run-b", "beta");
  bridge = await startBridge({ workspaceRoot: a, allowedRoots: [parent], port: 0, persistRuntime: false });
  client = await connect([parent]);
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await bridge.close(); cleanup(parent); cleanup(outside); cleanup(state); });

describe("one shared MCP connection", () => {
  it("requires explicit workspace_path on all nine tools and run_id for execution tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain("workspace_path");
      if (["test_status", "execution_summary", "execution_output"].includes(tool.name)) expect(tool.inputSchema.required).toContain("run_id");
      expect((await call(tool.name, { path: "hello.txt", query: "unique", run_id: "run-a" })).isError).toBe(true);
    }
  });
  it("routes interleaved calls with identical filenames without cross-chat state", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => call("read_file", { workspace_path: n % 2 ? b : a, path: "hello.txt" })));
    results.forEach((r, n) => { expect(r.content).toBe(n % 2 ? "unique-beta" : "unique-alpha"); expect(r.workspacePath).toBe(n % 2 ? b : a); });
    const info = await call("workspace_info", { workspace_path: b });
    expect(info.workspaceId).toBe(new Workspace(b).id); expect(info.git.branch).toBe("second-project");
  });
  it("routes list, search, Git status and diff to the selected workspace", async () => {
    for (const [workspace, marker, branch] of [[a, "alpha", "main"], [b, "beta", "second-project"]]) {
      expect((await call("list_directory", { workspace_path: workspace })).entries.some((e: any) => e.path === "hello.txt")).toBe(true);
      expect((await call("search_workspace", { workspace_path: workspace, query: `unique-${marker}` })).matches[0].text).toContain(marker);
      expect((await call("git_status", { workspace_path: workspace })).branch).toBe(branch);
      expect((await call("git_diff", { workspace_path: workspace })).diff).toContain(`unique-${marker}`);
    }
  });
  it("supports ordinary non-Git folders", async () => {
    expect((await call("workspace_info", { workspace_path: plain })).git.isRepo).toBe(false);
    expect((await call("git_status", { workspace_path: plain })).isRepo).toBe(false);
    expect((await call("git_diff", { workspace_path: plain })).isRepo).toBe(false);
    expect((await call("read_file", { workspace_path: plain, path: "hello.txt" })).content).toBe("plain folder");
  });
  it("isolates test results, histories, and output IDs across runs and workspaces", async () => {
    for (const [workspace, runId, label] of [[a, "run-a", "alpha"], [a, "run-a2", "other-chat"], [b, "run-b", "beta"]]) {
      const args = { workspace_path: workspace, run_id: runId };
      expect((await call("test_status", args)).tests).toBe(label);
      expect((await call("execution_summary", args)).records.map((r: any) => r.taskId)).toEqual([label]);
      const list = await call("execution_output", args);
      expect(list.items).toHaveLength(1);
      expect((await call("execution_output", { ...args, action: "read", id: list.items[0].id })).text).toContain(`${label} passed`);
    }
    expect((await call("test_status", { workspace_path: a })).isError).toBe(true);
    expect((await call("test_status", { workspace_path: b, run_id: "run-a" })).error).toBe("RUN_WORKSPACE_MISMATCH");
    expect((await call("execution_summary", { workspace_path: a, run_id: "missing" })).error).toBe("RUN_NOT_FOUND");
    expect((await call("execution_output", { workspace_path: a, run_id: "run-a2", action: "read", id: 999 })).error).toBe("NOT_FOUND");
  });
  it("keeps two web Projects independent of connection state", async () => {
    const id = new Workspace(a).id;
    const run = readRun("run-a", id);
    const before = bridge.localBaseUrl();
    updateRunSession("run-a", id, mergeSession(run.session, { projectUrl: projectB }));
    expect(readRun("run-a2", id).session.projectUrl).toBe(projectB);
    expect(readRun("run-b", new Workspace(b).id).session.projectUrl).toBe(projectB);
    expect(bridge.localBaseUrl()).toBe(before);
    expect(readSession(id)).toBeNull();
  });
});

describe("shared connection authorization", () => {
  it("blocks unauthorized roots, prefix siblings, relative paths, and symlink escapes", async () => {
    expect((await call("workspace_info", { workspace_path: outside })).error).toBe("WORKSPACE_NOT_AUTHORIZED");
    expect((await call("workspace_info", { workspace_path: path.join(a, "escape") })).error).toBe("WORKSPACE_NOT_AUTHORIZED");
    expect((await call("workspace_info", { workspace_path: "relative/path" })).error).toBe("INVALID_PATH");
    expect((await call("workspace_info", { workspace_path: path.join(a, "hello.txt") })).error).toBe("NOT_A_DIRECTORY");
    expect((await call("read_file", { workspace_path: a, path: "other-project/hello.txt" })).error).toBe("PATH_OUTSIDE_WORKSPACE");
    expect((await call("read_file", { workspace_path: a, path: "../b/hello.txt" })).error).toBe("PATH_OUTSIDE_WORKSPACE");
    expect((await call("workspace_info", { workspace_path: path.join(parent, "alias-a") })).workspacePath).toBe(a);
  });
  it("preserves sensitive/custom exclusions, including when selecting nested roots", async () => {
    expect((await call("read_file", { workspace_path: a, path: ".env" })).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    expect((await call("workspace_info", { workspace_path: path.join(a, "nested/private") })).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    expect((await call("workspace_info", { workspace_path: path.join(a, ".git") })).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
  });
  it("cannot bypass an ancestor's excluded files by selecting a narrower workspace", async () => {
    const nested = path.join(a, "safe-child");
    write(nested, "hidden.txt", "must remain hidden");
    write(nested, "visible.txt", "visible");
    write(a, ".c2cignore", "nested/private/\nsafe-child/hidden.txt\n");
    expect((await call("read_file", { workspace_path: nested, path: "hidden.txt" })).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    expect((await call("read_file", { workspace_path: nested, path: "visible.txt" })).content).toContain("visible");
    expect((await call("list_directory", { workspace_path: nested })).entries.map((entry: { path: string }) => entry.path)).not.toContain("hidden.txt");
  });
  it("intersects the token grant with server policy and still enforces operation scopes", async () => {
    const limited = await connect([a], ["workspace.read"]);
    expect((await call("read_file", { workspace_path: a, path: "hello.txt" }, limited)).isError).toBe(false);
    expect((await call("read_file", { workspace_path: b, path: "hello.txt", allowedRoots: [parent] }, limited)).error).toBe("WORKSPACE_NOT_AUTHORIZED");
    expect((await call("git_status", { workspace_path: a }, limited)).error).toBe("INSUFFICIENT_SCOPE");
    const outsideGrant = await connect([outside]);
    expect((await call("workspace_info", { workspace_path: outside }, outsideGrant)).error).toBe("WORKSPACE_NOT_AUTHORIZED");
  });
  it("rejects missing or wrong audience and grants without silently upgrading legacy tokens", async () => {
    for (const input of [{}, { resource: "https://wrong.example/mcp", allowedRoots: [parent] }, { resource: `${bridge.localBaseUrl()}/mcp` }]) {
      const token = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"], ...input });
      const response = await fetch(`${bridge.localBaseUrl()}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
    }
  });
  it("rotates and persists the original resource and roots without broadening access", () => {
    const resource = `${bridge.localBaseUrl()}/mcp`;
    const store = new AuthStore("grant-persistence");
    const old = store.issueTokens({ clientId: "client", scopes: ["workspace.read", "offline_access"], resource, allowedRoots: [a] });
    expect(store.refresh(old.refreshToken!, "client", "https://wrong.example/mcp").ok).toBe(false);
    const loaded = new AuthStore("grant-persistence");
    const rotated = loaded.refresh(old.refreshToken!, "client", resource);
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      const checked = loaded.verifyAccessToken(rotated.tokens.accessToken);
      expect(checked.ok && checked.record.allowedRoots).toEqual([a]);
      expect(checked.ok && checked.record.resource).toBe(resource);
    }
    expect(loaded.refresh(old.refreshToken!, "client", resource).ok).toBe(false);
    const legacy = store.issueTokens({ clientId: "legacy", scopes: ["workspace.read", "offline_access"] });
    const refreshed = store.refresh(legacy.refreshToken!, "legacy");
    expect(refreshed.ok && store.verifyAccessToken(refreshed.tokens.accessToken)).toMatchObject({ ok: true, record: { workspaceId: "grant-persistence" } });
  });
  it("retains legacy selector defaults and prevents legacy workspace widening", () => {
    const ws = new Workspace(a), router = new WorkspaceRouter(ws);
    expect(router.resolve(undefined).id).toBe(ws.id);
    expect(() => router.resolve(b)).toThrow("original workspace");
  });
});

describe("isolated run state", () => {
  it("uses pairing defaults without copying another chat or checkpoint", () => {
    const ws = new Workspace(a);
    writeSession(ws.id, mergeSession(null, { projectUrl: projectA, url: "https://chatgpt.com/c/old", taskId: "old", checkpoint: { protocolState: "DONE" } }));
    const first = createRun(ws, { runId: "preferences", session: { projectUrl: projectB } });
    const second = createRun(ws, { runId: "defaults" });
    expect(first.session.projectUrl).toBe(projectB); expect(second.session.projectUrl).toBe(projectA);
    expect(first.session.url).toBeUndefined(); expect(first.session.checkpoint).toBeUndefined();
    updateRunSession(first.runId, ws.id, mergeSession(first.session, { checkpoint: { protocolState: "EXECUTING" } }));
    expect(readRun(second.runId, ws.id).session.checkpoint).toBeUndefined();
    expect(readSession(ws.id)?.checkpoint?.protocolState).toBe("DONE");
  });
  it("rejects duplicate IDs, traversal, and cross-workspace run binding", () => {
    expect(() => createRun(new Workspace(b), { runId: "run-a" })).toThrow();
    expect(() => createRun(new Workspace(a), { runId: "../escape" })).toThrow("run_id");
    expect(() => readRun("run-a", new Workspace(b).id)).toThrow("different workspace");
  });
});
