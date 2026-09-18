# One connector, multiple local projects

Shared mode is an explicit opt-in. Without `connection.json`, the existing
single-workspace bridge, tokens, session defaults, and tool calls keep working.
No legacy token is imported into, or upgraded by, the shared connection.

## Enable once

Approve only the parent directories that should be readable, including their
subdirectories. Use absolute paths. The examples use placeholder paths.

```bash
c2c connection configure --allow-root /absolute/path/to/projects --json
c2c tunnel choose -w /absolute/path/to/projects/app-a --mode quick --json
c2c setup -w /absolute/path/to/projects/app-a --json
```

For several separate roots:

```bash
c2c connection configure --allow-root /absolute/projects /another/worktree-root
```

Configure the single connector returned by setup, normally
`Codex with ChatGPT · Shared`, with its `mcpUrl`. Complete the pairing flow and
review the approved roots shown on the consent page. All the existing setup and
named-tunnel workflows remain available; they now use shared state. A named
hostname can keep the endpoint stable across bridge restarts. A Quick Tunnel
retains its normal restart behavior, but changing folders never restarts it.

Stop an existing shared bridge before changing approved roots:

```bash
c2c stop -w /absolute/path/to/projects/app-a
c2c connection configure --allow-root /absolute/path/to/projects /another/root
c2c setup -w /absolute/path/to/projects/app-a --json
```

Reauthorize the connector to grant any newly approved roots. Refreshing an old
token preserves its original roots and scopes. Removed roots stop being usable
because every call also checks the current server policy. Removing a root and
later restoring it allows an unexpired old grant for that root again; use
`c2c unpair` before restoring access when fresh consent is required for everyone.
`c2c unpair` revokes the **entire shared connection**, not one selected project.

## Start an isolated run

Provide the local folder and the desired ChatGPT Project in the task:

```text
Use Codex with ChatGPT.
Local workspace: /absolute/path/to/projects/app-a
ChatGPT Project: https://chatgpt.com/g/g-p-EXAMPLE/project
Task: Review and implement the next change.
```

The updated Codex skill creates and retains the run context. Equivalent CLI:

```bash
c2c run create -w /absolute/path/to/projects/app-a \
  --project-url https://chatgpt.com/g/g-p-EXAMPLE/project --json
```

The response includes a unique `runId`, canonical `workspacePath`, `workspaceId`,
and the run's session. `--run-id` can specify a caller-generated unique ID;
`--codex-thread-id` optionally records the harness thread. IDs permit 1–128
letters, digits, underscores, or hyphens, beginning with a letter or digit.
Existing IDs cannot be overwritten or reassigned.

Explicit Project URL/mode arguments override the workspace's saved preferences.
New runs inherit no previous chat URL, task checkpoint, or execution history.
When no Project URL is supplied or saved, the skill follows its existing Project
selection workflow. `--mode long-chat` is also supported.

```bash
c2c session set -w /absolute/path/to/projects/app-a --run-id RUN_ID \
  --url https://chatgpt.com/c/CHAT_ID --protocol-state INIT --waiting-for GPT_PLAN
c2c record -w /absolute/path/to/projects/app-a --run-id RUN_ID \
  --task task-1 --iteration 1 --tests '27 passed' --exit-status ok
c2c session get -w /absolute/path/to/projects/app-a --run-id RUN_ID --json
c2c run get -w /absolute/path/to/projects/app-a --run-id RUN_ID --json
```

Use the same run ID through INIT, EXECUTED, review, and HANDOFF. A new Codex
thread creates a new run unless explicitly resuming the known run. Updating one
run's Project/chat leaves the other runs and the shared connection unchanged.
Workspace-level `session set --mode/--project-url/--connector-name` remains
available to save optional defaults; active state requires `--run-id` in shared
mode. Multiple writers to the **same run** still need harness coordination.

## MCP calls

```json
{"workspace_path":"/absolute/path/to/projects/app-a","run_id":"RUN_ID"}
```

Call `workspace_info` with that context first. All nine tools require
`workspace_path` in shared mode. `run_id` is required for `test_status`,
`execution_summary`, and `execution_output`, and accepted on every tool.

```json
{"workspace_path":"/absolute/path/to/projects/app-a","run_id":"RUN_ID","path":"src/main.ts"}
```

This `read_file` call reads `src/main.ts` inside that selected workspace.
Every successful result includes `workspaceId`, `workspacePath`, `workspaceName`,
and `runId` when provided. Verify these identities after a handoff or connector
repair. Git tools operate on the selected folder, and ordinary non-Git folders
return `isRepo: false` rather than failing workspace selection.

The server resolves canonical paths on every call, checks both current roots
and the token's consented roots, and preserves file containment and sensitive
rules. Selecting a nested folder cannot bypass ancestor `.c2cignore` exclusions.
Symlink escapes, unauthorized roots, missing selectors, and mismatched run IDs
fail explicitly. No process-wide current workspace exists.

## State and migration

All paths below are under the existing OS app state directory or `C2C_STATE_DIR`.
State remains owner-only. The `.c2c.json` project format is unchanged.

| Path | Purpose |
| --- | --- |
| `connection.json` | Versioned approved roots; presence enables shared mode |
| `runtime/shared.json` | One bridge process, mode, roots, endpoint, local admin token |
| `auth/shared.json` | Shared clients and hashed tokens, audience, scopes, consented roots |
| `endpoints/shared.json` | Shared connector name and last public endpoint |
| `tunnels/shared.json` | Shared Quick/Named tunnel settings |
| `sessions/<workspaceId>.json` | Optional pairing defaults; legacy active state retained |
| `runs/<runId>.json` | Workspace identity, optional thread ID, Project/chat and checkpoint |
| `executions/<workspaceId>/<runId>.jsonl` | Isolated execution records |
| `execution-outputs/<workspaceId>/runs/<runId>/` | Isolated sanitized output and index |
| `locks/<connectionId>.lock` | Serializes local bridge startup/configuration changes |

Legacy workspace-keyed runtime/auth/endpoint/tunnel files, execution JSONL, and
output directories are preserved. Do not retire old connectors until validating
two workspace/Project pairs through the shared one.

Rollback after stopping the shared bridge:

```bash
c2c connection disable --json
c2c setup -w /absolute/path/to/projects/app-a --json
```

Disabling shared mode preserves its grants and run files; use `c2c unpair` while
shared mode is active to revoke them first. Legacy setup then resumes its own
workspace-specific connection. A malformed shared config fails closed.

After a process crash, a stale startup lock intentionally blocks a new daemon.
Confirm no startup/configuration process is active before removing the named
lock file reported by the CLI. Locks are not automatically removed based on a
PID probe because concurrent recovery could otherwise remove another process's
new lock.

## Validation

Automated tests cover two workspaces and two web Project URLs, interleaved MCP
calls with identical filenames, all nine tool schemas, Git/non-Git selection,
run isolation, OAuth consent/PKCE/refresh/audience/scope checks, legacy tokens,
root and symlink restrictions, ancestor ignores, shared setup/doctor/tunnel
state, migration, and CLI execution/checkpoints. Browser navigation and a live
Cloudflare/ChatGPT connector still require an authenticated smoke test in the
user's environment; Project URLs in automated tests are bookkeeping fixtures.
