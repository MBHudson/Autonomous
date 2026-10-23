# Changelog

All work in this session. UI changes shipped with a full `ui/` sync and the
`?v=` cache-buster bumped (v281 → **v303**, in `ui/js/store.js` → `APP_VERSION`).
PHP changes need only the usual file deploy.

---

## v303 — exec results + bare-tag tool calls

- **`exec` no longer reports `[exit undefined, undefinedms]`.** When the server
  answered with `{ error }`, a pending approval, or a partial body, the tool
  printed meaningless placeholders and the model retried the identical command
  (four identical `nmap` calls). `exec` now surfaces the real error, names a
  pending approval, and includes the raw result when the shape is unexpected.
- **Bare `<function=name><parameter=key>` tool calls are parsed.** Some
  Nemotron/Qwen templates emit that dialect instead of `<invoke name=...>` or
  `<|tool_call|>`; it leaked into the reply as text and was treated as the final
  answer. It now runs as a real tool call.

---

## v302 — routing/comms + sandbox fixes

- **Inter-agent asks work again during a normal turn.** `_busy` now holds every
  agent in the user fan-out (added in v300 to stop always-on duplicate replies),
  but `_askAgentSync` was still using it as its "already answering" guard, so
  every `ask_agent`/`tell_agent` to a sibling agent returned "already answering
  another agent right now". Nested asks use a separate `_nestedBusy` set;
  `_busy` still guards the always-on scheduler and direct asks.
- **Exec no longer starts outside the jail.** With configured roots that do not
  include the app folder (the normal deployed case), `execCommand()` defaulted
  its working directory to the app dir, so every relative argument looked like
  an escape and `cat local-IPs.txt` / `grep ... src` were refused with "outside
  the allowed directories". The default cwd is now the first allowed root, and a
  caller-supplied cwd may be a read-only root (writing is not required to run).
- **`list_dir` answers a file path.** Asking `list_dir` about a file returned
  "not a directory", which reads as "the file is missing"; it now returns that
  single entry.
- **Tool calls survive routing runs and reach the ghost transcript.** Routing
  node replies keep their `toolCalls`, and the routing screen's ghost transcript
  prints each tool call (name, argument preview, status, first line of result),
  live and after the turn finishes.

---

## v301 — visible tool calls

- **Tool calls are now real transcript entries.** Each call is a collapsible
  block in the message: tool name, a one-line argument preview, running/done/
  error/approval status, duration, and expandable arguments + result. Live turns
  paint the same blocks while they work, then the final message keeps them, so a
  tool request no longer appears as a bare `▸ running read_file…` line that
  vanishes or replaces the reply.
- Tool calls survive a reload: they are stored on the local conversation message
  and in session dialogs as `tool_calls`, and restored by both the chat loader
  and the sidebar's dialog conversion.
- Calls that are skipped because an agent declares its goal complete are marked
  as skipped rather than left spinning as "running" forever.

---

## v300 — direct-ask double reply + Windows exec

- **Ask button no longer answers twice.** `askAgentDirectly()` streamed into a
  live node and then appended the finished reply as a second message. It now
  swaps the live node for the final message (and preserves a partial answer when
  stopped), matching the main send path. It also marks the agent busy for the
  duration of the direct ask so an autonomous tick cannot start the same agent
  in parallel.
- **Exec works on Windows.** `Sandbox::execCommand()` now detects a Windows
  sandbox (including MSYS builds with Windows roots), resolves `.exe`/`.com`
  from PATH, System32 and Git for Windows (per-machine and per-user installs),
  and passes a Windows child environment (`SystemRoot`, `ComSpec`, `PATHEXT`).
  It no longer tries to run `.cmd`/`.bat` shims through a shell.
