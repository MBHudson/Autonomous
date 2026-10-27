# Release notes

The text that goes on the GitHub **release** page, kept here so it is versioned
next to the code instead of living only in a browser text box. Numbers and
wording are for the build named at the top; edit this file when the notes change,
not the published release.

## How to publish one

1. **Tag** — name it after [`VERSION`](VERSION), e.g. `v353-open-testing`. That
   sorts sanely and says what it is.
2. **Title** — `v353 — Open testing` (or `— Release` once it is not a test).
3. **Tick “Set as a pre-release”** for any open-testing build. That keeps it out
   of *Latest release* so nobody treats it as the supported version.
4. **Body** — copy everything inside the fence below.
5. **Push the branch too.** The in-app update check reads `VERSION` and
   `APP_VERSION` from **`master`** (`src/Update.php` → `RELEASE_PROBE`), not from
   tags. A tag alone notifies nobody; a moved `master` does. See
   [RELEASING.md](RELEASING.md).

## Release body

```markdown
## 🧠 Autonomous Loop Studio — open testing, v353

A self-hosted, universal multi-agent AI console. One folder of PHP, no database,
no build step, no external service. You bring the API key; it brings the agents,
the tools and the map.

This is the first build going out beyond the machine it was written on. It runs,
and it is **not finished** — the limits list near the bottom is the honest part,
so read it before you file anything.

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

### ✨ What's in this build

- **Two shells, one switch** — Classic is the default; Desktop 2026 is the glass
  one. Same app underneath. Narrow the window and either becomes the mobile
  layout.
- **The map** — your agents as a live 3D network: fog, bloom, a floating floor
  you can pin in place, slow auto-rotate.
- **Agent-to-agent conversation, in words** — the beams always showed *who*
  talked. The new **Comms** tab and the per-agent **Talk / Runs** drawer show
  *what was said*, and hovering a beam prints it.
- **An audit trail that holds up** — two lines per command, `phase=start` before
  the spawn and `phase=end` after, sharing a `run=` id and naming the agent. A
  start with no end is now visible as exactly that.
- **A sandbox per agent** — add jail folders in Brain Lab and give each agent its
  own, without touching the global default.
- **Allow / Deny with an undo** — restore-defaults button, and the
  `cmd` / `powershell` interpreter gap is closed *by list*, never hard-coded, so
  you can always change your mind.
- **Proxy** — hundreds of live proxies, ELITE and ANONYMOUS only, with ping and
  uptime, favourites, and one click that routes all of an agent's outbound
  traffic.
- **Updates that explain themselves** — a load-time check, a bell naming the
  release from its changelog, and a **What's new** row you can expand.

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

### ⚠️ Known limits — read before filing

| | |
|---|---|
| **No installer** | Config → Updates detects a newer release, downloads it, verifies it and shows a file-by-file diff — then **stops**. Installing is manual: replace the app files, keep `storage/`. |
| **Comms log is in memory** | Bounded to 300 exchanges, cleared when the server restarts. It is for watching a run, not an archive. |
| **One token, no accounts** | Fine on localhost or a LAN you trust. Put basic auth in front of it if it is ever reachable from outside. |
| **Apache for a team** | `php -S` serves one request at a time. One agent is fine; five will queue. |
| **`exec.log` never rotates** | It grows until you delete it. |
| **Proxies are third-party** | The lists refresh daily and the app filters for anonymity, but the exit node belongs to someone else. Do not send credentials through one. |
| **Android: not yet** | The web UI is mobile-first; there is no app in the store. |

### 🐞 Filing a report

Please include: the release number (Config → Updates shows it), your OS, Classic
or Desktop 2026, whether you launched with `start.bat` or `start-php.bat`, and for
a hang or a bad reply the **TRACE → RUNS** rows from that turn. A screenshot of
the map beats a paragraph describing it.

Thanks for kicking the tyres.
```

## Screenshots

Paste these above *What's in this build*; GitHub renders raw links inside release
bodies. They point at `master`, so they update themselves.

```markdown
![Desktop 2026](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/new-ui-main.png)
![Classic — the default](https://raw.githubusercontent.com/MBHudson/Autonomous/master/screenshots/mainscreen01.png)
```

Do **not** link `main.png` or `main-motion.gif` — nothing references them any
more and the GIF is 2.8 MB.
