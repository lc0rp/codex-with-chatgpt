import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configureSharedConnection } from "../src/config/connection.js";
import { findLiveBridge } from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const execute = promisify(execFile);
let root: string, a: string, b: string, state: string;
async function cli(...args: string[]): Promise<string> {
  return (await execute(process.execPath, ["--import", "tsx/esm", "src/cli/index.ts", ...args], {
    cwd: process.cwd(), env: { ...process.env, C2C_STATE_DIR: state, CODEX_HOME: path.join(state, "codex") }, timeout: 30_000,
  })).stdout.trim();
}
beforeAll(() => {
  state = isolateStateDir(); root = makeTmpDir("shared-daemon");
  a = path.join(root, "a"); b = path.join(root, "b");
  write(a, "hello.txt", "a"); write(b, "hello.txt", "b");
  configureSharedConnection([root]);
});
afterAll(async () => {
  if (await findLiveBridge("shared")) await cli("stop", "-w", b);
  const deadline = Date.now() + 3000;
  while (fs.existsSync(path.join(state, "runtime/shared.json")) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  cleanup(root); cleanup(state);
});
it("starts exactly one detached shared daemon from simultaneous independent CLI processes", async () => {
  const [one, two] = await Promise.all([cli("start", "-w", a, "--json"), cli("start", "-w", b, "--json")]);
  const first = JSON.parse(one), second = JSON.parse(two);
  expect(first.ok).toBe(true); expect(second.ok).toBe(true);
  expect(first.workspaceId).toBe("shared"); expect(second.workspaceId).toBe("shared");
  expect(first.port).toBe(second.port);
  const runtime = await findLiveBridge("shared");
  expect(runtime?.pid).not.toBe(process.pid);
  expect(runtime?.allowedRoots).toEqual([root]);
  expect(fs.readdirSync(path.join(state, "runtime"))).toEqual(["shared.json"]);
  expect(fs.readdirSync(path.join(state, "locks"))).toEqual([]);
}, 30_000);
