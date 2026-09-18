import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ensureBridge } from "../src/process/daemon.js";
import { configureSharedConnection, connectionForWorkspace, readSharedConnection } from "../src/config/connection.js";
import { Workspace } from "../src/workspace/manager.js";
import { readRun } from "../src/session/runs.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { readSession, writeSession } from "../src/session/state.js";
import { cleanup, makeTmpDir, isolateStateDir, write } from "./helpers.js";

const execute = promisify(execFile);
const project = "https://chatgpt.com/g/g-p-ONE/project";
const project2 = "https://chatgpt.com/g/g-p-TWO/project";
let root: string, a: string, b: string, state: string, bridge: Bridge;
async function cli(...args: string[]): Promise<string> {
  const result = await execute(process.execPath, ["--import", "tsx/esm", "src/cli/index.ts", ...args], {
    cwd: process.cwd(), env: { ...process.env, C2C_STATE_DIR: state, CODEX_HOME: path.join(state, "codex") }, timeout: 15_000,
  });
  return result.stdout.trim();
}
const json = async (...args: string[]): Promise<any> => JSON.parse(await cli(...args));

beforeAll(async () => {
  state = isolateStateDir(); root = makeTmpDir("shared-cli");
  a = path.join(root, "a"); b = path.join(root, "b");
  write(a, "hello.txt", "a"); write(b, "hello.txt", "b");
  configureSharedConnection([root]);
  bridge = await startBridge({ workspaceRoot: a, allowedRoots: [root], port: 0 });
});
afterAll(async () => { await bridge.close(); cleanup(root); cleanup(state); });

describe("shared CLI lifecycle", () => {
  it("reuses one bridge for concurrent starts in two folders", async () => {
    const results = await Promise.all([ensureBridge(a), ensureBridge(b), ensureBridge(a)]);
    expect(results.every(r => !r.spawned && r.runtime.port === bridge.port && r.runtime.workspaceId === "shared")).toBe(true);
    expect(fs.readdirSync(path.join(state, "runtime"))).toEqual(["shared.json"]);
  });
  it("setup, status, doctor, and tunnel choice use the shared connection", async () => {
    const [one, two] = await Promise.all([
      json("setup", "-w", a, "--no-tunnel", "--json"),
      json("setup", "-w", b, "--no-tunnel", "--json"),
    ]);
    expect(one.workspaceId).toBe("shared"); expect(two.workspaceId).toBe("shared");
    expect(one.connectorName).toBe(two.connectorName);
    expect(one.connectorName).toContain("Shared");
    const status = await json("status", "-w", b, "--json");
    expect(JSON.stringify(status)).toContain('"shared"');
    const doctor = await json("doctor", "-w", b, "--no-fix", "--json");
    expect(doctor.chatgptRepair.connectorName).toBe(one.connectorName);
    expect(doctor.report.bridge.detail).toContain(String(bridge.port));
    await cli("tunnel", "choose", "--mode", "quick", "-w", a, "--json");
    expect((await json("tunnel", "status", "-w", b, "--json")).preference).toBe("quick");
    expect(fs.readdirSync(path.join(state, "tunnels"))).toEqual(["shared.json"]);
  });
  it("does not silently change active access policy", async () => {
    await expect(cli("connection", "configure", "--allow-root", a, "--json")).rejects.toThrow();
    await expect(cli("connection", "disable", "--json")).rejects.toThrow();
    expect((await json("connection", "configure", "--allow-root", root, "--json")).allowedRoots).toEqual([root]);
    expect(readSharedConnection()?.allowedRoots).toEqual([root]);
  });
});

describe("run-aware CLI", () => {
  it("creates independent pairings and records, with explicit routing overriding defaults", async () => {
    const workspace = new Workspace(a);
    writeSession(workspace.id, { conversationMode: "project", projectUrl: project, url: "https://chatgpt.com/c/old", savedAt: new Date().toISOString() });
    await json("run", "create", "-w", a, "--run-id", "cli-one", "--project-url", project2, "--json");
    await json("run", "create", "-w", a, "--run-id", "cli-two", "--json");
    const second = await json("run", "get", "-w", a, "--run-id", "cli-two", "--json");
    expect(second.session.projectUrl).toBe(project); expect(second.session.url).toBeUndefined();
    await cli("session", "set", "-w", a, "--run-id", "cli-one", "--url", "https://chatgpt.com/c/one", "--protocol-state", "EXECUTED_SENT", "--waiting-for", "GPT_REVIEW");
    await cli("record", "-w", a, "--run-id", "cli-one", "--task", "task-one", "--iteration", "1", "--tests", "one passed", "--command", "npm test", "--output", "one passed", "--exit-code", "0");
    await cli("record", "-w", a, "--run-id", "cli-two", "--task", "task-two", "--iteration", "1", "--tests", "two passed");
    expect(readExecutionRecords(workspace.id, 10, "cli-one")[0].tests).toBe("one passed");
    expect(readExecutionRecords(workspace.id, 10, "cli-two")[0].tests).toBe("two passed");
    expect(readSession(workspace.id)?.url).toBe("https://chatgpt.com/c/old");
    await cli("session", "set", "-w", a, "--run-id", "cli-one", "--project-url", project);
    expect(readRun("cli-one", workspace.id).session.checkpoint?.projectUrl).toBe(project);
    await cli("session", "clear", "-w", a, "--run-id", "cli-one");
    expect(readRun("cli-one", workspace.id).session.checkpoint?.chatUrl).toBeUndefined();
    expect((await json("session", "get", "-w", a, "--run-id", "cli-two", "--json")).session.checkpoint).toBeUndefined();
  });
  it("requires a run for shared execution and active state, and rejects mismatched workspaces", async () => {
    await expect(cli("record", "-w", a, "--task", "oops", "--iteration", "1")).rejects.toThrow();
    await expect(cli("session", "set", "-w", a, "--state", "EXECUTED")).rejects.toThrow();
    await expect(cli("session", "set", "-w", a, "--iteration", "2")).rejects.toThrow();
    await expect(cli("run", "get", "-w", b, "--run-id", "cli-one")).rejects.toThrow();
    await expect(cli("record", "-w", b, "--run-id", "cli-one", "--task", "oops", "--iteration", "1")).rejects.toThrow();
    // Optional pairing defaults remain editable without selecting a run.
    await cli("session", "set", "-w", a, "--project-url", project2);
    expect(readSession(new Workspace(a).id)?.projectUrl).toBe(project2);
  });
  it("preserves migration state, supports disabling, and fails closed on corrupt config", async () => {
    const before = readSession(new Workspace(a).id);
    await bridge.close();
    expect((await json("connection", "disable", "--json")).mode).toBe("single");
    expect(connectionForWorkspace(a).id).toBe(new Workspace(a).id);
    expect(readSession(new Workspace(a).id)).toEqual(before);
    expect(fs.existsSync(path.join(state, "runs", "cli-one.json"))).toBe(true);
    const config = await json("connection", "configure", "--allow-root", a, b, "--json");
    expect(config.allowedRoots).toEqual([a, b]);
    fs.writeFileSync(path.join(state, "connection.json"), "{bad");
    await expect(cli("connection", "get", "--json")).rejects.toThrow();
    expect(() => connectionForWorkspace(a)).toThrow();
  });
});