- **Windows builtins without cmd.exe.** `echo`, `pwd`, `type`, `where`, `dir`,
  `mkdir`, `sleep` and the common file/text tools (`cat`, `more`, `head`, `tail`,
  `wc`, `base64`, `md5sum`, `sha256sum`, `realpath`, `basename`, `dirname`,
  `uname`, `id`, `printenv`) are implemented in PHP when no `.exe` exists, so
  commands like `exec ["echo","hello"]` work instead of reporting the program
  is not installed. `dir`, `where`, `more`, `findstr`, `ipconfig` and `tasklist`
  were added to the default allowlist, and exec's prompt now explains the
  Windows rules.
- Expanded the sandbox tests with echo, metacharacter, pwd, type and dir cases.

---

## v299 — context assembler + native tool calling

- **Live-context compaction.** `utils.js` now estimates tokens for text, images
  and message lists, computes an input budget from the model window minus the
  output ask, and compacts old assistant/`TOOL_RESULT` exchanges before every
  request. Replayed history was already budgeted; the tool transcript was not.
- **Context-aware attached files.** `filesBlockFor()` caps agent reference files
  at half the model's input budget instead of a fixed 260k characters.
- **Plan re-injection.** The `todo_write` list is included in the system prompt
  and refreshed after each `todo_write`, so it survives compaction and later
  turns.
- **Native tool calling.** New `ui/js/nativeTools.js` supplies JSON schemas for
  every built-in tool and the OpenAI, Anthropic and Google tool-definition
  shapes. `api.js` accumulates native tool-call stream frames; `chat.js` executes
  native calls (including several per response) and falls back to the prompt
  protocol if a provider rejects tool schemas. `Harness::payload()` and
  `ModelManager::relayStream()` forward `tools`, `tool_choice` and `toolConfig`.
- Added `tests/js/nativeTools.test.mjs`; expanded context and harness tests.

---

## 1. Sandbox "location" couldn't be changed (the original bug)

**Fixed.** The Config tab's *Working Project Directory* field rejected any path
without a leading `/`, so on Windows no path could ever be saved and the sandbox
stayed pinned to the project root. The server's file jail had already been made
Windows-aware, so the fix was on the client: accept POSIX (`/var/www/site`) and
Windows (`C:\site`) absolute paths, normalising backslashes.
Files: `ui/js/components/sidebar.js`.

## 2. Cleanup

- Removed the stray duplicate tree `src/src/` (unused — the autoloader only
  reads `src/`) and the empty `assets/` folder.
- Removed the `Access-Control-Allow-Origin: *` wildcard that `public/.htaccess`
  had reintroduced (the root `.htaccess` had deliberately dropped it).

## 3. Installers

- **`start.bat` rewritten.** It broke whenever `php` was a full path with
  spaces (e.g. `C:\Program Files\PHP\…`): unquoted `%PHP%` and `for /f` captures
  mangled it. Now everything is quoted and output is captured via a temp file;
  it also checks for `serve.php` and says so clearly.
- **New one-click Windows setup: `setup-xampp.bat` → `setup-xampp.ps1`.**
  Downloads the latest XAMPP (from SourceForge's release API, with SHA-256
  verification), silently installs **Apache + PHP only** (no MySQL/Perl/etc.),
  links the folder into `htdocs\router`, points Apache at a free port, enables
  `.htaccess`, creates the access token, and opens the app. Idempotent; options
  `-Port`, `-XamppDir`, `-Repair`.

## 4. Harness registry — auto-fit models to the right API/tool dialect

- **`src/Harness.php`** (server) + **`ui/js/harness.js`** (client) are one
  registry that decides which **API dialect** a provider speaks (OpenAI-
  compatible, Anthropic Messages, Google, Ollama; plus Azure auth) from the
  endpoint host → provider id → model hint, and which **tool-call dialect** a
  model is taught from provider + model id.
- `ModelManager` now delegates detection, auth, request body, response/usage/
  reasoning parsing and streaming to it; the OpenAI-compatible clones
  (DeepSeek, xAI, Mistral, Cerebras, Groq, …) are classified correctly instead
  of falling down the old "custom" path. `capMaxTokens` clamps known output
  ceilings (e.g. Gemini 8k) so an over-large `max_tokens` can't 400.
