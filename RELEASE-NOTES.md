A self-hosted, universal multi-agent AI console. One folder of PHP, no database,
no build step, no external service. You bring the API key; it brings the agents,
the tools and the map.

### ▶️ Five minutes to running

**Windows** — unzip anywhere, double-click `start.bat`. First run installs XAMPP
(Apache + PHP only, no MySQL), links the folder, creates an access token, starts
Apache and opens the app. Every later run just starts the server.

> Use `start.bat`, **not** `start-php.bat`. PHP's built-in server answers one
> request at a time, so a team of agents queues behind the slowest reply. The app
> detects this and says so; Apache is the fix.

**Linux / macOS** — `./start.sh` (or `./start.sh 8090`).

Then: paste the printed token into **Config → Access token**, add a model with
your provider key in **Brain Lab** (or point it at Ollama / LM Studio on
localhost), and type in the composer.

![Desktop 2026 — the glass shell: edge rail, Config drawers, and the live network map](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/new-ui-main.png)

*Desktop 2026 — pick it in Config → Interface.*

![Classic — the default: setup panel, chat and map side by side](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/routing-three-workfows.png)

*Orchestrate  —  agent swarms, in parallel or sequentially, with loop, merge, delay and checkpoint nodes.*

### ✨ What's in this build

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
| 🖼️ **Vision** | Attach images for vision-capable agents — the bytes never hit the server |
| 🎙️ **Voice** | 🎤 speech-to-text in, 🔊 spoken replies out, with per-agent pitch |
| ⌨️ **Slash commands** | `/CODE`, `/ROLE`, `/NAME`, `/ALL`, `/?` — address agents from the composer |
| 💾 **Export / import** | Take a session out, or back up and restore the whole state |
| 🧠 **Dynamic tools** | Teaches each model the environment it's really in — and learns the tool dialect that works |
| 🔑 **API pool** | Rotate a provider's extra keys after N requests; rest them on a 429 |
| 🌐 **Built-in browser** | A real Chrome/Edge you and the agents drive — watch, click, type, log in |
| ♾️ **Always-On loop** | Standing goals, auto re-prompted on a cadence — caps, hold/release, one master kill switch |
| ❝ **Global pre-prompt** | One instruction for every agent — **prepend** (default) or **replace**, toggled live |
| 🧠 **Context assembler** | History & tool output budgeted to each model's *real* window, with live compaction |
| 🧭 **Apps notch** | One thumb-tab to the Labs, the routing chart and the built-in browser |
| 🧮 **Resource Manager** | Optional pause / idle throttles + CPU/GPU gauges so the 3D graph can rest |
| 🕸️ **MCP on the graph** | Outgoing calls and incoming friends drawn as live nodes with editable access |
| 🖥️ **Two interfaces** | **Classic** (default) and **Desktop 2026** — one switch, same features, same store |
| 🎛️ **Desktop card** | Fog · bloom · floating floor · floor pin · map detail · frame cap · glass — tuned defaults, every knob exposed |
| 🌐 **Proxy** | Hundreds of live HTTP proxies — **elite** and **anonymous** only — with ping, uptime and favourites; one click routes every agent's outbound traffic through it |
| 🔄 **Self-updates, one click** | A load-time check that names what shipped, a verified download that shows the diff, and an installer that keeps a rollback copy first — your settings are never in scope |
| 📱 **Mobile-first** | Built for the phone in your pocket |

---

### 🎯 Where we'd actually like your eyes

1. **A fan-out on your hardware.** Three or more agents at once. Does each reply
   settle the moment it lands, or does the turn hold until the slowest one?
2. **One long run.** Point an agent at real work for twenty minutes and watch
   memory, the trace and the transcript.
3. **Your provider.** The harness guesses each API's shape and tool dialect. Tell
   us what it guessed wrong — that is the most useful bug you can send.
4. **A phone.** Open it on the actual device, not a narrowed desktop window.
5. **`/storage`.** After install, request
   `http://your-host/router/storage/config.json`. You must get **403**. If you get
   JSON, stop everything and tell us — that is the finding we care about most.

---
### ⚠️ Known limits — read before filing

| | |
|---|---|
| **No installer** | Config → Updates detects a newer release, downloads it, verifies it and shows a file-by-file diff — then **stops**. Installing is manual: replace the app files, keep `storage/`. |
| **Comms log is in memory** | Bounded to 300 exchanges, cleared when the server restarts. It is for watching a run, not an archive. |
| **One token, no accounts** | Fine on localhost or a LAN you trust. Put basic auth in front of it if it is ever reachable from outside. |
| **`exec.log` never rotates** | It grows until you delete it. |
| **Proxies are third-party** | The lists refresh daily and the app filters for anonymity, but the exit node belongs to someone else. Do not send credentials through one. |

---

### 🐞 Filing a report

Please include: the release number (Config → Updates shows it), your OS, Classic
or Desktop 2026, whether you launched with `start.bat` or `start-php.bat`, and for
a hang or a bad reply the **TRACE → RUNS** rows from that turn. A screenshot of
the map beats a paragraph describing it.

Thanks for kicking the tires.
