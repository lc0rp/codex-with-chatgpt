> Implementation: opt-in shared mode is available. See
> [shared-workspace usage and migration](shared-workspaces.md) for the implemented
> CLI, routing contract, state paths, tests, and live-smoke-test limitations.
> The proposal below is retained as the original design context.

Original question:

How does this project store the config? Right now it fixes the domain MCP to one local folder/project, and one ChatGPT web project. This means I have to create multiple instances of the plug in. One for each project that I want to use codex-with-chatgpt. I'd like to update it so that one plugin can be used for any local folder - chatgpt web project pairs, with the prompts & instructions specifying the local path and the remote project, rather than that being a plugin/mcp restriction.

First verify the behavior I have observed and then propose fixes.

Answer:

**Your observation is substantially correct. The local-folder restriction is enforced in the bridge and OAuth code. The ChatGPT web Project pairing is stored session state, reinforced by the Codex skill.** The clean fix is one shared bridge and plugin, with the target workspace supplied on each tool call and the ChatGPT Project selected by the browser workflow.

I inspected your `lc0rp/codex-with-chatgpt` fork and successfully queried the live “Codex with ChatGPT · projects” connector. The main connector returned an authentication error, so I could not compare its running configuration or any uncommitted local changes.

## 1. What I verified

### The MCP server is fixed to one local workspace

In `src/bridge/server.ts`, startup constructs one `Workspace` from `opts.workspaceRoot`. That same workspace is passed to the MCP server, authentication store, pairing manager, and tunnel selection. The daemon also starts with a specific `serve --workspace <path>` argument. This makes the workspace a property of the running bridge.  

The exposed tools reflect that design:

```
workspace_info()
read_file(path, start_line?, end_line?)
git_status()
test_status()
```

There is no tool argument for selecting another workspace. `path` resolves inside the workspace chosen at startup; the filesystem layer checks canonical paths and rejects escapes outside that root. Supplying an absolute path to another project does not change the connected workspace.  

**Authentication independently enforces the restriction.** Token records contain a `workspaceId`, and the middleware returns HTTP 403 when it differs from the bridge’s workspace ID. Adding a workspace argument to the tools alone would therefore be insufficient.  

### The project creates distinct connectors deliberately

`src/config/endpoint.ts` stores endpoint information per workspace and generates connector names such as:

```
Codex with ChatGPT · projects
```

The skill explicitly instructs Codex to maintain one connector per workspace and leave other workspaces’ connectors unchanged. Your multiple-instance experience follows the intended implementation.  

### The ChatGPT Project binding is a changeable preference

`src/session/state.ts` stores one session record per workspace, containing `projectUrl`, conversation mode, chat URL, connector name, and task checkpoint. The skill then directs Codex to use one ChatGPT Project per workspace.  

The CLI already supports changing that preference:

```
c2c session set \
  --workspace "/absolute/path/to/project" \
  --mode project \
  --project-url "https://chatgpt.com/g/g-p-PROJECTID/project"
```

That overwrites the workspace’s saved pairing. It does not require changing the MCP server’s filesystem scope. I found no ChatGPT web Project ID check in the bridge/MCP authorization path.  

**So the correction to your diagnosis is:** the implementation requires separate connectors for separately scoped local workspaces; the web Project association is a workflow convention and saved default.

## 2. Where configuration is stored

On macOS, the default state directory is:

```
~/Library/Application Support/codex-with-chatgpt/
```

`C2C_STATE_DIR` can override it. The JSON-writing helper uses owner-only file permissions. 

| File relative to the state directory | What it stores                                               |
| ------------------------------------ | ------------------------------------------------------------ |
| `prefs.json`                         | Machine-wide preferences, including remembered developer mode and automatic/manual setup. |
| `runtime/<workspaceId>.json`         | Workspace root, process ID, port, public URL, startup time, and local admin token. |
| `endpoints/<workspaceId>.json`       | Last public/MCP URLs, port, and connector name.              |
| `tunnels/<workspaceId>.json`         | Quick/named tunnel preference, hostname, tunnel identifiers, and setup state. |
| `auth/<workspaceId>.json`            | OAuth client registrations and hashed token records, including workspace IDs and scopes. |
| `sessions/<workspaceId>.json`        | ChatGPT Project URL, chat URL, conversation mode, connector name, and checkpoint. |
| `executions/<workspaceId>.jsonl`     | Codex execution records used by review and test-status tools. |