- **Generated table:** `tools/gen-harness.php` writes `ui/js/harness.data.js`
  from `Harness.php` (families, aliases, host matchers, tool patterns, context
  limits, default RPM). `--check` fails when stale — wire it to a pre-commit
  hook so the two can't drift.

## 5. Throttle / limiter actually paces now

- The rate governor was wired but mis-configured: a flat 20/min (and any stored
  `rateLimitRpm`) overrode everything, so a NVIDIA NIM key never paced at its
  real **40/min**.
- Added per-host free-tier defaults (NVIDIA 40, Groq 30, OpenRouter 20, …,
  local unpaced) and a precedence chain: **agent lock → provider rpm → explicit
  global → host default**. Config → Pacing now reads **`0 = AUTO`**.
- The `git`-style `limitsFor()` shows the effective per-key rate on agent cards.

## 6. Agent-card metrics (uptime / requests / tokens)

- The clock only counted turns that returned a usage block, so most agents
  showed "no usage yet". Now **every turn counts a request**, billed calls are
  counted separately, and when a provider streams no usage the completion is
  **estimated from the reply** (shown with a `~`).
- New **token budget** (Config → Limits & Budgets, `0 = off`) and a per-agent
  override in Brain Lab; the card then shows `1.2m/8m (15%) · 34 req · up 2h · 40/min`.

---

## 7. New agent tools

Built to match the names/shapes models are actually trained on.

- **`str_replace_editor`** — Claude/SWE-agent dialect (`view`/`create`/
  `str_replace`/`insert`).
- **`edit_file`** — Cursor/Aider search-replace (`old_string`/`new_string`).
- **`apply_patch`** — Codex/GPT **V4A** patch: add / update / move / delete in
  one envelope. Every hunk must match its context exactly once, or the whole
  patch is refused.
- **`multi_edit`** — several edits in one call, **all-or-nothing**: every target
  is staged in memory and written only if all edits succeed.
- **`git`** — runs one git command, jailed and shell-free, with a subcommand
  allowlist and retargeting flags (`-c`, `--git-dir`, `--work-tree`, `--output`)
  refused. Read-only subcommands run without a prompt; writes ask.
- **`git_commit`** — stages the given paths (or everything) and commits; a
  default author identity is supplied so it works on a fresh host.
- **`http_request`** — real API calls (method, headers, body), SSRF-guarded.
- **`run_code`** — Python/Node/bash snippets in the sandbox. Off by default
  (Config → Permissions → *Code interpreter*); fresh process per call, but the
  working directory persists between calls.
- **`todo_write`** — a session task list; **`think`** — a private scratchpad.

## 8. MCP client

- **`src/Mcp.php`** speaks the Model Context Protocol over **stdio** (spawns
  the server; JSON-RPC handshake, `tools/list`, `tools/call`) and **HTTP**.
- API: `/mcp/servers`, `/mcp/status`, `/mcp/tools`, `/mcp/call`. Agents get
  **`mcp_list`** and **`mcp_call`**; a model can call MCP tools but can never
  add or change a server.
- **Config → MCP Client** section to add/remove servers (name, stdio/http,
  command+args or URL), Save, and it probes each server so a broken command
  shows up immediately. Servers are also editable under `mcp.servers` in
  `storage/config.json`.

## 9. Tracing / observability

- **`ui/js/trace.js`** — a bounded ring buffer of model turns and tool calls
  (time, agent, model/tool, ms, ok/error, tokens).
- Hooked at the two choke points (`runTool`, `_recordUsage`); **Config → TRACE**
  opens a "Run trace" viewer with totals and a newest-first table. Session-only
  by design.

## 10. Config sections start collapsed

- The Config tab (and Brain Lab) sections are now **collapsed by default** and
  the open/closed state is **session-only**: open one and it stays open while
  you work, reload and everything is closed. The old localStorage persistence
  was removed.

