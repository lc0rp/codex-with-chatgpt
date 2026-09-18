import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, writeSecureJson } from "./paths.js";
import { Workspace } from "../workspace/manager.js";
import { canonicalRoots, WorkspaceRouter } from "../workspace/router.js";

export const SHARED_CONNECTION_ID = "shared";
const schema = z.object({ version: z.literal(1), allowedRoots: z.array(z.string()).min(1) });
export type SharedConnection = z.infer<typeof schema>;

function configFile(): string { return path.join(getStateDir(), "connection.json"); }

/** Missing configuration preserves legacy behavior; invalid configuration fails closed. */
export function readSharedConnection(): SharedConnection | null {
  if (!fs.existsSync(configFile())) return null;
  return schema.parse(JSON.parse(fs.readFileSync(configFile(), "utf8")));
}

export function configureSharedConnection(roots: string[]): SharedConnection {
  const config: SharedConnection = { version: 1, allowedRoots: canonicalRoots(roots) };
  writeSecureJson(configFile(), config);
  return config;
}

export function disableSharedConnection(): void { fs.rmSync(configFile(), { force: true }); }

export interface ConnectionIdentity {
  id: string;
  name: string;
  root: string;
  allowedRoots?: readonly string[];
}

/** Lifecycle and endpoint identity is machine-wide only after explicit opt-in. */
export function connectionForWorkspace(root: string): ConnectionIdentity {
  const workspace = new Workspace(root);
  const config = readSharedConnection();
  if (!config) return workspace;
  const router = new WorkspaceRouter(workspace, config.allowedRoots);
  router.resolve(workspace.root);
  return { id: SHARED_CONNECTION_ID, name: "Shared projects", root: workspace.root, allowedRoots: router.allowedRoots };
}
