# 🧠 Autonomous Loop Studio

> A self-hosted, multi-agent AI console. Point it at **any** model, hand the agents **real tools**, and watch the loop run.

![Main screen](screenshots/mainscreen01.png)

**Autonomous Loop Studio** (the "Router") is a single-folder PHP app — 🚫 no database, 🚫 no build step, 🚫 no external service. It runs on plain PHP (or Apache via XAMPP), keeps everything in JSON files, and drops a whole team of AI agents into your browser with a filesystem, a shell, the web, memory, a visual routing chart — and **MCP in both directions**.

Made with 💙 by [MBHudson](https://github.com/mbhudson/)

---

## ✨ What's inside

| | |
|---|---|
| 🤖 **Any model, any provider** | OpenAI, OpenRouter, NVIDIA NIM, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Cerebras, Together, Perplexity, Ollama, LM Studio, vLLM… |
| 🧭 **Auto-fitting harness** | Detects each provider's API shape *and* tool dialect, and speaks it correctly |
| 🧠 **Brain Lab** | Every per-agent setting, locks, memory, files and custom tools in one rail |
| 🧪 **API Lab** | Paste a curl → get it in 10 languages → actually send it server-side |
| 🔀 **Routing chart** | Draw workflows: agents, loops, checkpoints, delays, parallel fan-out |
| 🛠️ **Real tools** | Files, shell, web, a code interpreter, git, editors, MCP |
| ⏱️ **Pacer / limiter** | Per-key rate limiting that knows each provider's free-tier ceiling |
| 📊 **Metrics + 🔎 trace** | Uptime, requests, tokens, budgets, and a live run timeline |
| 🧠 **Memory** | Private + collective long-term memory the agents actually use |
| 🔐 **Locked down** | Access token, approvals, allow/deny lists, jailed filesystem |
| 🔌 **MCP client + server** | Connect to other MCP servers, *or* let a friend connect to you |
| 🎨 **Themes** | Dark, Matrix, Cyberpunk |
| 📱 **Mobile-first** | Built for the phone in your pocket |

---

## 📸 Screenshots

**Main screen — agents, chat, network panel**
![Main screen](screenshots/mainscreen.png)

**🧠 Brain Lab — every agent setting, card and lock in one place**
![Brain Lab](screenshots/Brain-Lab.png)

**🧪 API Lab — curl ⇄ request ⇄ 10 languages**
![API Lab](screenshots/API-Lab.png)

**🔌 MCP — the client (connect out) and the server (let friends in)**
![MCP](screenshots/MCP.png)

**🔀 Routing chart — three workflows with loops and fan-out**
![Routing chart](screenshots/routing-three-workfows.png)

**⏱️ Throttle, 📊 token budget, 📈 metrics and the per-agent clock**
![Throttle and metrics](screenshots/throttle-token-metrics-clock.png)

---

## 🚀 Quick start

### 🪟 Windows — one click
- **`setup-xampp.bat`** — downloads + installs XAMPP (Apache + PHP only, no MySQL), links this folder into `htdocs\router`, starts Apache and opens the app. Best when several agents run at once.
- **`start.bat`** — no Apache needed; uses PHP's built-in server and installs PHP with winget if it's missing. Fine for one agent at a time (Windows PHP serves one request at a time).

### 🐧 Linux / macOS
```bash
./start.sh          # or ./start.sh 8090 for another port
```

### 🔑 First run
The launchers install PHP + the extensions it needs (curl, openssl, mbstring, fileinfo, zip) without touching your own `php.ini`, bundle CA certs so HTTPS verifies, and print an **access token** once. Paste it into **Config → Access token** in the app — it saves on paste (there's no SAVE for that field, on purpose).

The app then opens at `http://127.0.0.1:8080/`. Nothing ships with keys — add your own providers in the **Providers** tab.

---

## 🧠 Brain Lab

![Brain Lab](screenshots/Brain-Lab.png)

One rail for everything about the selected agent:

- **Identity** — name, label, role, provider, model, colour, active.
- **Prompts & Profiles** — the agent's system prompt, an always-append box, and reusable **direction profiles** you can attach and lock.
- **Rate / Throttle** — per-agent pacing (or follow the global limiter).
- **Approvals & Tools** — per-tool **allow / ask / deny**, plus a tool protocol picker that shows the **auto-detected** dialect.
- **Memory** — private and collective notes, with a Long-term-memory switch and delete buttons (forgetting is a first-class action).
- **Sandbox** — a per-agent **file jail** and the file manager.
- **Always-On** — a standing goal, loop cadence, and a live RUNNING/HELD/IDLE badge.

Every setting has a 🔒 **lock**: unlocked agents follow the global value live; a lock pins the agent to its own value so a global change never moves it.

---

## 🧪 API Lab

![API Lab](screenshots/API-Lab.png)

Opened from the 🧪 icon in the Agents-tab header.

- **Both directions**: `curl → request → 10 languages`, and `language → request → curl/bash/Python/TypeScript/OpenAI-SDK`.
- **Sending is server-side**, because the browser can't reach most providers (no CORS headers). The server runs the request and returns the status + body.
- **Guardrails**: http/https only; cloud-metadata addresses refused; key-shaped headers masked on screen (copy/send still use the real value); response bodies truncated.

---

## 🔀 Routing chart

![Routing chart](screenshots/routing-three-workfows.png)

Draw the flow instead of describing it:

- **Nodes**: agent, parallel, merge, checkpoint, **delay**, loop, end.
- **Loops** with per-lap state, **checkpoints** that pause for review, **delays** (wait a duration or until a wall-clock time) that hold only their own branch.
- **Parallel fan-out** runs every ready node concurrently; the scheduler handles it.
- **Live run state** on the edges (marching + glow while running, settle when done), a faint **ghost transcript** of the chat behind the canvas, and an **align-to-grid** snap (off by default).
- A **notification bell** for run errors/warnings, with its own list.

---

## 🛠️ Tools agents can use

Tick tools per agent in the editor. They're grouped:

**🧰 Server-side sandbox (files, web, shell)**
| Tool | What it does |
| --- | --- |
| 🌐 `web_search` | Search the web, no API key (DuckDuckGo → Marginalia → Wiby) |
| 📄 `fetch_url` | Read a page as plain text (refuses private/metadata hosts) |
| 📖 `read_file` / `list_dir` / `glob_files` / `grep_code` / `stat` | Explore a jailed filesystem |
| ✍️ `write_file` | Create or edit a file — **asks you first** |
| 🧑💻 `exec` | Run one command as an **argv array** (no shell), allowlisted |
| 🐍 `run_code` | Run a Python/Node/bash snippet (off by default) |
| 🐙 `git` / `git_commit` | Read-only git, plus stage + commit |

**🖊️ Familiar editor + workflow tools** (the names models were trained on)
`str_replace_editor` (view/create/str_replace/insert), `edit_file` (search/replace), `apply_patch` (Codex **V4A** diffs), `multi_edit` (**all-or-nothing**), `todo_write` (a plan), `think` (a private scratchpad), `http_request` (any method + headers + body).

**🤝 Team + memory + MCP**
`list_agents`, `ask_agent`, `tell_agent`, `read_mailbox`; `remember`, `share`, `recall`, `adopt`; `mcp_list`, `mcp_call`.

Every path is **jailed** server-side, so `../` and symlinks can't escape, and a **protected-paths** list keeps secrets (`storage/`, keys, dotfiles) off-limits even inside a root.

---

## 🧭 The provider harness

Different providers aren't one API with different URLs. A single registry (`src/Harness.php` + `ui/js/harness.js`) decides, per request:

- **Which API shape** — OpenAI-compatible, Anthropic Messages, Google `generateContent`, or Ollama — from the **endpoint host**, then provider id, then a model hint.
- **Which tool dialect** to teach — JSON, Claude XML, native tags, or plain — from the provider + model id.
- **Per-family quirks** — auth headers (Bearer / `x-api-key` / `?key=` / Azure `api-key`), request/response/usage/reasoning shapes, streaming envelopes, and output-token caps.

Adding a provider is one line in the alias table, or just a new provider in the UI. The browser copy is **generated** from the PHP (`php tools/gen-harness.php`) so the two can't drift.

---

## ⏱️ Throttle / limiter / pacer

![Throttle and metrics](screenshots/throttle-token-metrics-clock.png)

A 40-requests-per-minute key dies when 16 chart nodes fire at once. The pacer counts outbound calls **per host + key** and waits instead of spending a 429.

- **Per-key buckets** — four agents on four keys are four buckets; two agents on one key correctly share.
- **Knows the free tiers** — NVIDIA NIM 40/min, Groq 30, OpenRouter 20, … with a host default for anything unknown. Set the global field to **`0 = AUTO`** to use each provider's real ceiling, or type a number to override everyone. Precedence: **agent lock → provider → global → host default**.
- **Learns from a 429** — a real refusal holds the bucket closed for the server's `Retry-After`.

---

## 📊 Metrics & 🔎 Run trace

- **Agent cards** show a live line: `⚡ tokens/budget · N req · up 2h · 40/min` — with a tooltip of in/out tokens, billed calls, output cap, context window and last call. Set a **token budget** (Config → Limits) and it shows `used/limit (%)`.
- **🔎 Run trace** (Config → TRACE) is a sequenced timeline of every model turn and tool call: time, agent, model/tool, **ms**, **ok/fail**, and token cost — plus totals.

---

## 🧠 Memory

Agents keep **private notes** and share a small **collective** every agent reads. Tools: `remember` (private), `share` (collective), `recall`, `adopt`. Notes are injected as **recollection, not instructions**, and are fully editable/deletable in Brain Lab.

Two recent hardenings so memory can't look "off":

- If a model **narrates** a tool call ("I'll use the remember tool") instead of emitting it, the loop **re-prompts once** to actually send it.
- Memory syncs across devices but **unions** by id — a sync can never silently drop a note that exists only in your browser.

---

## 🔐 Security model

- **Access token** — every API endpoint is gated. Generate with `./setup-token.sh`, paste into **Config → Access token** per device.
- **Approvals** — `write_file`, `exec`, `run_code`, `git_commit` and friends ask first (Allow once / Always / Deny). Auto-approve is opt-in.
- **Allow / Deny lists** — an argv-level command allowlist, an **absolute** denylist, and per-interpreter levels (Blocked / Scripts only / Full).
- **Jail + protected paths** — file tools resolve server-side and refuse anything outside the roots, and a **protected list** refuses secrets even inside a root.

---

## 🔌 MCP — connect **out** to other servers (client)

**Config → MCP Client.** Add any MCP server (stdio command + args, or an HTTP URL with headers). Its tools become available to your agents through `mcp_list` / `mcp_call`. Servers are operator-configured — a model can *call* them, never add one.

```jsonc
// storage/config.json
"mcp": { "servers": [
  { "id": "files", "transport": "stdio",
    "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv"] },
  { "id": "internal", "transport": "http", "url": "https://mcp.example.com",
    "headers": { "Authorization": "Bearer …" } }
]}
```

---

## 🖥️ MCP — let others connect **in** (server)

![MCP](screenshots/MCP.png)

The mirror of the client: an operator can expose this install as a **remote MCP server**, so another person's MCP client — their own local model, Claude Desktop, Cursor — can call tools that run on the operator's machine.

### 🔧 Enable it (operator)
**Config → MCP Server**
1. Turn **Enable the MCP server** on.
2. Set a **scratch folder** — friends' file and command tools are jailed there, and a deny-all `.htaccess` is dropped in so nothing they write is web-served.
3. Optionally edit the **protected paths** list.
4. Add a **token per friend**, each with a scope: **read / write / exec** (and an optional IP allowlist). Tokens never expire; revoke one with a click.

The endpoint is **`POST /api/mcp-server`** (JSON-RPC 2.0), authenticated with `Authorization: Bearer <token>`.

### 🎚️ What a token decides
- **read** → `read_file`, `list_dir`, `glob_files`, `grep_code`, `stat`, `fetch_url`, `web_search`, `git_read`
- **write** → `write_file`, `edit_file`, `insert`, `apply_patch`, `multi_edit`
- **exec** → `exec`, `run_code`, `git_commit`

Scope is a **ceiling**, not a bypass: a call still runs through the same sandbox, allow/deny lists, interpreter levels and approvals. An un-allowed command queues in the **operator's** Pending-approvals list and the friend's call returns *"waiting for the operator"*. Every call is written to `storage/mcp.log`.

### 👋 How a friend connects
1. **Client supports remote MCP (HTTP)** — add a remote server at the URL with one header: `Authorization: Bearer <token>`.
2. **Client is stdio-only (e.g. Claude Desktop)** — bridge it with `mcp-remote`:
   ```bash
   npx -y mcp-remote https://YOUR-HOST/path/api/mcp-server \
     --header "Authorization: Bearer <token>"
   ```
3. **The friend runs their own copy of Loop Studio** — **Config → MCP Client → + ADD SERVER** (name, transport `http`, url, and a `headers` box with `Authorization: Bearer <token>`). Their agents then reach the operator's tools through `mcp_list` / `mcp_call`.

The operator hands over the **URL + that friend's token**; `FRIENDS.md` is the one-page version to send along.

---

## 📱 Android & mobile

The UI is **mobile-first** — touch controls, a responsive layout, an icon rail on phones, and it works in the phone's browser right next to wireless-debugging tooling.

> ⚠️ **Correction:** an earlier note claimed there would be no Android app because *"you can't put a PHP server into an Android app."* **That is false.** An Android build is a packaging exercise, not an impossibility:
>
> - 🧩 **Thin WebView shell** — package a tiny app whose WebView points at the hosted instance. The whole UI already runs in a mobile browser.
> - 📦 **PHP on-device** — PHP runs on Android via **Termux** (`pkg install php`, then `php -S 127.0.0.1:8080 serve.php`), **KSWEB**, or **AndroPHP**, so a fully local, offline build is possible too.
> - 🏠 **Installable PWA** — add the web UI to the home screen as a progressive web app.
>
> So: 📱 an Android version is on the table. The old "impossible" line is struck.

---

## 🧩 Architecture

```
/router/
├── index.html            # SPA entry (canonical)
├── api/
│   ├── index.php         # REST front controller (all routes)
│   └── lab.inc.php       # API Lab request runner
├── src/                  # PHP backend
│   ├── Config.php        # settings + models
│   ├── ModelManager.php  # relays + streaming
│   ├── Harness.php       # provider / tool-dialect registry
│   ├── Sandbox.php       # jail, files, exec, git, code, http
│   ├── Mcp.php           # MCP client
│   ├── McpServer.php     # MCP server
│   ├── SessionManager.php
│   ├── TopologyGraph.php
│   └── Audio.php
├── ui/
│   ├── js/               # app modules (store, api, tools, harness, brainlab…)
│   └── css/
├── tools/
│   ├── gen-harness.php   # generates ui/js/harness.data.js
│   └── cacert.pem
├── tests/
│   ├── php/              # sandbox · harness · mcp · mcpServer
│   └── js/
├── screenshots/
├── storage/              # JSON data (config, state, sessions) — git-ignored
├── serve.php             # php -S router (no Apache needed)
├── start.bat / start.sh  # launchers
├── setup-xampp.bat/.ps1  # one-click Apache + PHP (Windows)
├── setup-token.sh        # create / rotate the access token
├── FRIENDS.md            # hand this to a friend to connect over MCP
├── CHANGELOG.md
└── README.md
```

---

## 🔗 API endpoints

All under `/router/api/…` (or `/api/…`). Every route is token-gated.

| Area | Routes |
| --- | --- |
| 🗂️ State / config | `GET·PUT /state`, `GET·PUT /config`, `GET /models` |
| 💬 Sessions | `GET·POST /sessions`, `GET·PUT·DELETE /sessions/{id}`, `DELETE /sessions/close/{id}` |
| 🤖 Models / relay | `POST /query`, `POST /llm` (relay + stream), `GET /catalog` |
| 🛠️ Sandbox | `GET /sandbox/status`, `POST /sandbox/{search,fetch,read,write,list,glob,grep,str_replace,insert,apply_patch,multi_edit,git,git_commit,http,code,…}` |
| 🧑💻 Shell | `POST /exec`, `GET /exec/allowlist`, `GET /exec/pending`, `POST /exec/decide` |
| 🔌 MCP | `GET·POST /mcp/servers`, `GET /mcp/status`, `POST /mcp/tools`, `POST /mcp/call` |
| 🖥️ MCP server | `POST /mcp-server` (JSON-RPC), `GET·POST /mcp-server/config` |
| 🧪 Lab / proxy | `POST /lab`, `GET /proxies`, `POST /proxy-ping`, `GET·PUT /proxy-active` |
| 📈 Misc | `GET /topology`, `POST /diag`, `GET /backup`, `POST /import`, `GET /export/{id}`, `POST /audio/{speak,transcribe}` |

Failures come back as `{"error": "..."}` with HTTP 400 and a message meant for the model, so a refused path reads as *"outside the allowed directories"* rather than a blank 500.

---

## 🧯 Troubleshooting

- **"PHP's curl extension is not enabled"** → the server was started without the launcher (e.g. a bare `php -S`). Use `start.bat` / `start.sh`, or run `php serve.php --setup`.
- **Every request returns 401** → the **Access token** isn't pasted on this device. The token is per-device; paste it in **Config → Access token**.
- **Phone shows an empty UI or immortal 401s** → a **split-brain** load. Deploy the **whole `ui/` folder** (never single files) and hard-refresh — mixing module versions gives each its own store.
- **Agents "won't use tools"** → check for a **global pre-prompt** that says "reply with ONLY text / N words" — it fights the tool protocol. The tool instructions now override it and the loop re-prompts once, but turning it off is cleanest.
- **A model returns nothing / "NetworkError"** → on Windows PHP's built-in server is single-threaded; use `setup-xampp.bat` (Apache) for parallel agents, or run fewer at once.
- **Local models not connecting** → make sure Ollama/LM Studio is running and reachable (Ollama `:11434`, LM Studio `:1234`).

---

## 📜 License

MIT — use it however you want, commercial or personal. 💙

Made by [MBHudson](https://github.com/mbhudson/)
