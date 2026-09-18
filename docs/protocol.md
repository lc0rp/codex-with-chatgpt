# C2C Agent Protocol

## Explicit routing in shared mode

The shared bridge has no current-workspace switch. Every control message carries
`WORKSPACE_PATH` (canonical absolute path), `RUN_ID`, and `PROJECT_URL` (or none
for long-chat). The same context survives INIT, PLAN, EXECUTED, review, and
HANDOFF. The examples below show these fields; legacy single-workspace clients
may omit them during migration.

Create the run locally with `c2c run create -w <path> --project-url <url> --json`.
Use the returned `runId` on every `c2c record` and active `c2c session get/set/clear`
command via `--run-id`. `sessions/<workspaceId>.json` supplies optional pairing
preferences; `runs/<runId>.json` owns the active chat and checkpoint. Never resume
from a workspace-wide latest record. A run ID cannot be rebound to another path.

ChatGPT first calls `workspace_info` with `workspace_path` and `run_id`, verifies
both canonical path and workspace identity, then preserves those selectors on
all subsequent calls. All nine tools require `workspace_path` in shared mode;
`test_status`, `execution_summary`, and `execution_output` also require `run_id`.
All successful results include `workspaceId`, `workspacePath`, `workspaceName`,
and the run ID when supplied. File paths remain relative to the selected folder.

The web Project URL controls browser navigation and run bookkeeping. It never
authorizes a filesystem path or changes the MCP connection. The same connector
supports several folders in one web Project or one folder in several Projects.
Missing or mismatched routing fails instead of falling back to another run.


Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session get -w <path> --run-id <run> --json` chooses the run's conversation
mode in shared mode. Legacy mode retains `c2c session --json`.

- **long-chat:** one conversation per run (per workspace in legacy mode). Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** the explicit or default ChatGPT Project selected for this run. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
WORKSPACE_PATH: /absolute/path/to/project
RUN_ID: <run-id>
PROJECT_URL: https://chatgpt.com/g/g-p-ID/project
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"{{connector_name}}" MCP connector.

WORKSPACE_PATH: {{canonical_workspace_path}}
RUN_ID: {{run_id}}
PROJECT_URL: {{project_url}}

Call workspace_info with workspace_path and run_id first. Verify its canonical
path and ID. Use these selectors on every subsequent call; never switch
workspace implicitly. Legacy single-workspace mode may omit selectors.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
   If execution_output lists a readable item for this iteration, list
   then read it. If status is restricted, ignore the body and review
   from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. Use the named connector and the routing context of this run. A shared
    web Project can contain multiple workspaces; never infer this run's path
    from another conversation or Project memory.
```

## Project instructions

Project settings store the connector name and routing rules. Each run supplies
its own workspace identity in the boot prompt. The Skill fills this template
without binding a shared Project to a single folder.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for Codex. Codex owns execution.
Connector: {{connector_name}}

Each run identifies WORKSPACE_PATH, RUN_ID, and PROJECT_URL in this chat.
Use that exact connector and pass workspace_path on every tool call. Pass
run_id on every execution tool and on other calls when provided. First call
workspace_info with this context and verify workspacePath and workspaceId.
Stop if the context is missing, unauthorized, or mismatched. Never infer a
folder or run from another chat, a display name, or this Project's memory.
A legacy single-workspace connector may omit selectors after identity checks.

Read code, git, diffs, and released command output through the connector.
Never ask for pasted files, diffs, or logs. After EXECUTED, call
execution_output for this workspace/run (list, then read a readable item);
if restricted, review from git. Never upload the repository as Project sources.

Trust current code first, this run's HANDOFF second, and workspace-scoped
Project notes last. This Project may contain several local workspaces; notes
from one workspace must not become evidence about another. Preserve routing
fields on replies and HANDOFF, then re-read current code before resuming.
Give file-level rationale, changes, tests, and success criteria in C2C messages.
```