Inside each local project, `.c2c.json` currently accepts only `name` and `maxIterations`. The `workspaceId` is derived from the canonical filesystem path using a truncated SHA-256 hash. Moving a folder therefore changes its identity under this implementation. 

**There is no single config setting that turns the existing implementation into a multi-workspace server.** Workspace identity is embedded in process management, authentication, endpoint management, tool handlers, and session storage.

## 3. Recommended fix: one shared bridge, explicit per-call routing

I would separate the implementation into three concerns:

| Concern                        | Proposed responsibility                                      |
| ------------------------------ | ------------------------------------------------------------ |
| **Connection and permissions** | One plugin, stable MCP endpoint, bridge process, and authorization grant covering approved filesystem locations. |
| **Workspace selection**        | Every workspace tool call explicitly identifies the local folder. |
| **Conversation workflow**      | Each run identifies its ChatGPT Project and chat, independently of the plugin connection. |

OpenAI’s MCP interface supports explicit tool input schemas and server-side authorization handlers, so this can be implemented within the normal plugin model. [OpenAI Developers](https://developers.openai.com/apps-sdk/build/mcp-server)

### A. Add a workspace selector to every workspace tool

For a first implementation, I would use a required `workspace_path`. It directly matches how you want to instruct the system and avoids requiring a separate project registry.

**Proposed interface:**

```
workspace_info({
  workspace_path: "/absolute/path/to/KeepSidian"
})

read_file({
  workspace_path: "/absolute/path/to/KeepSidian",
  path: "src/main.ts"
})

git_status({
  workspace_path: "/absolute/path/to/KeepSidian"
})

test_status({
  workspace_path: "/absolute/path/to/KeepSidian",
  run_id: "run-123"
})
```

The bridge would resolve and authorize the requested folder, construct or retrieve its `Workspace`, and invoke the existing operation against that object.

Apply this to **all nine tools**, including execution history and output retrieval. Each result should identify the workspace it actually used, so a mistaken selection is visible.

**Do not introduce a process-wide `set_current_workspace()` switch.** Two chats could interleave their requests and read from each other’s selected folders. Required per-call selection avoids that race. It also fits the existing stateless HTTP transport, which creates a fresh MCP server and transport per POST. 

For the new multi-workspace mode, missing workspace selection should produce a clear error rather than falling back to whichever folder was used most recently.

### B. Authorize access to approved folders independently of project pairing

The prompt should select the workspace. The server should determine whether that workspace is permitted.

For your use case, a practical policy would authorize one or more parent directories, such as your actual projects directory. Any folder beneath those roots could then be selected without installing another plugin or registering each local/remote pair.

The resolver should perform two separate checks:

1. The canonical requested workspace is within the authenticated connection’s approved roots.
2. The requested file is within that selected workspace and passes its sensitive-file and ignore rules.

This preserves project-level containment while allowing arbitrary project selection. A path supplied in a prompt must never grant itself access.

The OAuth change is consequently broader than deleting the existing workspace-ID comparison. I would replace the single-workspace authorization model with a grant containing the permitted roots or explicit workspace set, while retaining operation scopes and validating the token’s intended MCP resource. OpenAI’s authorization documentation requires resource/audience and scope validation on requests. [OpenAI Developers](https://developers.openai.com/apps-sdk/build/auth)

**Existing single-workspace tokens should retain their original access until you explicitly approve broader access.**

### C. Move the local-folder/web-Project pair into the run context

The Codex skill should accept both values from the current task, for example:

```
Use Codex with ChatGPT.

Local workspace: /absolute/path/to/KeepSidian
ChatGPT Project: https://chatgpt.com/g/g-p-PROJECTID/project
Task: Review the sync implementation and propose the next change.
```

It would then:

- Open or verify the requested ChatGPT Project through the existing browser workflow.
- Send the local workspace path and a unique run ID in the initial coordination message.
- Require ChatGPT to call `workspace_info` with that path before planning or reviewing.

The same routing context should survive subsequent execution reports and handoffs.

**The filesystem tools do not need the ChatGPT Project URL on every call.** That URL belongs to browser navigation and run bookkeeping. It also should not be treated as proof that a request originated from that web Project.

Saved pairings can remain as optional defaults, with explicit task parameters taking precedence. This would support all of these without connector changes: different local folders with different web Projects, one folder used with several web Projects, and one web Project used for several local folders.

### D. Separate persistent defaults from active run state

This is an important adjacent fix.

Currently, one workspace has one saved session/checkpoint file. Execution records include task IDs, but `latestExecutionRecord(workspaceId)` retrieves the latest record for the whole workspace. Concurrent tasks could therefore overwrite shared checkpoint state or expose another task’s latest test result. This is a risk inferred from the storage and lookup code, rather than a collision I reproduced.  

I would use:

```
Global connection state:
  bridge runtime, endpoint, tunnel, OAuth clients and grants

Optional workspace preferences:
  display name, preferred ChatGPT Project

Per-run state:
  run ID
  workspace ID and canonical path
  ChatGPT Project URL and chat URL
  Codex thread identity, where available
  checkpoint and execution records
```

A simple `runs/<runId>.json` can hold the active context. Execution tools should filter by both workspace and run, and reject a run ID associated with a different workspace.

That removes the implicit one-folder/one-active-conversation assumption.

### E. Make connection setup machine-wide

Once the shared bridge exists, `setup`, `doctor`, tunnel repair, and endpoint persistence should operate on the shared connection.

Selecting a new project should reuse the same plugin and endpoint. It should neither launch another public tunnel nor trigger connector creation.

The current behavior is rooted in `ensureBridge(workspaceRoot)`, workspace-keyed runtime discovery, and workspace-keyed endpoint/tunnel files, so those components must change together.   

## 4. Alternatives and shortcuts

| Approach                                                     | Assessment                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Shared bridge with per-call workspace selection**          | **Recommended.** One public connection, reuse of existing workspace operations, and explicit routing. |
| **One gateway in front of existing per-workspace bridges**   | Viable transitional design. Preserves more existing code, but retains multiple internal processes and requires careful authentication between gateway and workers. |
| **Connect the existing bridge to a common parent directory** | Partial workaround for file reads. Git operations still target the parent workspace, execution records remain keyed to its identity, and the selected root’s project configuration governs the workspace. It would not provide correct per-project behavior across the full toolset. |
| **Change prompts only**                                      | Can change the saved web Project convention, but cannot override the enforced filesystem and token scope. |

## 5. Implementation scope and acceptance tests

I would implement this as an explicit **multi-workspace mode**, retaining the current single-workspace mode during migration.

The main changes would be:

| Area                                                         | Proposed change                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `src/bridge/server.ts`, `src/process/daemon.ts`, `src/bridge/runtime.ts` | Shared bridge lifecycle and workspace resolver.              |
| `src/auth/*`, pairing                                        | Connection-level grants and per-request workspace authorization. |
| `src/mcp/server.ts`                                          | Required workspace selection across every tool, plus workspace identity in results. |
| `src/config/endpoint.ts`, `src/tunnel/*`                     | Shared endpoint and tunnel identity.                         |
| `src/session/state.ts`, `src/execution/*`                    | Optional pairing defaults, isolated runs, run-scoped execution retrieval. |
| `src/cli/index.ts`, `skill/SKILL.md`                         | Explicit task routing, shared setup/repair, and removal of one-connector-per-workspace instructions. |

The acceptance tests should demonstrate that one connector handles two folders and two web Projects simultaneously; identical filenames return the correct contents; Git and execution tools use the selected workspace/run; changing the web Project leaves the connection untouched; missing selectors fail clearly; unauthorized roots and symlink escapes remain blocked; and ordinary non-Git folders work too.

For migration, preserve the existing state, explicitly approve the shared connection’s access, validate two project pairs end to end, and only then retire the duplicate connectors.

**My recommendation: keep the existing `Workspace` abstraction and its containment rules, make workspace selection explicit on every call, and move local/remote pairing into isolated run context.** That delivers the workflow you described without making plugin installation part of project setup.

No project files or configuration were changed.
