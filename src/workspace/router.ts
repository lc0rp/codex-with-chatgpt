import fs from "node:fs";
import path from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Workspace, WorkspaceError } from "./manager.js";
import { IgnoreRules } from "./ignore.js";

/** Compare canonical paths at directory boundaries, never by a raw prefix. */
export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function canonicalDirectory(input: string): string {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new WorkspaceError("INVALID_PATH", "workspace_path must be an absolute directory path.");
  }
  let real: string;
  try { real = fs.realpathSync.native(input); }
  catch { throw new WorkspaceError("FILE_NOT_FOUND", "The requested workspace directory does not exist."); }
  if (!fs.statSync(real).isDirectory()) {
    throw new WorkspaceError("NOT_A_DIRECTORY", "workspace_path must select a directory.");
  }
  return real;
}

export function canonicalRoots(roots: readonly string[]): string[] {
  if (roots.length === 0) throw new Error("Shared mode requires at least one explicitly approved root.");
  return [...new Set(roots.map(canonicalDirectory))].sort();
}

/** Immutable connection policy. Each call resolves its own workspace; no active-workspace switch. */
export class WorkspaceRouter {
  readonly allowedRoots?: readonly string[];
  constructor(readonly workspace: Workspace, roots?: readonly string[]) {
    this.allowedRoots = roots === undefined ? undefined : canonicalRoots(roots);
  }

  get multiWorkspace(): boolean { return this.allowedRoots !== undefined; }

  resolve(workspacePath: string | undefined, authInfo?: AuthInfo): Workspace {
    if (!workspacePath && !this.multiWorkspace) return this.workspace;
    if (!workspacePath) throw new WorkspaceError("WORKSPACE_REQUIRED", "Shared mode requires workspace_path on every tool call.");
    const real = canonicalDirectory(workspacePath);
    if (!this.allowedRoots) {
      if (real !== this.workspace.root) throw new WorkspaceError("WORKSPACE_NOT_AUTHORIZED", "This connection is limited to its original workspace.");
      return new Workspace(real);
    }
    const roots = this.allowedRoots.filter((root) => containsPath(root, real));
    const granted = authInfo?.extra?.allowedRoots;
    if (roots.length === 0 || (authInfo && (!Array.isArray(granted) || !granted.some((root: unknown) => typeof root === "string" && containsPath(root, real))))) {
      throw new WorkspaceError("WORKSPACE_NOT_AUTHORIZED", "The requested workspace is outside this connection's approved roots.");
    }
    // Selecting a nested root must not evade an ancestor's sensitive/custom policy.
    const ancestors = new Set<string>();
    for (const root of roots) {
      let parent = root;
      for (const part of path.relative(root, real).split(path.sep).filter(Boolean)) {
        ancestors.add(parent);
        if (new IgnoreRules(parent).isSensitive(`${path.relative(parent, real).split(path.sep).join("/")}/`) || part === ".git") {
          throw new WorkspaceError("ACCESS_DENIED_SENSITIVE_FILE", "This directory is excluded by the workspace policy.");
        }
        parent = path.join(parent, part);
      }
    }
    return new Workspace(real, { ancestorPolicyRoots: [...ancestors] });
  }
}
