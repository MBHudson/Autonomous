# 🧠 Autonomous Loop Studio — v360

> ## A self-hosted, universal multi-agent AI console. Point it at **any** model, hand the agents **real tools**, and watch the loop run. 🔁

![PHP](https://img.shields.io/badge/PHP-8.x-777BB4?logo=php&logoColor=white)
![No build step](https://img.shields.io/badge/build-none_needed-brightgreen)
![No database](https://img.shields.io/badge/database-none-blue)
![Mobile friendly](https://img.shields.io/badge/mobile-first-00e5ff)
![Windows](https://img.shields.io/badge/Windows-double_click_to_run-0078D4?logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-double_click_to_run-000000?logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-one_command-FCC624?logo=linux&logoColor=black)

One folder of PHP. 🚫 No database. 🚫 No build step. 🚫 No external service. A whole team of
agents with a filesystem, a shell, the web, memory, a visual routing chart — and **MCP in both
directions.** 🕸️

> ### 🆕 What's new in **v360** — the keys stopped leaving, and a close ends the right program 🔐
>
> Five ways this app could be made to hand over something it was guarding, or to report a success
> it never had — plus the one command that gets you back in after you lock yourself out. 🛠️

| | | |
|---|---|---|
| 🕵️ | **Reads answer with masks** | `GET /api/config`, `GET /api/mcp/servers` and `GET /api/mcp-server/config` were returning the very values they exist to protect — the **access token**, a **proxy password**, every **provider key**, every MCP client's `Authorization` header, every **friend token**. Those are the same values the other gates compare against, so one read disclosed the keys to every other door. They answer `********` now, and the write paths **restore** the real value, matched by **identity** (id → URL → command line; friend id → label). A mask reaching disk would have wiped a credential and shown up only as a server answering `401`. |
| 🏠 | **No token ⇒ this machine only** | `setup-token.sh --off` described itself as safe on *"a machine nothing else can reach"*, and nothing enforced it — behind a web server bound to all interfaces, the **agent-reachable program launcher** and the config route above were open to the network. A request from an address that is **not loopback** now gets **`403`**, with the one-liner that fixes it. The MCP route friends use is exempt on purpose and keeps its own per-friend Bearer token. |
| 🎯 | **A close ends the program you opened** | Processes were matched by **image name** (`tasklist /FI "IMAGENAME eq …"`), so your configured `notepad.exe` was *"the same program"* as every other copy of that file on the machine — a close could end something you never opened. They are matched by **the file they are running from** now (`/proc/<pid>/exe` on Linux, one `Get-CimInstance Win32_Process` query on Windows, `ps` elsewhere), compared as resolved paths and case-folded on Windows. A host that will not give up a process list makes `close` **refuse** — name matching is then the only thing left, and that is the bug. |
| ✅ | **A kill reports what actually happened** | `terminate()` returned `ok: true` for everything: a kill that never happened, a pid already gone, a refusal whose output was never read — so *"closed"* could be said about a program still on screen. The command's **exit status** decides now (taskkill's own message is localised), `ok` means *nothing of it is running any more*, and the reply names each surviving pid with its reason (`access denied (it runs as another user, or elevated)`, `it had already exited`). |
| 🧾 | **The trace cannot be forged** | Every field of an `storage/exec.log` line has control characters stripped, so an agent name or an argument carrying a newline can no longer append a record of a command that never ran — or hide one that did. |
| ⏱️ | **A command that answers can no longer hang the request** | `stream_select()` on a `proc_open` pipe **ignores its own timeout on Windows** and waited on the handle: a script that answered in half a second became a request that never answered at all, and `proc_close()` then waited on it for good measure. The reader is a bounded poll loop that cannot outlive its deadline, and the timeout path no longer calls `proc_close()` on a process it could not terminate. |
| 🪟 | **One argument, spelled the way Windows reads it** | An argument ending in a backslash is **doubled** (`"C:\dir\\"`), because `"…\"` is read by the program as an *escaped quote* — so a configured path used to arrive silently corrupted into a different argument. |
| 🔎 | **The way back in works on every machine** | `./setup-token.sh --show` needed `python3`: the one interpreter this app never needs, and on Windows usually the Microsoft Store's execution alias — a stub that prints English and exits 49. So the command you run *because* you are locked out printed its heading and no token. It now uses **python or php**, whichever actually answers, and says which it used; with neither, it points at `PHP_BIN=…` and at `start.bat -Token`, which needs no interpreter at all. |
| 🧪 | **The guards prove themselves** | The suite builds the fixtures it used to skip on, prints every `SKIP` with its reason and totals them, and never repeats a count it cannot trust. `php tests/freshClone.php` runs **both suites in a fresh copy** of the tree — `14 files, 14 passed, 0 failed, 840 assertions, 5 skipped`, *identical* on a clone and on the machine the tests were written on — and a pre-commit hook can run that same check against the **staged** tree, so what is verified is exactly what the commit will contain. Both print what the run actually cost, split by phase — the PHP half is the whole price. |

> ### 🖥️ …and in **v359** — agents can open real desktop programs
>
> A capability that already existed and was unusable: `exec` **waits** for the process, kills it at
> the timeout and holds the whole turn open while it runs — so *"open Notepad"* produced a window
> that closed itself a minute later, inside a stalled chat. 😵

| | | |
|---|---|---|
| 🖥️ | **A name, never a command line** | **Config → Shell access → Programs**: you keep a list of programs — a name, a path, optional arguments — and an agent may only **name** one. It never supplies a path or a command line, so the only text a model controls is a name you already wrote. |
| 🪟 | **The window outlives the reply** | The launch is **detached** (`cmd /c start` with the empty title token on Windows — the mechanism the built-in browser already opens Chrome/Edge with — a backgrounded process on POSIX), so no timeout closes it behind you, and it is audited as `kind=program phase=start` with **no end line**: exactly the *"started and still running"* record the two-phase log was built for. |
| 🙋 | **Asked for like everything else** | *Ask / Allow / Deny* for **Opening programs** and **Closing programs**, with Auto Approve and Auto Deny above them. Closing is graceful first (`taskkill /PID` posts WM_CLOSE; POSIX sends TERM) so an editor can still ask about unsaved work; `force` ends it outright. |
| 🚫 | **Not a door to the command shell** | Anything that is not `.exe`/`.com` on Windows is refused as a launch target, because starting a `.bat`, `.cmd` or `.ps1` means handing back the script host this whole design keeps away from a model. |
| 🚪 | **Off by default** | `sandbox.programs_enabled`, empty list: an install that updates gains the tools and **no capability at all** until you add a program. |

> ## 🔐 Security & guardrails — safe by construction 🛡️
>
> Giving a language model a shell, a filesystem and the web is normally a terrifying idea. 😱 So this
> app assumes the model is **hostile**, the web content it reads is **booby-trapped**, and the only
> trustworthy actor is **you, the operator.** Every capability is **off until you switch it on**,
> every dangerous action **asks first**, and every escape hatch has a floor beneath it. 🧱

| | | |
|---|---|---|
| 🔑 | **A lock on the front door** | Every API route is token-gated, per device. A fresh copy **refuses to serve anything** until you run `./setup-token.sh`. Nothing ships with a token. |
| 🚦 | **Approvals** | Writes, commands, git and code runs **queue a prompt**: *Allow once / Always / Deny*. **Auto-approve** is opt-in; **auto-deny** is the panic button. |
| 🧾 | **Allow / Deny lists** | An argv-level bouncer. The denylist is checked *before* the allowlist and before any prompt, so *"Always allow"* can never wave `rm` through — and it is a **default you can edit**, not a law. |
| 🧱 | **The jail** | Every path resolved server-side; `..`, absolute paths and symlinks all checked against your declared roots. Protected paths make `storage/` and `.env*` invisible **even inside a root**. |
| 🐚 | **No shell to hijack** | `exec` takes an **argv array** — no `sh -c`, no pipes, no `$(…)`, so there is no second command to inject. Windows' command hosts are denied by default. |
| 🔐 | **Masked reads** 🆕 | Config routes answer `********` in place of the access token, provider keys, MCP headers and friend tokens — and the write path **restores** the real value, matched by identity. A friend token is shown in plaintext exactly once: when created, or on ROTATE. |
| 🏠 | **Local-only with no token** 🆕 | While `require_token` is off, a request from an address that is **not loopback** gets **403**. The documented posture is now the enforced one. |
| 🧾 | **A trace that cannot be forged** 🆕 | One line per audit record, control characters stripped **at the single chokepoint** every command passes through — so a newline in a model-supplied argument cannot append a fake record. |
| 🌐 | **Egress fenced** | `fetch_url` and `http_request` refuse private and cloud-metadata hosts; `http/https` only; spoofed headers stripped; responses truncated. |
| 🖼️ | **Vision, safely** | PNG/JPEG/WebP/GIF only, sniffed as inert. The bytes **never touch the server** — no upload endpoint, no file on disk. |
| 🗄️ | **`storage/` is never web-served** | In **every** serving mode, at **any** depth, with shipped rules for Apache, nginx and the built-in server — and a suite that **makes the real request** and fails loudly when a path comes back. |
| 🌐 | **No CORS wildcard** | The API no longer answers `Access-Control-Allow-Origin: *`, which let any website read every conversation, the memory and the whole config. |

> ⚠️ **The honest caveat:** the app is only as safe as the operator's switches. Turn everything on,
> auto-approve writes, and point the root at `/` — and you have built yourself a very capable
> foot-gun. 🦶💥 The design *makes the safe choice the default* and *makes the unsafe choice
> deliberate*; it does not read your mind. Keep the root narrow, keep approvals on, rotate your keys. 💙

---

### ▶️ Five minutes to running ⏱️

**Windows** — unzip anywhere, double-click `start.bat`. First run installs XAMPP (Apache + PHP only,
no MySQL), links the folder, creates an access token, starts Apache and opens the app. Every later run
just starts the server. 🪟

> Use `start.bat`, **not** `start-php.bat`. PHP's built-in server answers one request at a time, so a
> team of agents queues behind the slowest reply. The app detects this and says so; Apache is the fix.

**Linux / macOS** — `./start.sh` (or `./start.sh 8090`). 🐧🍎

Then: paste the printed token into **Config → Access token** 🔑, add a model with your provider key in
**Brain Lab** 🧠 (or point it at Ollama / LM Studio on localhost), and type in the composer. 💬

![Desktop 2026 — the glass shell: edge rail, Config drawers, and the live network map](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/new-ui-main.png)

*Desktop 2026 — pick it in Config → Interface.*

![Orchestrate — agent swarms in parallel or sequentially, with loop, merge, delay and checkpoint nodes](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/routing-three-workfows.png)

*Orchestrate — agent swarms, in parallel or sequentially, with loop, merge, delay and checkpoint nodes.*

### ✨ What's in this build

| | | |
|---|---|---|
| 🤖 **Any model, any provider** | OpenAI, OpenRouter, NVIDIA NIM, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Cerebras, Together, Perplexity, Ollama, LM Studio, vLLM… |
| 🧭 **Auto-fitting harness** | Detects each provider's API shape *and* tool dialect, and speaks it correctly |
| 🧠 **Brain Lab** | Every per-agent setting, locks, memory, files and custom tools in one rail |
| 🧪 **API Lab** | Paste a curl → get it in 10 languages → actually send it server-side |
| 🔀 **Routing chart** | Draw workflows: agents, loops, checkpoints, delays, parallel fan-out |
| 🛠️ **Real tools** | Files, shell, web, a code interpreter, git, editors, MCP |
| 🖥️ **Agent-opened programs** 🆕 | An agent may **name** a program on your list and it opens **detached**, so the window outlives the reply |
| ⏱️ **Pacer / limiter** | Per-key rate limiting that knows each provider's free-tier ceiling |
| 📊 **Metrics + 🔎 trace** | Uptime, requests, tokens, budgets, and a live run timeline |
| 🧠 **Memory** | Private + collective long-term memory the agents actually use |
| 🔐 **Locked down** | Access token, approvals, allow/deny lists, jailed filesystem, masked reads |
| 🔌 **MCP client + server** | Connect to other MCP servers, *or* let a friend connect to you |
| 🎨 **Themes** | Dark, Matrix, Cyberpunk |
| 🖼️ **Vision** | Attach images for vision-capable agents — the bytes never hit the server |
| 🎙️ **Voice** | 🎤 speech-to-text in, 🔊 spoken replies out, with per-agent pitch |
| ⌨️ **Slash commands** | `/CODE`, `/ROLE`, `/NAME`, `/ALL`, `/?` — address agents from the composer |
| 💾 **Export / import** | Take a session out, or back up and restore the whole state |
| 🔑 **API pool** | Rotate a provider's extra keys after N requests; rest them on a 429 |
| 🌐 **Built-in browser** | A real Chrome/Edge you and the agents drive — watch, click, type, log in |
| ♾️ **Always-On loop** | Standing goals, auto re-prompted on a cadence — caps, hold/release, one master kill switch |
| ❝ **Global pre-prompt** | One instruction for every agent — **prepend** (default) or **replace**, toggled live |
| 🧠 **Context assembler** | History & tool output budgeted to each model's *real* window, with live compaction |
| 🧮 **Resource Manager** | Optional pause / idle throttles + CPU/GPU gauges so the 3D graph can rest |
| 🕸️ **MCP on the graph** | Outgoing calls and incoming friends drawn as live nodes with editable access |
| 🖥️ **Two interfaces** | **Classic** (default) and **Desktop 2026** — one switch, same features, same store |
| 🌐 **Proxy** | Hundreds of live HTTP proxies — **elite** and **anonymous** only — with ping, uptime and favourites |
| 🔄 **Self-updates, one click** | A load-time check that names what shipped, a verified download that shows the diff, and an installer that keeps a rollback copy first |
| 📱 **Mobile-first** | Built for the phone in your pocket |

---

### 🎯 Where we'd actually like your eyes

1. **A fan-out on your hardware.** 🕸️ Three or more agents at once. Does each reply settle the moment
   it lands, or does the turn hold until the slowest one?
2. **One long run.** ⏳ Point an agent at real work for twenty minutes and watch memory, the trace and
   the transcript.
3. **Your provider.** 🧭 The harness guesses each API's shape and tool dialect. Tell us what it guessed
   wrong — that is the most useful bug you can send.
4. **A phone.** 📱 Open it on the actual device, not a narrowed desktop window.
5. **`/storage`.** 🗄️ After install, request `http://your-host/router/storage/config.json`. You must get
   **403**. If you get JSON, stop everything and tell us — that is the finding we care about most.
6. **A program window** 🖥️ — add one in **Config → Shell access → Programs**, ask an agent to open it,
   and see whether the window appears where the card says it will.

---

### ⚠️ Known limits — read before filing

| | | |
|---|---|---|
| **The installer needs write access** | Where the web server owns the app's files — the XAMPP path on Windows — an update downloads, verifies and installs itself, keeping a rollback copy of the code first. A host where the app folder belongs to someone else stops it before the download and points you at `install-update.php`, which does the same job from a terminal. |
| **A program opens in the server's session** 🆕 | Started as a console process (`start.bat`) the window appears on your desktop; installed as a Windows **service** it lands in session 0 and nothing is visible. On POSIX it needs a desktop session — a headless host has nowhere to draw. The card states which is true on this host. |
| **Closing on POSIX is a signal, not a window request** 🆕 | Windows gets a real close request (`taskkill /PID` posts `WM_CLOSE`), so an editor can still ask about unsaved work. On Linux and macOS a close is `TERM` and `force` is `KILL` — a window that ignores `TERM` needs `force`. Where a host will not give up a process list, `close` **refuses** rather than falling back to matching by name. |
| **Comms log is in memory** | Bounded to 300 exchanges, cleared when the server restarts. It is for watching a run, not an archive. |
| **One token, no accounts** | Fine on localhost or a LAN you trust. Put basic auth in front of it if it is ever reachable from outside. |
| **A same-host reverse proxy looks local** 🆕 | With no token set, a request arriving through a proxy on the same machine passes the local-only rule, because the proxy is the peer. Set a token and the question stops mattering. |
| **`exec.log` never rotates** | It grows until you delete it. |
| **Proxies are third-party** | The lists refresh daily and the app filters for anonymity, but the exit node belongs to someone else. Do not send credentials through one. |

---

### 🐞 Filing a report

Please include: the release number (Config → Updates shows it), your OS, Classic or Desktop 2026,
whether you launched with `start.bat` or `start-php.bat`, and for a hang or a bad reply the **TRACE →
RUNS** rows from that turn. A screenshot of the map beats a paragraph describing it. 📸

Thanks for kicking the tires. 🛞
