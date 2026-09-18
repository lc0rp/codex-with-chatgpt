# Security Model

## Trust boundaries

1. **Connection grants and workspace containment** are separate boundaries.
   Legacy bridges and tokens stay scoped to one workspace. Shared-mode tokens
   carry consented canonical roots and an MCP resource audience. Each call must
   select a workspace inside both that grant and current server roots, then
   files must remain inside the selected workspace. A token for a different
   connection returns 403. The Project URL grants no filesystem access.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only service/version/status and the connection ID |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Cross-run reads | Shared execution tools require run_id and verify its workspace binding; outputs and histories have separate per-run storage. A run cannot be rebound to another folder. |
| Root-selector bypass | Every tool validates workspace_path; canonical symlinks and prefix siblings cannot escape approved roots. Ancestor sensitive/custom rules remain effective when selecting nested folders. |
| Prompt attempts to broaden access | Root grants are configured locally and explicitly consented through OAuth. Tool arguments, file contents, and web Project URLs cannot add roots. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` (the connection identity) and `client_id`. New OAuth grants
also bind the intended MCP resource; shared grants snapshot approved roots on
the consent page. Refresh rotation preserves roots, audience, and scopes.
Unsupported requested scopes fail rather than implicitly granting all scopes.
Resource-less legacy refresh tokens remain usable only on their legacy bridge.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.

## Shared-mode migration and revocation

Shared configuration and tokens are separate from legacy workspace state. Enabling
shared mode never imports or broadens legacy tokens. Changing roots requires
stopping the shared bridge; newly added roots require fresh authorization. Every
request intersects the token grant with current policy, so removed roots are
immediately unavailable on the restarted bridge even to old tokens. Restoring
a previously removed root can reactivate an unexpired old grant; revoke shared
tokens first when all access must require new consent.

`c2c unpair` in shared mode revokes the entire shared connection. Disabling shared
mode preserves its state, so disabling alone is not revocation. Local state and
run files remain owner-only. The local filesystem and the Codex harness are
trusted; a hostile same-user process that can change roots, state, or symlinks
concurrently is outside this read-only bridge's isolation guarantee.