---

## 11. MCP server — this app as a server friends can connect to

- **The mirror of the MCP client.** `src/McpServer.php` speaks JSON-RPC 2.0
  over HTTP at **`POST /api/mcp-server`**, so another machine's MCP client
  (a friend's local model, Claude Desktop, Cursor) can call tools that run
  **here**. `initialize` / `tools/list` / `tools/call` / `ping` are implemented.
- **Per-friend tokens with scopes.** Config → **MCP Server** section: enable,
  set a scratch folder, edit the protected-path list, and add a token per
  friend with **read / write / exec** checkboxes, an optional IP allowlist, and
  a one-click revoke. The RPC route authenticates with `Authorization: Bearer`
  (the web-token gate leaves that one path alone); the config route stays
  behind the web token.
- **Scope is a ceiling, Sandbox is the floor.** A token only decides *which*
  tool it may reach; the call still runs through every control you already
  have — `exec_enabled`, `exec_allow`/`exec_deny`, interpreter levels, the file
  jail, `code_enabled`, and the approval queue. An un-allowed command from a
  friend lands in **your** Pending-approvals list and their call returns
  "waiting for the operator".
- **Protected paths.** A default-filled, fully editable deny-list (`storage/`,
  `.git`, `.env*`, `*.pem`, `*.key`, dotfiles…) enforced in `Sandbox::jail()`,
  so even if the root is the app tree, the access token and provider keys
  cannot be read. Clear the list to turn protection off — nothing is permanent.
- **Scratch root.** Friends work in their own folder (`mcp_server.root`); a
  deny-all `.htaccess` is dropped in it so files they write are never served
  over the web.
- **The MCP client got headers.** `Config → MCP Client` now round-trips
  `command`/`args`/`url` and adds a **headers** box, so a friend who also runs
  a copy can add your server with `Authorization: Bearer …` and use your tools
  through `mcp_list` / `mcp_call`.
- **`FRIENDS.md`** — a one-page "hand this to your friend" connect guide
  (remote HTTP, the `mcp-remote` stdio bridge, or their own copy).
- **Audit:** every call appends one line to `storage/mcp.log`.

---

## 12. "No one has memory" — three fixes

- **Tool calls were being narrated, not sent.** With the global pre-prompt
  armed ("reply with ONLY text … OR 9 words"), models said *"I'll use the
  remember tool"* and emitted no call, so nothing saved. The tool instructions
  now state plainly that a tool call is the **one exception** to any brevity /
  "text only" rule, and the tool loop adds a **narration rescue**: if a reply
  claims it will use a tool but contains no call, it is re-prompted once to
  actually send it.
- **A sync can no longer drop local notes.** `stateSync` now **unions** the
  server's memory with the browser's by id instead of replacing it, so a note
  that exists only in your browser is never silently wiped by an incoming sync.
- **A SAVE can no longer zero memory.** The Config SAVE computed
  `parseInt(field) || 0`, so a missing/blank *Memory (past messages)* field
  turned conversation memory OFF for every agent. It now keeps the current
  value when the field is absent or blank.

---

## Tests

Run from the repo root (PHP 7.4+; Node only for the JS one):

| Command | Covers |
| --- | --- |
| `php tests/php/sandbox.test.php` | file jail, editors, `apply_patch`, `multi_edit`, `run_code` gate, `git` guards (63 checks) |
| `php tests/php/harness.test.php` | API/tool-dialect detection, request shapes, parsing (52) |
| `php tests/php/mcp.test.php` | MCP handshake/list/call against a mock server (9) |
| `php tests/php/mcpServer.test.php` | MCP **server**: auth, per-token scope filtering, protected paths, exec queue (18) |
| `node tests/js/harness.test.mjs` | client harness registry (28) |
| `php tools/gen-harness.php --check` | the generated JS table is up to date |

Note: the code interpreter and `git` use the same fixed POSIX `PATH` as `exec`,
so they resolve normally on a Linux/Apache host.
