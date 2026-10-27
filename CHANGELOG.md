<!--
  Copyright M. Bryce Hudson 2026-2029 All Rights Reserved

  Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.

  BryceFromIndiana@gmail.com
-->

# Changelog

All work in this session. UI changes shipped with a full `ui/` sync and the
`?v=` cache-buster bumped (v281 → **v348**, in `ui/js/store.js` → `APP_VERSION`).
PHP changes need only the usual file deploy.

`VERSION` at the repo root carries the release number, which the update check now
reads and compares alongside that cache-buster — see the first entry below.

---

## 🗣️ What the agents said, and a trail that can be trusted *(UI — `VERSION` 352, cache-buster v349 → v350)*

The map could already show **that** two agents spoke. It could not show a word of
it, and the audit log it pointed at could not prove a command had run at all.
Both records are now readable, and both are honest about what happened.

**The audit trail tells the truth now.** `storage/exec.log` used to get one line
per run, written *after* the process was reaped, with no idea who asked for it.
That meant a run killed mid-command — the operator force-stops, the server
restarts, a GUI app is left open — left **no record whatsoever**, and a line
could never be tied to the turn that requested it. Each run now writes **two**
lines: `phase=start` *before* the spawn and `phase=end` after it, sharing one
`run=` id, both carrying `agent=<id>`. A start with no end is now visible as
exactly what it is: something that started and never reported back. `run_code`
(the code interpreter) was not audited at all; it is now, as `kind=code`.

**Config → TRACE is three views of one question.** The single table became
**RUNS · COMMS · EXEC**:

- **RUNS** — unchanged: model turns and tool calls with timing, tokens, success.
- **COMMS** — what the agents *said* to each other, with the text: the question an
  agent asked, the answer that came back, one-way orders, and pings, each with
  its duration and a failure marker. Questions and answers stay paired as one
  exchange instead of two unrelated lines.
- **EXEC** — `storage/exec.log`, parsed server-side and paired into runs, newest
  first: time, agent, command, working directory, duration, exit code, and a
  **no end** marker for a run that never finished. Read-only on purpose — the
  UI cannot clear evidence, and the Clear button only ever empties RUNS or
  COMMS.

**Per-agent, from the map itself.** The 3D agent card's *Recent messages* now
shows what was said, and a **Messages →** button opens a drawer scoped to that
agent: **TALK** (every exchange it sent or received, both halves with the text)
and **RUNS** (its own audited commands, fetched by agent id). Hovering a beam on
the chart shows *"Agent A → Agent B: …"*, so the map stops being mute.

Agent-to-agent chat is memory-only and bounded to 300 exchanges, like the run
trace: it is for watching a run, and a second copy of every conversation on
disk would need its own retention decision.

**Plumbing.** `exec` and `run_code` now pass the calling `agentId`; the new
`storage/exec.log` reader tails only the last 256 KB (bounded, read-only) and
parses both the new two-line shape and the older one-line records, so an
existing log stays readable. New: `ui/js/commsLog.js`,
`ui/js/components/agentRecord.js`, `tests/js/commsLog.test.mjs`, and audit
assertions in `tests/php/sandbox.test.php`.

---

## 🗄️ Add sandboxes from Brain Lab, and the Browser rail stops overlapping on a phone *(UI — `VERSION` 351, cache-buster v348 → v349)*

- **The gap.** A per-agent file jail already existed (`agent.sandboxRoot`, picked
  from a dropdown in Brain Lab → Sandbox), but the only places you could *create*
  one were Config → Sandbox's two textareas. So "give this agent its own
  directory" meant leaving the agent you were editing, typing a path into a
  multi-line list as text, coming back, and hoping it matched. The dropdown only
  ever showed what the global allowlist already contained.
- **What was added.** Brain Lab → Sandbox now has an **Add a sandbox** row: type a
  folder, press ADD, and it becomes a selectable jail for the open agent (and for
  every other agent) immediately. Nothing about Config → Sandbox changed — it is
  the same `sandbox.read_roots` / `write_roots` allowlist, edited from a second
  place, because one allowlist that two screens share is the whole reason the
  jail is enforceable.
- **Why it appends to the global lists instead of keeping its own.** The jail is
  checked server-side against `storage/config.json`; a per-agent list that the
  server cannot see would be a UI that offers jails every tool call then refuses.
  Adding here unions the effective roots (not just the stored ones — a fresh
  install has no `sandbox` block at all and runs on the app-directory default,
  which writing a single path would have silently dropped) with the new folder,
  saves, and re-reads them.
- **"Saved" is not "usable", so the two are answered separately.** The server
  `realpath`s every root and drops anything that is not an existing directory. The
  new control checks whether the folder actually came back, and if it did not it
  says so — keeping what you typed in the box to fix, and leaving the agent on its
  previous jail rather than pointing it at a path that will fail on the next call.
- **The Browser screen's right rail was being squashed, not scrolled.** In mobile
  view (and in any short window) `.bs-side` is a `flex` column with a `max-height`
  and `overflow-y: auto`. A `<textarea>` has no intrinsic minimum height, so flex
  shrank the text boxes to fit instead of letting the rail scroll: measured on a
  390×844 viewport, the **type box was 14px tall with 46px of content** and the
  **block list was 14px with 74px**, so their text drew over the rows beneath them
  — "Block list" on top of "Save block list", "Drive it" on top of "Send text".
  The rail's children now refuse to shrink (`flex: 0 0 auto`), which turns the
  same overflow into ordinary scrolling; the read-text pane is restated as the one
  child that should still absorb leftover height, so the desktop rail looks
  exactly as it did (verified at 1400×900: 355px tall, rail not scrolling).

## 🗂️ The checkout moved to the app root — and Apache was serving `.git` *(Apache + tests + docs — `VERSION` 350, cache-buster unchanged)*

- **What changed.** `git` now lives in the project root, which is also the web
  root. Before this the repository sat one folder down, inside `cleancopy/`, and
  every change had to be mirrored into that copy before it could be pushed — a
  manual step with no feedback, and the only way it fails is silently.
- **The consequence nobody asked about.** Putting `.git/` behind the same URL
  prefix as the app puts the whole history on the web. `.git/config` can carry a
  remote URL with a token in it, and `.git/objects` reconstructs **every file ever
  committed** — including one removed later *because* it held a secret.
  `serve.php` and `nginx.example.conf` have always refused dotfiles; Apache's own
  `.ht*` default does not cover them, and it answered `.git/config` with a **200**
  and the real `[core]` body. Measured before the fix, not assumed from the docs.
- **The fix is one rule, in the mode that lacked it.** The root `.htaccess` now
  refuses any path segment starting with a dot, at any depth, in both layers it
  already uses (mod_rewrite and `RedirectMatch`, so neither a nested `.htaccess`
  nor a host without mod_alias can slip past). `/.well-known` is the one
  exception, matched by name, because refusing it breaks ACME renewal.
- **`.gitignore` grew teeth.** With the repo in the root, one `git add -A` was
  enough to commit `Autonomous.zip` (220 MB), `storage/config.json.bak` — the
  access token and every provider key, under a filename the old rules did not
  match — the update feature's working folder (`storage/updates/`, a cached answer
  and a full staged copy of the app), and two complete extra copies of the app.
- **Verified.** `apacheGuards.test.php` gained assertions over `.git/config`,
  `.git/HEAD`, `.git/objects/pack/`, a nested `.git`, and the ACME exception:
  **11 assertions fail** when the new rule is removed, and all 62 pass with it.
  `serve.php` and nginx already had the policy *and* the tests, which is why only
  Apache needed a change.
- **Cache-buster:** unchanged at `v348` — no browser file moved this time.

---

## 🔎 "What's new" opens: the release note is readable *(PHP + UI — `VERSION` 349, cache-buster v348)*

- **What it does.** **Config → Updates** used to show a release title and one
  trimmed line of its CHANGELOG entry — *"What's new:"* plus an opening
  sentence, and the rest of the entry was not read at all. That row is now a
  **disclosure**: closed it still says what shipped, and opened it lists the
  entry's own lines — every bullet, each with its bold lead-in and its wrapped
  text, sub-points indented.
- **One pass, not two.** The parser returns the whole entry (`items`, each with
  `lead` / `body` / `depth`) alongside the one-line `summary` the bell uses, both
  built in the same walk — so what you expand can never disagree with what you
  clicked. `changelogHead()` stays a two-key wrapper, so every existing caller
  and assertion kept its contract.
- **The collapsed line nearly vanished.** A closed `<details>` renders *none* of
  its children but the `<summary>`, so the trimmed opening line, sitting next to
  the details, disappeared at exactly the moment it was the only thing worth
  reading. It lives inside the `<summary>` now, and hides only once open, since
  the first bullet is that same sentence without the cut. Found by looking at the
  panel, not by reasoning about it.
- **Bounded anyway.** This text arrives over the network, so an entry is capped at
  **60 lines / 4000 characters** and the expanded body scrolls in place rather
  than pushing DOWNLOAD UPDATE out of reach. When a cap bites, the view says the
  entry is not shown in full instead of pretending it ended.
- **Still text, never markup.** Every line is placed as a text node with the
  lead-in bolded by a real `<b>`, so a changelog title cannot become HTML. The
  same holds for the trim: only the ellipsis is added, never the remote text.
- **Cache-buster:** `v347` → `v348` (both UI files changed); `VERSION` → `349`.
- **Tests:** `tests/php/update.test.php` 112 → **129** assertions — whole-entry
  parsing, lead/body split, sub-bullet depth, both caps, blank-line vs wrapped
  line, non-UTF-8 refusal, and the two-key `changelogHead` contract. Eight
  mutations of the new parser were run and all eight were caught.

---

## 📰 The update notice names what shipped *(PHP + UI — `VERSION` 348, cache-buster v347)*

- **What it does.** When the check finds a newer release it now also reads the
  **top entry of the published `CHANGELOG.md`** and puts its title in the
  notification: *"Update available — published v348 · RELEASING.md: the
  two-number checklist. This copy is v347."* **Config → Updates** keeps a
  *What's new:* line with the entry's opening paragraph.
- **Asked for only when it is needed.** The CHANGELOG is the largest file in the
  repo (six figures of bytes and growing), so it is fetched **only when an
  update exists** — while the two copies match, every byte of it would be
  wasted. The transfer is capped at 64 KB and stopped early, because only the
  newest entry matters and it is at the top; that abort is expected and handled,
  not treated as a failure.
- **A failure there cannot fail the check.** A release that cannot be *named* is
  still a release: an unreachable or unparseable CHANGELOG returns null and the
  notification falls back to naming the versions alone.
- **Remote text is treated as text.** The title is escaped before it reaches the
  panel and built as a DOM node in the bell, so a `<img onerror=…>` planted in
  a changelog title is displayed rather than executed — checked in the browser,
  not assumed.
- **Two real bugs, and two tests that could not fail.** The summary ran on
  through every bullet of the entry (entries are a bullet list with NO blank
  line between bullets, so "stop at the first blank line" produced
  "… - **What.** …"), and the UTF-8 guard never actually ran because the
  invalid bytes were being dropped by a failing regex first. Mutation testing
  then showed the truncation fixtures were **even-split** — a byte-counted cut
  landed on a character boundary and looked identical to a correct one — and
  the emphasis check looked for `**` while the italic rule had already eaten one
  of the two stars. All four are fixed and now fail as intended.
- **Cache-buster:** `v346` → `v347` (both UI files changed); `VERSION` → `348`.
- **Tests:** `tests/php/update.test.php` 94 → 112 assertions, and all seven
  mutations of the new reader are caught by it.

---

## 📋 RELEASING.md: the two-number checklist *(docs — no cache-buster bump)*

- **Why.** Two numbers now decide whether a running copy sees a new release,
  and the failure mode is a release that bumps one and forgets the other — which
  is quiet: a missed `VERSION` hides the release entirely, and a missed
  cache-buster serves a new module next to an old one in the browser.
- **What.** `RELEASING.md` says which number to bump when, gives the exact
  commands for the **three** places `APP_VERSION` has to change together, and
  states the one caveat: a copy that predates `VERSION` can only see the
  cache-buster, so a release that has to reach those copies needs that bump too.
- **Cache-buster: `v346`, NOT bumped.** No browser-cached file changed, which is
  exactly the distinction this split exists to make — and this is the first
  release to exercise it: `VERSION` moved to `347` on its own.
- **Nothing else changed.** Pointers added from `VERSION` itself, the README
  table of contents, and the README's Tests section, so the checklist is
  reachable from the places the numbers actually live.

---

## 🏷️ VERSION: a release number the update check reads too *(PHP + cache-buster — v345 → v346)*

- **Why.** The load-time check compared exactly one thing: `APP_VERSION`, the
  browser cache-buster. That number correctly does **not** move when a release
  changes no browser-cached file — so a PHP-only (or docs-only) release was
  invisible, and the check reported *"up to date"* for a release that had shipped.
- **What.** A `VERSION` file at the repo root carries the *release* number, and
  the check reads **both** signals from the published copy, announcing a release
  when **either** is newer. The rule: bump `VERSION` on every release; bump
  `APP_VERSION` when a file the browser caches changes. `VERSION` is the file that
  says *"something shipped"*, including when the browser files are untouched.
- **Rules the code enforces.** A plain integer — a dotted date could never compare
  as newer, because the comparison is numeric — and never behind `APP_VERSION`;
  `tests/php/update.test.php` fails if it is, so a release cannot quietly make
  itself invisible again.
- **Backward compatible, both directions.** A published copy with no `VERSION`
  yet is judged on its cache-buster alone, and a `check.json` written before this
  change is still read (its `remoteVersion` *was* the cache-buster). Both were
  verified against the real published repo, which has no `VERSION` yet:
  `ok: true`, `remoteRelease: null`, `remoteApp: 337`.
- **Cache-buster:** `v345` → `v346`, even though no browser-cached file changed.
  Deliberate, once: an install that predates `VERSION` can only ever see the
  cache-buster, and this is the release that introduces `VERSION` — so bumping it
  here is what makes THIS release visible to those installs instead of shipping
  it silently. From the next release on, `VERSION` alone is enough and a PHP-only
  release needs no bump here at all.
- **Tests:** `tests/php/update.test.php` went from 71 to 94 assertions, and eight
  mutations of the new logic were each caught by them (either signal dropped,
  comment skipping, first-line parsing, the old cache shape, the drift guard).

---

## 🔔 Update check at load, with a notification *(PHP + UI — v344 → v345)*

- **What it does.** Every page load now asks the server whether a *newer* release
  is published, and puts the answer in the notification bell. Config → Updates
  gains **Check for updates when the app loads** (on by default), **CHECK NOW**,
  and a one-line answer under them.
- **Cheap on purpose.** The check is not the 11 MB download: it reads the
  published `ui/js/store.js` (a few KB) and compares `APP_VERSION`. The server
  caches the answer for **six hours**, so a reload is usually one local request
  and no network at all. Forcing it is a `POST`.
- **Silent on failure.** Offline, behind a proxy, or on a PHP without curl, the
  check returns `ok: false` **instead of throwing** — it runs at boot, so it must
  never block it. Failures are cached for 15 minutes rather than six hours, so an
  offline machine does not pay a connect timeout on every reload, and an unknown
  version is never read as "you are out of date".
- **Announced once per version.** The version already announced is remembered,
  so the same release cannot fill the bell on every reload; a *newer* release
  re-notifies. Both numbers are shown, because the published copy can be behind a
  local one — "v345 → v337" would read as an upgrade that moves you backwards.
- **Both bugs found while building it, and what they were.** (1) `store.set` is
  memory-only in this app; a toggle wired with it alone flips, toasts, and is
  forgotten by the next load. The switch uses the shared `_initToggle`, which
  persists the settings blob. (2) The "announced" marker had the same problem,
  which would have re-notified on every load — it now persists too.
- **Cache-buster:** `v345`. Tests: `tests/php/update.test.php` (version parsing,
  the numeric compare in both directions, and every cache-expiry rule) and five
  cases in `tests/php/guards.test.php` for the new `storage/updates/*` files
  being refused over HTTP.

---

## 📥 Updates: download, verify and diff a release — without installing it *(PHP + UI — v342 → v344)*

- **What it does.** Config → Updates → **DOWNLOAD UPDATE…** fetches the
  published archive into `storage/updates/`, verifies it, extracts a staging copy
  and returns a plan: new / changed / unchanged / not-in-release, the version each
  side calls itself, archive size and SHA-256. **DISCARD** removes the lot.
- **There is no apply path.** Not in the UI, not in the API. `POST
  /api/update/download` writes only inside `storage/updates/`; the app tree is
  read-only input to the diff.
- **The bug this feature is defined by.** The published repo **ships a
  `storage/` folder** (a default config and empty logs), so "replace the folder"
  would overwrite the operator's config, token and provider keys with defaults.
  The first implementation *looked* right and was not: GitHub wraps every entry in
  `Autonomous-master/`, so `Autonomous-master/storage/config.json` never matched
  the "skip storage" rule, was staged, and got diffed against the real config.
  Caught by listing the staging tree after a real download. Fixed by stripping the
  wrapper prefix **before** the rule runs, plus a hard refusal if a staged
  `storage/` ever appears. `tests/php/update.test.php` pins both.
- **Verification is not decorative.** https only, GitHub release hosts only
  (checked before the request *and* on the final URL after redirects), credentials
  and non-443 ports refused, 64 MB and 20 000-entry caps, and every entry name
  resolved by hand — `..`, absolute paths, drive letters and `stream://` wrappers
  are refused; each write is re-checked to be inside the staging folder.
- **Diff honesty.** Data folders (`screenshots/`, `sandbox/`) are excluded from the
  comparison entirely; files on disk the release lacks are listed as *not in this
  release* and never called deletions; and a copy that is **ahead** of the
  published version says so ("downloading it would take you backwards") instead of
  implying an upgrade.
- **No ZipArchive here.** Stock XAMPP does not enable it, so archives are read
  through PharData, which is compiled in; ZipArchive is still preferred when
  present. That difference is why the extraction path has two readers.
- **Tests:** new `tests/php/update.test.php` — 45 assertions covering entry-name
  refusals, wrapper stripping before the storage rule, diff classification,
  data-folder exclusion, and the source guard. Suite: **10 files / 447 assertions**
  (was 9 / 402). README gained an Updates section, its TOC entry and the API rows.
- **Cache-buster:** `v344`.

---

## 🧪 The layer ladder is now enforced by a test *(tests only — still v341)*

- **New `tests/php/layers.test.php`.** It parses every `z-index` in `ui/css/*.css`
  with a real bracket/selector walker (grouped selectors and `@media` blocks
  included — a "match up to the brace" regex gets both wrong, and getting them
  wrong is how an audit quietly passes), then the literals set from `ui/js` and
  the inline ones in `index.html`, and fails if any **surface** ties or outranks
  the dialog layer.
- **Notices are exempt by name, with a reason**, never by a threshold: the fatal
  banner, the boot watchdog strip, `?debug=1` HUD, the boot splash, the CRT
  scanline overlay, toasts and the approval veil. A separate assertion fails if a
  listed notice has drifted *below* dialogs, so the exemption list cannot rot into
  a pile of stale names that hides a future regression.
- **Nothing is hardcoded that the code already states.** The dialog number is read
  from the `.modal-bg`/`.modal-overlay` rule, and the ladder comment in
  `modals.css` is checked against it, so moving the layer without updating the note
  fails the build rather than the next reader.
- **The surfaces that broke once are asserted by name** — Browser pane, API Lab
  drawer, terminal panel, notif dropdown, the floated agent menu, the 3D label
  base — so a regression reports *which* one came back, not "something did".
- **Mutation-tested, because a guard that cannot fail is decoration.** Four changes
  were applied and reverted: `.browser-screen` to 1400 → *"the built-in Browser pane
  sits below dialogs (z=1400 vs 1300)"*; the menu back to 3000 → *"the floated agent
  menu stays under dialogs (z=3000)"*; `.notif-dropdown` (inside `@media`) to 1500
  → caught with its media query named; a brand-new `.new-floating-thing` at 2000 →
  caught as an undeclared surface. All four exited `1`; the clean tree exits `0`.
- **Suite:** 9 PHP files, **402 assertions**, 0 failed (was 8 files / 384).
  `README.md`'s test table now names the audit.

---

## 🔍 z-index audit — nothing but notices outranks a dialog now *(CSS + 1 JS line — v340 → v341)*

- **Method.** Every `z-index` in `ui/css/*.css`, plus every one set from JS or an
  inline attribute, was listed; the ones at or above the dialog layer were then
  checked for being body-mounted (a number inside a lower stacking context cannot
  outrank anything) and for actually rendering.

  | z | surface | verdict |
  |---|---|---|
  | 99999 | boot-watchdog strip (`index.html`), `#bootError` (`app.js`) | notice, only when boot fails |
  | 60000 | `.api-locked-banner` | notice, only on a 401 |
  | 9999 | `.app-loader`, `body::after` scanlines (`pointer-events: none`) | boot / decoration |
  | 2000 | `.toast-container`, `.approve-veil` | above dialogs on purpose |
  | **1300** | **`.modal-bg`, `.modal-overlay`** | **dialogs** |
  | 1250 | `.browser-screen` | below dialogs, correct |
  | 1200 | `.lab-drawer` | below dialogs, correct |
  | 1000 | `.notif-dropdown` (`!important`, <=1024px) | below dialogs, correct |
  | **3000 → 1000** | **agent/provider .agent-menu clone** | **was the one violation — fixed** |

- **The violation.** `sidebar.js` clones a card's `.agent-menu` onto `<body>` so it
  can escape the card's `overflow`, and stamped it `z-index: 3000`. Body-level, so
  that number competed with dialogs *directly*: with a menu open, a dialog (1300)
  and even the approval veil (2000) could be painted over by a menu that was
  already on screen. It is now 1000 — the documented menus layer, still above the
  cards (40), the chart drawer (950) and the terminal (100).
- **Verified by A/B on the live page.** A menu clone overlapping an open dialog is
  hit at `1000` and `3000`: at 1000 the probe returns dialog content, at 3000 it
  returns `agent-menu`. With nothing open the real menu still receives clicks
  (`agent-menu-item`), so the fix costs no interactivity.
- **Stacking-context check.** All ten modal constructors mount on
  `document.body` (brainlab ×2, agentEditor ×3, export, metricsPanel,
  providerEditor, sidebar ×2, tracePanel), so 1300 always competes at the root and
  no dialog is trapped beneath a lower context.
- **Deliberately unchanged:** the notices above (a fatal banner or an approval must
  be seen), and the 3D labels' per-frame 1000, which lives inside the chart
  container and never reaches a dialog's pixels.
- **Cache-buster:** `v341`.

---

## 🗂️ Dialogs now sit above every app surface *(CSS only — v339 → v340)*

- **The terminal was a false alarm.** Measured rather than eyeballed:
  `.terminal-panel` is `z-index: 100`, `.modal-bg` is 1000, and a hit test in the
  region where they overlap returns dialog content. What looked like the terminal
  drawing *over* the dialog was the terminal behind it, dimmed by the overlay.
- **Two steps up the ladder, it really was broken.** `.browser-screen` (1250) and
  `.lab-drawer` (1200) both outranked dialogs at 1000, and `.notif-dropdown` tied
  with them at 1000 with `!important` (DOM order deciding) on narrow windows. Open
  the built-in Browser pane and then Config: the dialog painted underneath the
  pane, so the click read as dead rather than covered.
- **Dialogs moved to 1300**, between the app surfaces and the notice layer, and the
  whole ladder is now written down in `modals.css`: 100 floating panels · 1000
  menus/dropdowns · 1200 API Lab drawer · 1250 Browser pane · **1300 dialogs** ·
  2000 toasts + approval veil · 60000 API-locked banner. Approvals stay above
  dialogs deliberately — a blocking prompt has to be visible even over one.
- **Verified by A/B hit test on the live page.** With a dialog open over a visible
  Browser pane, probing a point both cover returned `bsImg` (pane content) at the
  old 1000 and dialog content at 1300. The earlier terminal overlap returns dialog
  content at both values, which is what ruled the report out.
- **Cache-buster:** `v340`.

---

## 🧹 Section 3 of Allow / Deny stops overlapping *(CSS only — v338 → v339)*

- **What was wrong.** The interpreters block was a 3-up
  `repeat(auto-fill, minmax(190px, 1fr))` grid, but each `.interp-row` inside it
  spends `82px + 132px` plus two 8px gaps *before* the description gets a single
  pixel. At the modal's width a cell was ~212px, so every row was wider than the
  cell containing it: the next column's interpreter name and picker printed
  straight over it, and the overflow widened the modal body enough to put a
  horizontal scrollbar across the whole panel.
- **The fix.** `grid-template-columns: minmax(0, 1fr)` — one full-width row per
  interpreter. Ten rows, so the card grid bought nothing; the description column
  went from 0px to ~400px, which is what makes "scripts only vs full access"
  legible in the first place. Added `min-width: 0` on the row's children and
  `overflow-wrap: anywhere` on the description, because grid children default to
  `min-width: auto` and one long unbroken token would have re-created the same
  overflow. The existing ≤560px stacking rule now uses `minmax(0, 1fr)` too.
- **Verified on the live panel**, not just in CSS: modal body `scrollWidth ===
  clientWidth` (643px), zero rows whose content exceeds their box, description
  column 401px, and no horizontal scrollbar in the screenshot.
- **Cache-buster:** `v339` (root shell + `ui/`), since the fix lives in
  `components.css`.

---

## ↩️ Denials now show their own undo path *(PHP + UI — v337 → v338)*

- **The problem was legibility, not policy.** A refused command said *"is on the
  command denylist and cannot be approved"* and pointed at an "Allow/Deny list"
  that is actually called **Shell access**. Nothing said the name could be
  removed, or which box to remove it from — so a list you own read as a wall.
- **The refusal carries the fix.** It now names the program, says the list is
  yours rather than a rule in code, and gives the exact path: *delete the
  `explorer` line under Config → Shell access → Allow / Deny (section 4), add it
  to section 2.* The model relays it verbatim, so the person who can edit the
  list does not have to go looking.
- **Section 4 of the panel stopped calling itself absolute.** It now says the
  list wins over the allowlist *and* approvals (unchanged behaviour) while
  stating plainly that it is not permanent, and the hint under the box always
  explains how to un-deny a line.
- **New: Restore built-in defaults.** `execAllowListPublic()` now sends
  `deny_defaults` — the shipped list — *even when a custom list is active*.
  Previously, once you replaced the defaults you could not see what you had
  replaced without opening `config.json`, so "put it back" was effectively a
  reinstall. The button loads the shipped list into the box; Save still applies it.
- **An empty box is not "deny nothing".** It falls back to the built-in defaults,
  deliberately — otherwise clearing the field would silently un-deny `rm`,
  `sudo` and the Windows hosts in one click. The hint says so and names the real
  escape hatch, `"exec_deny": []` in `storage/config.json`.
- **Tests:** 3 more assertions in `tests/php/sandbox.test.php` — the refusal text
  must name the undo path and the reason approval can't override it; policy info
  must expose the built-in defaults while a custom list is active; and an
  explicit empty array must deny *nothing* (so the hint's advice is true).
  Suite: **97 passed, 0 failed**.
- **Cache-buster:** `v338` across `ui/` (52 files) **and the served root
  `index.html`** (19 links) — the panel lives in `sidebar.js`, so a stale cache
  would hide the button. The root shell is the one `/` actually serves; bumping
  only `ui/` left the browser asking for `?v=337` and quietly running the old
  file.

---

## 🛡️ Windows command hosts closed in the default denylist *(PHP only — v337)*

- **The gap.** The denylist named `bash`, `sh`, `python`, `node` and friends — but
  policy compared the **literal** program name, so `bash.exe` (the WSL launcher)
  matched nothing. Worse, `cmd` and `powershell` were on *neither* list: an
  "Always allow" on one careless approval handed back a permanent shell, with the
  payload hidden inside an argument where the allowlist, the path guard and the
  jail cannot see it.
- **The fix is one normalisation.** New `Sandbox::policyName()` folds case and
  drops a trailing `.exe`/`.com`, and `inPolicyList()` compares through it. Every
  decision now goes through that pair — allowlist, denylist, both interpreter
  levels, the approval grants and the per-command path table — so one entry
  covers both spellings **in both directions**: `grep` matches the `grep.exe` Git
  for Windows ships, and `bash` finally stops `bash.exe`.
- **New default denials (all removable):** `cmd`, `powershell`, `pwsh`,
  `wscript`, `cscript`, `mshta`, `rundll32`, `regsvr32`, `msiexec`, `wmic`,
  `schtasks`, `sc`, `reg`, `regedit`, `explorer`. Scheduled/service execution and
  registry writes are here for the same reason `crontab` and `at` already were:
  they outlive the session. `explorer` is a launcher, not just a file manager
  (`explorer thing.exe` runs it).
- **Nothing is permanent, by design.** These are *defaults*. An explicit
  `sandbox.exec_deny` replaces the defaults wholesale, the list is editable in
  **Config → Shell access**, and removing a name makes that command ordinary
  again — refused as "not allowed" and back in the approval queue. No program is
  refused by name anywhere in the code, and README §3 no longer claims otherwise.
- **Your own install was not covered by the code alone.** A config that has ever
  saved its list keeps its own copy, so the 15 names were appended to the live
  `storage/config.json` (86 → 101 entries, order preserved, backup written to
  `storage/config.json.bak`). Nothing was added to any allowlist, and **shell
  access stays off** — this changes what happens the day it is switched on, not
  what happens today.
- **Tests:** `tests/php/sandbox.test.php` gains 20 assertions — every host refused
  by default in either spelling (`CMD.EXE`, `PowerShell.EXE`), `echo.exe` still
  reaching the allowlisted `echo`, and the one that matters most: with a deny list
  that omits `cmd`, `cmd` is ordinary again. Full suite: **94 passed, 0 failed**.

---

## 📸 README rebuilt around the two interfaces *(docs only — still v337)*

- **The README now opens on the new UI.** `screenshots/new-ui-main.png` is the
  hero, captioned as **Desktop 2026**; `screenshots/mainscreen01.png` follows
  immediately as **Classic**, stated plainly to be **the default** and not a
  legacy mode. Both are 1920×1080 and referenced relatively, so they render on
  GitHub exactly as they do locally.
- **Two new sections.** *Two interfaces, one switch* compares the shells row by
  row with a layout sketch, and *Config → Desktop — the machine-room card* uses
  `screenshots/desktop-settings.png` to walk every knob: a relative-cost ladder
  (blur > detail > bloom > floor > fps > glow/motion > rotate), what the
  performance preset writes and how it restores, and a full topography
  explanation — the screen-space haze (v336), the pinned floor, why map detail is
  manual now (the three-or-four "flashes" that used to degrade the lines), the
  frame cap, idle auto-rotate — ending with a defaults table for Desktop, Labs
  and Resource Manager.
- **Security grew real detail.** §16 is now a **path × serving-mode matrix**
  (`serve.php` / Apache / nginx / IIS) covering any-depth paths, case variants,
  dotfiles, loose data files, the `/api/*` exemption and lookalike names, plus
  *why* the nested-copy case exists and why Apache needs `RedirectMatch` where a
  `RewriteRule` is silently replaced by the child `.htaccess`. New **§17** lists
  the tests that request each path for real, and new **§18** documents the closed
  browser-side defaults: no CORS wildcard (with `ROUTER_CORS_ORIGINS` as the
  opt-in), the three security headers, and the `no-store` / `no-cache` policy.
- **Corrected while passing through:** the API-pool default is **ON** (§14 and
  the API-pool section — it stays inert without pool keys), the Config section
  list now matches the app (Interface · Limits & Budgets · Permissions · Labs ·
  Resource Manager · Throttle / Limiter · MCP Client · MCP Server + Desktop), the
  IIS snippet blocks all five names, `mcpStdio` is in the tree, the defaults are
  stated once and pointed at from elsewhere, and the clean-copy section is gone —
  the published repo *is* that copy, so a section describing a nested folder was
  pointing at a door that isn't there. A **contents list** at the top links every
  section (and all eighteen security subsections) straight to its heading.

---

## v337 — shipped defaults for a weak GPU, and a genuinely clean copy

- **The Desktop card now opens the way a low-powered machine wants it.** These
  are the defaults a fresh install starts from; anything already saved in
  `storage/state.json` is untouched, so an existing install keeps its own values
  until a control is moved. Chat background **4%** (`d26ChatAlpha` 0.72 → 0.04),
  glass blur **1px** (`d26Blur` 10 → 1), floor **pinned** (`topoFloorFixed` false
  → true). Already at the requested end and left alone: tuck panels away **on**,
  background fog **on**, bloom **on**, floating floor **on**, slow auto-rotate
  **on**, glow and ambient motion **100%**, map detail **100%**, frame cap **60**,
  performance mode **off**. The blur slider is pixels (0-24), not per cent, so
  "2%" is half a pixel: 1px is the nearest whole step that still frosts rather
  than switching the glass off. `desktop2026.css`'s `--d26-chat-alpha` /
  `--d26-blur` fallbacks were brought to the same values so the first paint
  matches what JS then sets.
- **Labs:** API pool is now **on** by default (it only engages for a provider that
  actually carries pool keys — `pickKey` returns null with an empty pool, so the
  single provider key is used exactly as before), Dynamic tools **on**, Remember
  the working dialect **on**, Keep Live running when hidden **on**, and the
  built-in Browser **off** (already the server-side default: `browser.enabled`
  absent or false). Resource Manager was already **all four switches off**; that
  is unchanged and now covered by the defaults check in the clean copy.
- **`cleancopy/` is now a clean, runnable copy of the current app.** It carries no
  access token, no provider keys, no MCP servers, no saved state, no session
  transcripts, no exec/MCP logs, no approvals file, no browser profile and no
  `.htpasswd` — and it ships `storage/models.json` with the three hard-coded
  model templates (ChatGPT-4 / Claude 3.5 / Gemini 2.0, endpoints intact,
  `api_key` empty) plus `storage/.htaccess`, so it starts from a first-run state
  that the app fills in itself. The reference archive, `Autonomous.zip`, the
  editor folders and the handover notes are not part of it; its `.git` (the clone
  of the upstream repo — the working folder has none) is preserved.
- **`apacheGuards.test.php` could 500 on any nested checkout.** Apache reads
  `.htaccess` files **above** DocumentRoot too, so a copy of the app sitting
  *inside* another copy had the parent's file parsed as server config, where its
  `<IfModule>` is illegal: `C:/…/router/.htaccess: <IfModule not allowed here`,
  and every request in the document root answered 500 — 19 red assertions that
  said nothing about the copy. The generated config now pins every ancestor of
  the document root to `AllowOverride None`, so only the shipped `.htaccess`
  files (root, `storage/`, `tests/`) are under test. Proof: nested copy before the
  fix `19 failed, 16 passed`; after, `35 passed, 0 failed` (the archive-specific
  assertions skip, since the archive is not shipped); the main tree still
  `50 passed, 0 failed`.
- **Version** bumped to v337 in `store.js` (`APP_VERSION`) and every `?v=` in
  `index.html` and `ui/index.html`.

---

## v336 — the background fog stops travelling with the map

- **The haze was a fog effect, not a backdrop.** `scene.fog` was active with
  `fog.mode = 'bg'` and the scene background was a `HAZE → SPACE` gradient texture
  whose vertical span was the map's own extent (`minY … maxY`). Fog is painted in
  the map's eye space, so orbiting, zooming or dragging the chart carried the haze
  along with the nodes it surrounded — and because the gradient was anchored to the
  picture, it only ever covered the slice of the window the map happened to fill.
- **The backdrop now paints itself, in screen space.** `scene.background` is a
  `_skyTexture()` sized to the renderer (the same 512 px radial gradient, same six
  stops — clear near the grid at the bottom, ~0.5 alpha at the top edge, darker than
  the fog's old `fogColor` so the bottom keeps its contrast), and `scene.fog` is
  `null` so nothing can smear it again. Background quads are drawn by the renderer
  before any scene content and never move with the camera, so the haze reaches the
  top of the viewport at every angle and never drifts.
- **Nothing else changed.** The gradient's stops are untouched (same sizes, same
  falloff), `fog: false` on the ground haze keeps it out of the removed fog's reach,
  and **Background Only** still fills the window; turning fog off still gives a flat
  `SPACE` colour, **Background + floor** still fogs the floor.
- **Measured in the running app** (1400×900, real WebGL, left edge of the canvas to
  stay clear of nodes): fog on, top-of-viewport pixel `rgb(20, 47, 72)`, 75% height
  `rgb(19, 43, 67)`, bottom `rgb(4, 7, 12)` — the fade into the grid survives. After
  a 49° orbit the top and 75% pixels are **byte-identical** while an off-centre world
  point moved from NDC `(0.855, 0.104)` to `(0, −0.063)`, i.e. the view really
  changed and the haze did not. Fog off → every sample is `rgb(4, 7, 12)` and the
  background is a plain `Color`, so the toggle is intact.

---

## v335 — the Config tab stops locking the page up, and the guard stops eating /api/sessions

- **A childList observer that fed itself.** `syncDesktopConfig()` was called from
  the sidebar's mutation observer and always ran `syncSkinOnly()` →
  `syncFloorControls()`, which assigned `out.textContent = …`. Assigning
  `textContent` replaces a text node, which is a childList mutation, so the
  observer fired again on its own write — forever. With the Config tab open, any
  sidebar mutation (the Resource Manager CPU readout ticks ~3.5×/s) started an
  endless loop and Chrome killed the page: *Script terminated by timeout at
  syncSkinOnly … syncDesktopConfig … MutationCallback*.
- **Fixed at the source, twice over.** The observer now returns immediately when
  the Desktop card is already in place — it does no work, so it cannot re-enter —
  and `syncDesktopConfig()` on its own only injects a missing card. The floor label
  is written only when the string actually changes, so no future caller can feed a
  mutation back into the same observer. `sync()` now calls `syncSkinOnly()`
  explicitly, since the observer no longer does it for free.
- **Measured after the fix:** two seconds idle on the Config tab produce only the
  Resource Manager readout mutations (`rmValCpu`, `sbRmReadout`), the Desktop card
  is the same DOM node throughout, and both shell switches, the floor-fix label
  and narrow/wide transitions still work. The page stays responsive.
- **The any-depth guard was refusing `/api/sessions`.** That path is the session
  LIST, not the storage folder: `serve.php` answered 403 with its `Forbidden` page,
  the API client could not parse it, and the sidebar reported *API 403: the server
  sent a web page instead of JSON*. The nginx rule and the Apache `RedirectMatch`
  had the same collision. In all three modes the segment rule now skips the API
  namespace — `$isApiRoute` in `serve.php`, a `(?!api/)` lookahead in
  `nginx.example.conf` and in the root `.htaccess` — because API routes are
  endpoints, not files: the handlers open `storage/` themselves, server-side.
- Each mode has a test that would have caught it: `guards.test.php` asserts
  `/api`, `/api/sessions`, `/api/config` and `/api/state` are never refused and are
  never answered with the guard page (86 assertions), `nginxGuards.test.php` lists
  three API routes as must-serve (58), and `apacheGuards.test.php` asserts three
  API paths are not 403 (50).

---

## v335 — the interface is a choice again: Classic by default, Desktop 2026 on request

- **Two shells, one switch.** Config → Interface now carries an **Interface**
  picker. **Classic** is the default and is the layout from before the desktop
  refresh: the left setup panel, the chat and the right map/network panel side by
  side, with nothing tucked away. **Desktop 2026** is the glass shell that used to
  arrive on its own at 1025px — floating cards on a rail, Config in drawers that
  fly out of their labels, a wider chat.
- **Silence means Classic.** The rule lives in the new `ui/js/ifaceMode.js`: any
  value that is not an explicit `desktop` — absent, empty, stale, misspelled —
  resolves to Classic. A fresh install and every existing profile therefore start
  Classic on the next load, with nothing migrated and no setting rewritten behind
  the operator.
- **Width still decides for itself.** Below 1025px both shells hand over to the
  same slide-over drawer layout that `layout.css` owns alone, so the switch can
  only ever put the glass on a window wide enough to hold it. The phone view is
  untouched in either mode.
- **No reload, nothing lost.** Changing the picker applies at once (the skin
  listens for the change) and is written through immediately, so it survives a
  reload even if SAVE is never pressed. Every feature works in both shells — map
  detail, floor pinning, the performance preset, the `/` palette, the streaming
  fixes; only the glass goes away.
- **The Desktop card now exists in both shells.** It used to be injected by the
  skin, so choosing Classic would have removed the only controls for map detail,
  FPS, fog, bloom, floor pinning and performance mode. It is kept in the Config
  tab in either mode; the six rows that address the glass itself (panel tucking,
  chat background, glass blur, glow, ambient motion, floating floor) stay visible
  with their saved values and are disabled in Classic, under a line that says so.
- **The floating floor can no longer leave Classic mapless.** With the shell off
  there is no injected floor layer, so `applyFloor()` no longer hides the scene's
  own polar grid in favour of one that is not there: Classic always draws its
  grid, and *Fix the floor in place* is enabled there (it holds that grid) rather
  than being disabled by a floating-floor setting Classic does not have.
- Covered by `tests/js/ifaceMode.test.mjs` (37 assertions: the default, every
  spelling that must not upgrade the shell, and the narrow-window rule). The
  archive at `the-copy-before-the-huge-ui-change/` was used only to confirm the
  change was additive — `layout.css`, `chat.css` and `base.css` are identical
  there, so Classic needs no duplicated front end. It is not a second copy of the
  app: nothing loads from it, and it is 588 MB including its own `storage/`.
- **The `storage`/`tests` refusal now holds at any depth.** Verified while
  adding the archive: `serve.php` only checked the root of the path, so
  `/the-copy-before-the-huge-ui-change/storage/config.json` came back **200**
  with the old config (token and keys) while `/storage/config.json` was 403. The
  router now refuses those names as any path segment, case-insensitively, and
  `guards.test.php` has four nested cases (`/a-copy-of-the-app/storage/config.json`,
  a nested case variant, a nested transcript, nested dev tooling) so it cannot
  slide back. App files inside a nested copy are still served — only the data
  folders are refused.
- **The same hole in `nginx.example.conf`, closed the same way.** Its rules
  anchored on `^/router/(storage|logs|tmp|sessions|tests)/`, so only the app's own
  folders were guarded: a nested copy's bare `storage/`, and the extension-less
  files under it (`storage/browser-profile/` — the Chromium cookie jar), were
  readable. Its `.json/.log/.ini` files were already caught by the loose-data rule,
  which is why this narrower hole went unnoticed. The two folder rules are now one
  case-insensitive rule matching those names as any path segment —
  `^/router/(.+/)?(storage|logs|tmp|sessions|tests)(/|$)` — which also covers the
  bare folder with or without a trailing slash (the old pair needed 1b for that).
  `tests/php/nginxGuards.test.php` now pins it: it lifts the regexes out of the
  shipped file and runs them through PCRE (the engine nginx itself uses, so no
  nginx binary is needed): 37 refused URIs, a real session transcript too when one
  exists, and 15 that must still be served — including `ui/js/storage.js`,
  `ui/js/tests.js`, `mytests/run.mjs`, `storagelike/` and the `/.well-known/` ACME
  exception. Put the old anchored rule  back and 7 of them fail, including the bare nested folder and nested tooling; the
  file was restored byte-identically (sha256 checked) and all 55 pass again.
- **Apache had the same gap, and it was the worst of the three.** Booting the
  local XAMPP Apache (2.4.58) with this project as DocumentRoot and
  `AllowOverride All`, the archive's `storage/` was refused by its own
  `storage/.htaccess` — but `…/the-copy-before-the-huge-ui-change/tests/php/sandbox.test.php`
  came back **200, in full, PHP source included**, and `tests/js/context.test.mjs`
  returned its `import` lines. That copy predates `tests/.htaccess`, and the app
  root `.htaccess` had no path rule at all.
- **A root `RewriteRule` does not fix it.** Verified with a rewrite trace: once a
  request maps into the copy's directory, its own root `.htaccess` takes over and
  the parent's rewrite rules are skipped (per-directory rewrites are not inherited
  without `RewriteOptions Inherit`). mod_alias config IS merged normally, so the
  root `.htaccess` now carries `RedirectMatch 403 (?i)^/(?:.*/)?(?:storage|logs|tmp|sessions|tests)(?:/|$)`,
  inside `<IfModule mod_alias.c>` so a host without the module skips it rather than
  failing to parse. mod_alias has shipped with Apache since 1.3 and `RedirectMatch`
  sees the full URL-path, which is what the nested case needs — the alternative,
  `<If>`, only became legal in `.htaccess` in later 2.4 releases. The `RewriteRule`
  stays as the cheap root-level path; segment anchoring keeps `/testsuite/`,
  `/ui/js/tests.js` and `/storagelike/` out of both.
- `apacheGuards.test.php` covers the copy: nested config, state, both bare folders,
  the cookie jar under `browser-profile/` (no extension, so only a folder rule
  protects it), nested PHP and JS tooling, and an upper-case spelling — while
  asserting a nested copy's `ui/js/store.js` still serves and names that merely
  contain a guarded word are not blocked. 47 assertions, up from 28. Deleting the
  `RedirectMatch` block and re-running fails 7 of them (`nested PHP tooling is
  denied (got 200, want 403)` among them); restored from a hash-checked copy, 47
  pass again. The test's minimal Apache config now loads `mod_alias` too, since
  every stock httpd.conf does.

---

## v335 — the "/" palette answers to how an agent is actually written

- **A code can be typed without its hash.** Codes are displayed as `#B8NL6F`, so
  the hash reads as part of the handle — but the palette compared what you typed
  against the stored value *including* the `#`, so `/B8NL6F` listed nothing while
  `/#B8NL6F` worked. `agentSearch.js` normalises both sides the same way
  `routing.js` already did, so either spelling finds the agent.
- **Any word of a name matches, not just its first.** `/north` found
  `North-mini` but `/mini` did not; `/light` missed `nemotron-lightning` and
  `/alpha` missed `Ox Alpha`. The palette now matches the whole name, each
  word of it, and each segment of a hyphenated or versioned model name
  (`/m3.1` and `/flash` both find `minimax-m3.1-flash`).
- **The palette can no longer stop appearing silently.** It kept the element it
  was built into and the textarea it read from, so a rebuilt chat area left both
  pointing at detached nodes: typing then rendered the list into a panel nobody
  could see, with no error. `_render()` now rebuilds a panel that has left the
  document, the input is re-resolved when it has gone, and two instances on one
  textarea (an init that ran twice) resolve to one — the newest takes the box and
  disposes the older, instead of stacking a stale copy over it.
- The matching rule moved into `ui/js/agentSearch.js`, which imports nothing and
  touches no browser global, so it is covered by `tests/js/agentSearch.test.mjs`
  (36 assertions: hash and no hash, every word of a name, roles, and the
  negative cases). `node tests/run.mjs` runs it with the rest: 8 JS files, 221
  assertions, plus the PHP suite.

---

## v335 — the fallback floor can be fixed in place, and no longer drags with an orbit

- **Why it moved.** With the floating floor off, the grid you get is a real
  object in the 3D scene, sitting at a real height along with the graph — so an
  orbit carried it around with the camera, and a low angle flattened it into a
  line. It was never the still backdrop the DOM floor is.
- **Desktop → Fix the floor in place** (Config tab, Desktop section, under
  Floating floor). On, `_pinGrid()` re-places the polar grid in camera space each
  frame, sized and pitched like the DOM floor: a 150vmax disc centred 10% below
  the middle of the view. The same spot at every orbit angle, pan and zoom, while
  the graph itself stays fully orbitable, draggable and zoomable. Measured: after
  a 35° orbit and a 3× zoom, every sampled point of the grid projected to the same
  pixel as before.
- **`setGridFixed()` / `setFloor()` share the transform.** While pinned, the
  follow lerp stops writing to the grid, so the auto-fit cannot nudge it; its
  target is still recorded, and releasing the pin lands on the world pose instead
  of sliding back to it. Fog is skipped on the grid while it is pinned (at a fixed
  camera distance it would only dim evenly, or erase it in "background only"
  mode), and restored when it is released.
- **The disc is clamped to stay in front of the camera.** At a 74° pitch 96% of
  its radius comes back toward the viewer, so geometry behind the near plane — the
  cause of the tearing a full-bleed fixed floor would show — is avoided by holding
  its near edge at least 35% of the placement distance away; it spans about three
  quarters of the window at 1500×900.
- **The control only applies to the fallback grid**, so it is disabled (keeping
  its value) while the floating floor is the one on screen, and says why:
  "floating floor is on" / "pinned" / "moves with the map".

---

## v335 — the map keeps its detail, and one control lowers it on purpose

- **The pixelation was the map lowering its own resolution.** `SceneCore` shipped
  an adaptive render scale: every 1.5s it sampled the GPU timer (or frame time)
  and stepped the internal resolution down one rung — 100% → 85% → 70% → 55% →
  42% — whenever a frame ran long. Every rung re-set the renderer's pixel ratio
  and re-sized the composer, which is the flash or refresh you saw, and the map
  never came back up unless the machine was comfortably fast. On a slower GPU
  that is four steps within the first ~6s, so the lines went soft a few seconds
  after load and stayed that way.
- **`_adapt()` is gone.** Nothing steps the map's resolution behind your back
  any more; the scene renders at one scale from load until you change it. The
  scale is now an explicit setting, read once by `_applyTopoSettings()`.
- **Desktop → Map detail** (Config tab, Desktop section): 100 / 85 / 70 / 55 /
  42%, shown as a slider with its value beside the label. `setQuality()` in
  `scene.js` snaps to the nearest rung and does nothing when it is already there,
  so re-applying the setting never re-sizes or flickers the composer. Lowering it
  is the GPU win the old adaptive scale was reaching for — it draws the same map,
  fewer pixels deep.
- **Performance mode includes it now** (70%), so the one-click cheap preset
  still cuts fill rate; switching the preset off restores whatever value you had,
  and the slider always shows the truth either way.

---

## v335 — the config drawer closes once, and a press outside closes it

- **The re-open.** Closing an expanded section from the left stack retracted,
  then the panel popped back in about four fifths of the way through and
  vanished again. `closeFly()` clears `fly` immediately (so a click during the
  animation is not read as "still out"), but the Config tab repaints its live
  status lines, and every repaint runs `decorate()` → `syncFly()`, which saw the
  section still `open` for the rest of the 440ms retract and opened it again.
  A new `closing` reference (`desktop2026.js`) remembers what is retracting, and
  `syncFly()` now skips it; its `done()` also stands down if a drawer has taken
  the section back.
- **One animation at a time.** `stopAnimating()` cancels a clip animation still
  running on the drawer before starting the next one, so a close begun while the
  open was still playing can no longer leave two animations fighting over
  `clip-path`, with whichever ends last deciding what stays on screen.
- **A press anywhere else closes the expanded section**, in both layouts. The
  desktop skin already did (a `pointerdown` outside the drawer); the plain
  accordion below 1025px now does too (`sidebar.js`), and skips itself while the
  skin is active because that close is animated and needs `<details>` open.
- **The rule moved out of the DOM so it can be tested.** `drawerState.js` now
  owns "which section's drawer should be out" as `planDrawer()`, with no DOM and
  no imports; the skin passes the section elements in and gets them back. It is
  the same rule, including the `closing` gate above.
- **`tests/js/drawerState.test.mjs` pins the race** — 21 assertions: the named
  cases (a repaint mid-close, a click mid-close, clicking the retracting section,
  a finished close, a swap, a click that closed its own section) plus every
  combination of open-set × current × closing × clicked (512), asserting no
  combination ever opens the retracting section, never folds up the outgoing or
  the incoming drawer, always retracts before opening, and always obeys a click
  on an open section. Proved to fail: dropping the `closing` filter reproduces
  the original bug (`open=[A] current=null closing=A -> target A`) and fails 6.
- **The retract goes back to the label in one move.** Closing used to play the
  open's keyframes backwards: the panel folded up into a full-width bar and only
  then wiped away leftwards, and for a section low enough that `placeFly()` had
  raised the drawer, that bar sat on the drawer's top instead of the label's row.
  `closeFrames()` now collapses both axes at once onto a 44px band on the label's
  own row, at the stack's edge, and `labelBand()` gives the open the same origin
  (`flyFrames()` takes the band offset), so open and close are mirror images.

---

## v335 — a finished reply never commits raw tool-call JSON

- **The leak.** When a turn ended without prose (out of steps, out of time, or
  stopped right after a call), the fallback committed `turnText` — the run's raw
  stream — so the transcript could end up holding
  `{"tool":"read_file","arg":{…}}` as the answer, duplicating the tool panel in a
  shape that reads like an unfinished reply.
- **Two accumulators, two jobs.** `node.turnText` stays the raw stream and is what
  the live bubble paints (the operator asked to see everything while it runs).
  `node.turnProse` is the same steps with the markup cut out, and it is the only
  thing the finished message falls back to.
- **`stripToolCall()` in `tools.js`** does the cutting, next to the parser that
  owns the dialects: it removes fenced call blocks, XML/native wrappers
  (`<invoke>`, `<function>`, `<tool_call>`, Qwen `tool_call_begin`), and bare
  balanced JSON objects — each removal validated by `_parseToolCall()`, so prose
  containing braces or angle brackets is left untouched. It walks past non-call
  objects instead of stopping at the first `{`.
- **An out-of-budget turn now returns prose (possibly none)** instead of the raw
  stream, so `_finalMsg()` turns a call-only run into the "finished after running
  N tool calls" notice.
- **`tests/js/stripToolCall.test.mjs`** pins it: 27 DOM-free assertions over every
  markup shape (JSON, fenced JSON, `<invoke>`/`<function_calls>`, the three Qwen
  spellings), plus the cases that must be left alone — ordinary code blocks,
  brace-and-angle-bracket prose, and an object naming no known tool. Verified to
  fail (15 assertions) against a no-op `stripToolCall`, so it cannot pass by
  accident.
- **`node tests/js/run.mjs`** runs the whole JS suite in one step: each
  `*.test.mjs` in its own Node process, a line per file with its own count, full
  output for failures, and a non-zero exit if any file failed (6 files, 164
  assertions today). Its own filename does not match `*.test.mjs`, so it is never
  picked up as a test.
- **`php tests/php/run.php`** does the same for the PHP suite (7 files, 265
  assertions): each `*.test.php` in its own PHP process via `PHP_BINARY`.
  `mcp-mock-server.php` stays a helper — it is not named `*.test.php`.
- **`tests/php/apacheGuards.test.php` — the `.htaccess` denial is tested too,**
  not just the router in `serve.php`. It writes a throwaway Apache config (free
  loopback port, `DocumentRoot` at this project, `AllowOverride All`, only the
  modules the shipped `.htaccess` files need — each added only when its `.so`
  exists, since loading a compiled-in module is fatal), boots the local Apache,
  asserts, and shuts it down; config, logs, pidfile all in the system temp dir and
  removed afterwards. It **skips** (exit 0, `SKIP:` line) when there is no Apache
  to boot, with `ROUTER_HTTPD` as the override.
  - **tests:** `/tests/js/run.mjs`, a JS test, `/tests/php/run.php`, this test
    itself, `tests/.htaccess`, `/tests`, `/tests/`; `/storage/state.json`,
    `/storage/config.json`, `storage/.htaccess`, `/storage`, `/storage/`,
    `/storage/sessions/`. Each denied path is checked for **403** *and* for the
    absence of that file's own content in the error body (Apache answers with an
    HTML error page, so "tiny body" is not available here).
  - **case variants** (`/Tests/…`, `/TESTS/`) accept **403 or 404**: Windows and
    macOS resolve them to the real folder, Linux does not.
  - **still served, checked by content:** `/` (real `index.html`) and
    `/ui/js/store.js` (`APP_VERSION`).
  - **no overreach:** `/testsuite/missing` must not be 403.
- **Proved it fails:** removing `tests/.htaccess` → exit 1, **11 failures**, with
  the JS and PHP test sources served; removing `storage/.htaccess` → exit 1,
  **7 failures**, with `state.json` and `config.json` served and `/storage`
  answering **301** (a listing). Both files were restored byte-identical (`cmp`)
  and the suite went back to green.
- **`tests/php/guards.test.php` — the guards are now tested, not just written.**
  It starts `php -S 127.0.0.1:<free port> serve.php` from the project root, makes
  real requests, and stops the server (a shutdown function kills it even on a
  fatal). 70 assertions, each blocked path checked **twice**: the status must be
  **403**, and the body must be the router's own nine-byte `Forbidden` — anything
  larger means content came with it.
  - **tests:** the two runners, a JS test, `guards.test.php` itself, the folder
    with and without a slash, and the case variants `/TESTS/…`, `/Tests/…`.
  - **storage and its neighbours:** `state.json`, `config.json`, the bare folder,
    `sessions/`, a missing transcript, a `.bak` dropped in there, `/STORAGE/…`, and
    **a real transcript by its real name** (globbed from the disk, skipped cleanly
    when a checkout has none).
  - **the other refused dirs:** `logs/`, a log file, `tmp/`, `/sessions/` and a
    session file at the root.
  - **dotfiles:** `/.htaccess`, `/.htpasswd`, `/.gitattributes`, `/.env`,
    `/.git/config`, `storage/.htaccess`, `tests/.htaccess`, `api/.htaccess`, and a
    dotfile inside an already-refused folder.
  - **still served, checked by content:** `/`, `/index.html`, `/ui/js/store.js`,
    `/ui/css/base.css`.
  - **no overreach:** `/testsuite/missing` and `/ui/index.html` (a dot that is only
    part of a filename) are not blocked.
  Loopback only, no curl extension (this machine has none), no token, and it never
  writes to `storage/`.
- **Proved it fails when it should** — three mutations, each restored byte-for-byte
  (`cmp`) and re-run green:
  - drop `'/tests'` → exit 1, 6 failures;
  - make the prefix match case-sensitive → exit 1 on exactly the two case variants;
  - disable the dotfile rule → exit 1, 12 failures, including `.htaccess` served
    with **1871 bytes** and `.htpasswd` with **67**;
  - drop `'/storage'` → exit 1, 18 failures, including `state.json` served with
    **1,339,033 bytes** and `config.json` (token + keys) with **334**. The test
    prints body *lengths* only, never body content, so a failing run cannot spill
    secrets into a log.
- **`node tests/run.mjs`** runs both: `$PHP_BINARY` or `php` on PATH, then Node,
  each suite keeping its own runner so it can still be run alone. A suite whose
  interpreter is missing is reported as **did not run and fails the command**,
  never as a pass (verified: with a broken `PHP_BINARY` the JS suite still runs
  and the exit code is 1).
- **README → 🧪 Tests** documents all three commands, the naming rule that
  registers a test, the exit-code contract, the `PHP_BINARY` fallback, and the
  the two cases that **skip** rather than pass: `sandbox.test.php` when git is
  unavailable or refused, and `guards.test.php` when `proc_open` is disabled or
  no loopback port can be bound (and, for the transcript case, when a checkout
  has no `storage/sessions/*.json` yet). The architecture tree now lists the two
  runners as well. Suite now: 14 files, 450 assertions (PHP 265 + JS 185), ~9s
  (two of the PHP files boot a real server).
- **The section leads with what `tests/` is NOT:** optional dev tooling that the
  app never loads, needing no `package.json`, no `node_modules` and no install —
  the app stays plain PHP and drag-and-drop — and says where the folder is
  blocked and where it is not.
- **The same denial now exists in every serving mode.** `tests/.htaccess` ships
  with the app (the same portable `Require all denied` + Apache 2.2 fallback as
  `storage/.htaccess`), and `nginx.example.conf` denies
  `/router/(storage|logs|tmp|sessions|tests)/` plus the bare folder. **Verified
  against a real XAMPP Apache 2.4.58** serving this folder with `AllowOverride
  All`: `/tests/js/run.mjs`, `/tests/php/run.php`, `/tests/`, `/tests` and the
  case variant `/Tests/js/run.mjs` all returned **403** from Apache itself, while
  `/`, `/index.html` and `/ui/js/store.js` stayed **200** and `/storage/*` stayed
  **403**. (That Apache instance had no PHP handler wired up, so the 403s are the
  access rules, not PHP.) The nginx regexes were exercised against sample URIs
  with PCRE: `tests/`, `tests/js/run.mjs` and bare `tests` match,
  `testsuite/x` does not.
- **`serve.php` refuses `/tests`** exactly as it refuses `/storage`, `/logs`,
  `/tmp` and `/sessions`, so `tests/js/*.mjs` (previously served as static text)
  and the PHP test scripts both answer 403. That prefix list is now matched
  **case-insensitively**: on Windows and macOS the disk is case-insensitive, so
  `/STORAGE/state.json` and `/TESTS/js/run.mjs` used to resolve to the real files
  and slip past a case-sensitive check. The `.php` guard was left comparing the
  exact `$uri`, because `/API/index.php` is a case variant of the front controller
  and serving it as a file would print PHP source. Verified over HTTP: `/tests`,
  `/tests/`, `/tests/js/run.mjs?x=1`, `/TESTS/js/run.mjs`, `/Tests/php/run.php`,
  `/storage/state.json` and `/STORAGE/state.json` all 403; `/`, `/index.html`,
  `/ui/js/store.js?v=335` and `/api/index.php` still 200.

---

## v334 — streaming stays cheap as the bubble grows

- **The cost.** v333 made the live bubble hold the whole run, but it was still one
  string rewritten on every token, so a long turn recopied everything it had said
  for each new token — work that grows with the length of the turn.
- **The bubble is now three text nodes**: the run's settled prose, a paragraph gap
  that exists only once there are two blocks, and the step in flight.
  `_paintProse()` writes each only when it changed, so the settled block is written
  once per step instead of once per token, and a token touches only its own tail.
- **Nothing changes on screen.** They live inside the same `white-space: pre-wrap`
  element and the join is still `joinProse()`, so `textContent` is byte-identical to
  v333, the streaming caret (a `::after` on the same element) still sits after the
  last token, and `node.text` still mirrors the whole stream for the abort paths.
- A node not created by `_makeLiveNode` still paints the old single-string way, so
  no other caller has to change.

---

## v333 — the live reply reads continuously across tool steps

- **The bug.** The streaming bubble painted only the CURRENT step's stream, so
every tool call wiped the prose the operator had just watched arrive and the
bubble collapsed back to the newest few words. A working turn looked like it
kept starting over, and an aborted turn kept only the final step's fragment.
- **One accumulator owns the run's prose.** `node.turnText` is the run's settled
prose; `_paintProse()` paints `turnText` plus the step in flight, joined with a
paragraph gap, and is now the only writer of the bubble's text. `_paintStream()`
delegates to it, so the composer, always-on, ask-directly and routing-chart paths
all paint identically.
- **It survives the round boundary too.** `_toolLoop()` seeds `turnText` from the
live node instead of `''`, so `_runToCompletion()`'s next round continues the same
answer rather than resetting the bubble it is still writing into.
- **`node.text` mirrors what is on screen**, so the abort paths that keep
"whatever streamed" keep the whole turn, not the last step's fragment. The
`painted` accumulator, which existed only to rebuild that display string, is gone.
- The finished message is unchanged: it is still the model's last answer, with
`turnText` as the fallback when a turn ends without one.

---

## v332 — replies can no longer vanish when they finish

- **The bug.** A finished turn could be committed with `content: ''`: `text` only
  ever held the CURRENT step's stream (each step starts a fresh one), so a turn
  that ended on a tool call — or was cut short by the step/time budget — returned
  no text of its own. `sendMessage()` then did `result.value.content ??
  result.value.text`, which `??` does not fall back for, and `''` is an empty
  string, so the blank answer was accepted. The renderer produced an empty
  bubble, which replaced the streaming node *at the moment the reply finished*,
  and the same `''` was what `_saveDialog` sent to the server — which is why
  reloading did not bring it back either.
- **Each run now owns its turn and its text.**
  - `_liveNodes` is keyed by a **turn id**, not by agent. Before, a second run for
    the same agent (composer fan-out, always-on tick, ask-from-a-node,
    routing-chart workflow) deleted the first run's node and the finishing run
    wrote into whatever node the map held at completion. The fan-out now creates
    and captures its node at dispatch and commits to that exact node.
  - `_toolLoop()` keeps `turnText` — every step's prose in the run — so the
    finished message can fall back to everything the operator watched arrive.
- **One commit point, and it cannot produce a blank.** `_replaceLiveNode()` now:
  normalises the message through `_finalMsg()` (last answer → streamed text →
  “finished after running N tool calls…” → “finished without writing a reply”);
  removes its node from `_liveNodes` by turn id; and **appends** the message when
  its node is detached instead of silently `return`ing. A detached node (session
  reload, cleared transcript, an overlapping run) used to drop the reply from the
  screen *and* from the stored conversation. `_addMessage()` refuses a blank agent
  bubble for the same reason, and the routing chart / ask-directly / always-on
  paths all commit through this one function now that it handles that case.
- **Always-on stopped leaving a stranded stream.** It appended with `_addMessage`
  and never replaced the streaming node it had created, so an autonomous reply
  left a caret blinking forever and a second bubble next to it. It commits through
  `_replaceLiveNode` like every other run.
- **No more duplicate history.** `_saveDialog()` pushed the user turn and every
  reply into `conv.messages` a second time (the render path already recorded
  them), so stored conversations accumulated duplicates that re-rendered on the
  next session open. It now only saves to the server and touches freshness.
- **`MessageRenderer.render()` always returns a whole message.** With “Show Code”
  off it returned a bare `.message-body` — no wrapper, no header, no actions — so a
  streaming placeholder was being swapped for a different kind of element.
- Cache-buster 331 -> 332.

---

## v331 — performance mode, and a render scale that actually scales

- **The adaptive render scale was a no-op — this is the 99% GPU bug.**
  `EffectComposer` caches the renderer's pixel ratio at construction and only
  refreshes it in `reset()`/`setPixelRatio()`, but `SceneCore._setScale()` changed
  the renderer alone. So the scene, the bloom mip chain and every pass kept
  rendering at the **original** 1.5x resolution however far the scale stepped
  down, and only the final blit shrank. The composer is now told the ratio
  explicitly, which is what makes the existing "step down when the frame is over
  budget" logic real. (`resize()` also stopped sizing bloom a second time — the
  composer already sizes every pass — so a resize no longer rebuilds its render
  targets twice.)
- **No per-frame allocation in the map's hot paths.**
  - `_updateLinks()` reuses grow-only position/colour buffers instead of
    allocating two `Float32Array`s and two fresh GPU attributes on every frame
    the force layout is settling (and no longer recomputes a bounding sphere the
    object does not cull against).
  - `Beam.setEnds()` copies the new tube into the existing attributes instead of
    disposing and reallocating a `TubeGeometry`, and the rebuild key quantises the
    radius (it eases on every phase change, so a 2-decimal key rebuilt the whole
    tube nearly every frame for a 0.16-unit difference).
  - `LabelLayer.place()` writes `transform`/`opacity` only when they change and
    buckets `zIndex` to 0.02 of NDC z, so a slow camera drift no longer forces a
    style recalc for every label every frame.
- **Two knobs that lied now do what they say.** Glass blur at **0** emits
  `backdrop-filter: none` instead of `blur(0px)` — the zero position used to keep
  the compositing layer (and its per-frame re-blur of the live map) alive. Ambient
  motion at **0** actually stops: the old `Math.max(0.05, ...)` clamp left every
  loop running at 1/20 speed, which still repainted every frame.
- **New, ordinary controls in Desktop → Config**, each one reversible on its own:
  **Bloom glow**, **Floating floor** (falls back to the cheap in-scene polar
  grid) and **Slow auto-rotate** (the idle camera drift, which is what used to
  keep the whole scene — and everything composited over it — permanently busy).
- **Performance mode** preset at the top of Desktop → Config (and it is *not* a
  second set of visual state): it writes the same settings those controls already
  own — blur 0, glow 0, motion 0, fog off, 30fps, bloom/floor/drift off, plus the
  Resource Manager's idle throttle and covered-panel pause — and puts them back
  when switched off. A value you move by hand while it is on is kept when it is
  switched off, and it only ever *tightens*: a machine already running at 20fps
  and an idle floor of 5fps keeps both.
- **The floating floor can be switched off at all now.** `html.d26 .d26-floor
  { display: block }` outranked the `[hidden]` attribute, so hiding it did
  nothing.
- Cache-buster 330 -> 331.

---

## v330 — curl-template agents now replay conversation history

- **"I don't have context from a previous conversation."** Agents driven by a
  saved **curl / Python / Node snippet** (the NVIDIA example shape: a single
  `{"role":"user","content":"$USER-PROMPT-VARIABLE"}` and **no system message**)
  never received their replayed history. `injectContext()` inserted history only
  when the first user turn was at index **> 0**; in this — the *most common* —
  template the live turn sits at index **0**, so it matched neither branch and
  history was dropped silently. Every ordinary (non-template) agent was fine,
  which is why only the snippet-based models looked amnesiac.
- Fix: splice history at the first user turn when `firstUser >= 0` (`chat.js`
  `injectContext`). History now lands in front of the live turn whether or not
  the template carries a system message.
- Cache-buster 329 -> 330.

---

## v329 — Always-On hold/release reset; global pre-prompt prepend/replace

- **The HELD badge is no longer a trap.** `alwaysOnMaxIterations` /
  `alwaysOnMaxMinutes` (or a click on an agent's ALWAYS ON badge) park an agent by
  adding it to a **saved hold set** — and nothing ever released it. The master
  switch's own documentation said *"switching it off releases everyone,"* but the
  function that does that (`stopAll`) was **never called**; off→on was a no-op and
  the roster came back with every badge stuck on **HELD**.
- The master switch is now read as a **transition**: turning it **on** clears
  every hold (a real reset), turning it **off** runs `stopAll()` (stop + release
  everyone). New `releaseAll()` / `alwaysOn:releaseAll`.
- **Config → Permissions → Always-On** shows the held count and a **RELEASE HELD
  AGENTS** button, and the status line warns when the cadence is long enough that
  a cap would fire after a *single* tick (so a low cap read as "always-on turned
  itself off"). Files: `ui/js/alwaysOn.js`, `ui/js/components/sidebar.js`.
- **Global pre-prompt: prepend or replace, your choice.** The override used to
  **replace** every agent's system prompt (v235), which silently stripped agents
  of their instructions — hence "they ignore everything and just explore." The
  popup now carries a **bottom-left mode switch**: **Prepend** (default — the
  override goes in front of the agent's own prompt, which still follows) or
  **Replace** (the old behaviour). The hint updates live; the choice is stored as
  `globalPrePrompt.mode` and a missing `mode` is treated as `prepend`.
  Files: `ui/js/components/{sidebar,chat}.js`, `ui/js/store.js`,
  `ui/css/modals.css`.
- **SECURITY — `storage/` web-exposure hardened.** The shipped
  `storage/.htaccess` used Apache **2.2** `Deny from all`, which needs
  `mod_access_compat` on 2.4 (XAMPP loads it, a plain host may not); it is now the
  portable form (`Require all denied` with an `!mod_authz_core.c` fallback), so a
  2.4 host without the module gets a clean `403` instead of a 500.
  `./setup-token.sh` now **re-creates the guard if a deploy lost it**. New
  **`nginx.example.conf`** (nginx ignores `.htaccess`) denies `storage/`,
  `logs/`, `tmp/` and `sessions/`, dotfiles, and loose data files. README
  gains a *Deploying on a real web host* section and a *storage/ is never
  web-served* security subsection. Files: `storage/.htaccess`, `setup-token.sh`,
  `nginx.example.conf`, `README.md`.
- Cache-buster 327 -> 329 (two feature steps, one entry).

---

## v327 — Always-On survives leaving the tab; browser click fix; block list

- **Always-On no longer stops when you leave the tab.** `visibilitychange`
  aborted the in-flight turn on *every* hide, even with "Run while tab is hidden"
  on — so a background run died the instant you switched away. It now aborts only
  when that setting is off, drives the timer from a **Web Worker** (page
  `setInterval` is throttled hard in a hidden tab), and ticks immediately on
  return. Turn on **Config → Permissions → Run while tab is hidden** to run
  off-screen.
- **`browser_click` / `browser_type` no longer toast "JS: Uncaught".** An invalid
  CSS selector made `querySelector` throw inside the page eval; it is now guarded
  and returns a readable *"invalid selector …"* result, and `Cdp` reports the real
  one-line exception description instead of "Uncaught".
- **New domain/URL/IP block list** on the Browser screen (right rail, below the
  buttons). One pattern per line, `*` wildcard: `*.gov` (any .gov), `*word*`
  (contains), a bare host/IP (`10.0.0.1`), or a URL path (`site.com/a/b/`).
  Enforced **server-side on every navigation** (you and the agents), and
  re-checked after a click/type in case a link reaches a banned host. Stored as
  `browser.blocklist` in config.

---

## v326 — config saves on hosts that block PUT; stray headless browsers

- **"Not saved: API 404" when saving the sandbox path** (and the wall of HTML in
  the status line). Some hosts block or reroute the **`PUT`** method at the
  web-server level, so the request never reached the app and the site's own 404
  page came back. Config and state saves now use **POST**, which the API accepts
  for the same routes (`handleConfig` / `handleState` take PUT or POST), and a
  non-JSON response no longer dumps a page of markup into the UI — it reports
  "the server sent a web page instead of JSON — check the app URL / API path".
- **Stray headless Chrome/Edge instances piling up** (the GPU/CPU you saw —
  you found ~8). `Browser::launch()` started a *fresh* instance whenever the
  saved debug port was dead, leaving the old ones running. It now **reaps** any
  chrome/edge still holding our unique profile dir before launching, and
  `stop()` reaps too — so there is only ever one, and Stop clears any orphans.

---

## v325 — toggle switches no longer squashed by long labels

- In **Config → Resource Manager** (and any row with a long label beside a
  toggle) the switch was squeezed by flex-shrink: the track shrank below the
  knob's travel so an "on" knob hung outside it, and every row came out a
  different width. `.toggle` is now `flex: 0 0 auto` (a fixed 36×20) and
  `.toggle-label` takes the slack and wraps. Measured before/after: track 25/35/36px
  → a uniform 36px.

---

## v324 — installers: the copyright header no longer runs on screen

- `start.bat`, `start-php.bat` and `setup-xampp.bat` had the copyright notice
  **above** `@echo off`, so cmd echoed the `REM` lines as they scrolled past —
  it looked like the notice was being run as commands. `@echo off` is now line 1
  and the notice stays as `REM` comments (silent). The `.sh` and `.ps1`
  installers already use `#`, which never executes.

---

## v323 — tell agents how they persist (they kept saying they can't)

- A model answered that it had *no runtime, no filesystem between calls, no way
  to stay alive* — true of a bare LLM, but wrong here, and it then advised the
  user to build a wrapper the app **already is**. The tool block now carries a
  short, honest **"How you persist"** note: you are invoked one turn at a time
  (true), but persistence lives in this app — `remember`/`recall`/`share`
  survive reloads and sessions, `write_file` leaves work on disk, the
  conversation is stored and reloaded, and an **Always-On** goal makes the app
  re-invoke you on a timer. It tells the model to reach for these instead of
  claiming it cannot persist.
- `tools.js` `toolInstructions` (shown when memory/file/goal tools are offered).

---

## v322 — Browser: Live-in-background is now a toggle

- The "keep Live polling while the Browser screen is hidden" behaviour from
  v321 is now **Config → Labs → "Keep Live running when hidden"** (default ON),
  so you can flip it either way:
  - **On** — Live keeps refreshing while you're on other screens; never stale.
  - **Off** — Live pauses when you leave the Browser screen and resumes on return.
  - The Live on/off choice itself stays a separate, remembered preference.
- `store.js` setting `browserLiveBackground`; `browserView._syncLive()` honours
  it (and re-syncs when the toggle changes).

---

## v321 — Browser: Live stays on

- The **Live** auto-refresh is now a **sticky preference** (persisted in
  localStorage), not a per-visit toggle. Leaving the Browser screen no longer
  switches it off, and the poll keeps running **while the app tab is visible** —
  so coming back to the screen (or an agent acting on the page) is never stale.
  It still pauses when the browser isn't running or the whole tab is hidden.
- `browserView.js`: `_live` preference + a single `_syncLive()` that reconciles
  the toggle, the running state and tab visibility; `hide()` no longer stops it.

---

## v320 — Resource Manager: optional 3D performance controls + CPU/GPU gauges

- **New Config → Resource Manager section.** Every switch is **OFF by default**,
  so the 3D graph keeps rendering continuously exactly as before — nothing
  changes until you turn one on:
  - **Pause when a panel is open** (routing chart, API Lab, Brain Lab, Browser, modals);
  - **Pause when the window isn't focused**;
  - **Pause when the graph is off-screen** — an `IntersectionObserver`, which also
    fixes the **mobile** case: the right panel is moved off-screen with
    `transform: translateX(100%)`, so the old `offsetParent` guard never fired and
    the scene kept rendering hidden;
  - **Slow down when idle** (default **10 fps**), where idle = no active traffic
    beams, no working agents, layout settled, and no recent interaction.
- **Two speedometer (needle) gauges** plus an FPS / frame-ms readout. Honest
  proxies: **CPU** = this app's JS share of each frame; **GPU** = real GPU ms via
  `EXT_disjoint_timer_query_webgl2` when the browser exposes it, otherwise an
  estimate from frame time (labelled as such).
- New `ui/js/perf.js`; gating in `topology3d/scene.js` and `topology3d/index.js`;
  the section + gauges in `sidebar.js`; styles in `components.css`.

---

## v318 — browser tools always offered (while the Browser is on) + mobile logo

- **Every agent now gets the browser tools** automatically while
  Config → Labs → Browser is on — `browser_open` / `browser_click` /
  `browser_type` / `browser_read` / `browser_wait` are unioned in the way memory
  tools are, so an agent with a hand-ticked tool list still has them and can no
  longer answer that it lacks browser automation. Turning the Browser off removes
  them again (and the API refuses them regardless). The on/off state is cached
  ~5 min and cleared the instant the Labs toggle is flipped.
- **Mobile header:** the wordmark is now centred as a stack on phones — "Loop
  Studio" under AUTONOMOUS, "Made By: MBHudson" under that. Desktop is unchanged.

---

## v317 — tell agents they CAN drive a browser

- A model asked to operate a page replied that it had no browser automation and
  suggested installing **Playwright/Selenium**. The capability was already there
  (`browser_open` / `browser_click` / `browser_type` / `browser_read` /
  `browser_wait`) — nothing made it obvious:
  - the tool **descriptions were thin** — they now say plainly that these drive a
    **real Chrome/Edge window the operator watches**, and that **no
    Playwright/Selenium/extension is needed**;
  - the prompt protocol had **no examples** for them — JSON and Claude-XML
    examples added;
  - native tool-calling gave them a **blank schema** — real schemas now
    (`url`, `selector`/`x`/`y`, `text`+`enter`, `ms`);
  - and a new instruction line spells out the workflow (open → read → click/type
    → read) and says the model must **never claim it lacks browser access**.
- Note: the browser tools must be ticked on the agent (they are in the default
  set for new agents).

---

## v316 — header mark back to the light

- Reverted the **desktop header logo to the blinking indicator** — the `main.png`
  brand mark didn't read well at 26px beside the title.
- `main.png` **stays as the favicon** (tabs/bookmarks). The apps-notch shape and
  chat-column centring from v315 are unchanged.

---

## v315 — brand mark + apps-notch shape and centring

- **The apps pull-tab was upside down.** It is now wide at the top (flush under
  the header) and narrows toward the bottom.
- **Centred on the chat column**, not the header/viewport: the notch now sits
  midway between the sidebar and the topology panel, so resizing either keeps it
  centred over the chat box. On phones (single column) it centres on the
  viewport as before.
- **Brand mark.** `ui/img/main.png` (transparent) is now the **favicon**, and on
  **desktop only** it replaces the blinking green dot beside the title in the
  header; the small dot remains as the mobile fallback. `main-motion.gif` was not
  used — its background is white, which cannot sit on the dark header.

---

## v314 — Browser: the multi-second stall that made a page take minutes

- **Root cause found.** Chrome answers its DevTools HTTP endpoints (`/json/version`,
  `/json/list`) in ~1 ms but keeps the socket open, and `file_get_contents` reads
  to EOF — so it blocked for the full timeout on every call. Each browser action
  paid that twice (`status` + `pageWs`), and stacking requests (Go, the Live
  poll) exhausted the browser's connection pool: a page took **minutes**.
  `Browser::httpJson()` now reads exactly `Content-Length` bytes over a raw
  socket and returns at once.
- **Navigation no longer waits for `complete`.** It returns as soon as
  `readyState` leaves `loading` (interactive is enough to screenshot); heavy
  sites that never reach `complete` used to sit out the full 25s every time.
- **Faster cold launch** — the readiness poll is instant now, and headless starts
  with background work off (`--disable-extensions`, `--disable-component-update`,
  `--disable-sync`, `--disable-background-networking`, …).
- **The screen can't stampede.** Go, click, type, Enter and screenshots are
  single-flight, the Live poll runs every 2s and skips while a shot is in
  flight, and it no longer closes on Escape while you are typing in it.
- Measured on this machine: navigate **8.3s → 0.3s**, screenshot **8.1s → 0.1s**,
  launch **~14s → ~3s**.

---

## v313 — the built-in Browser screen (Chrome/Edge over CDP)

- **A real browser, no packages.** New `src/Cdp.php` is a hand-rolled WebSocket +
  DevTools Protocol client (the framing this needs, including reassembling big
  screenshot frames), and `src/Browser.php` detects, launches and drives an
  installed **Chrome or Edge**. Verified end-to-end: launch → navigate →
  screenshot → read the DOM → close.
- **Its own screen**, opened from a new **Browser** item in the apps notch: an
  address bar, Go/Reload, **Live** auto-refresh, a headless tick-box, and the
  page screenshotted into an image you can **click** (coordinates map straight to
  CDP). A side rail types text, presses Enter, and reads the page's visible text.
- **Agents can drive the same page** with `browser_open` / `browser_click` /
  `browser_type` / `browser_read` / `browser_wait` (click by CSS selector or x,y;
  type into a selector, optionally pressing Enter). The operator can watch.
- **Logins stick.** The profile is persistent (`storage/browser-profile`), so you
  log into an account once — headless or in a visible window you can take over —
  and both you and the agents reuse it.
- **Off by default and gated server-side** (Config → Labs → Browser writes
  `browser.enabled` to the config, and every route returns 403 until it is on).
  Only http/https pages may be opened; the cloud-metadata addresses are refused.
- New `src/Cdp.php`, `src/Browser.php`, `ui/js/components/browserView.js`,
  `api/index.php` route, `api.js` methods, `tools.js` tools, apps-notch item,
  Config → Labs toggle, styles.

---

## v312 — API pool: scope a key to one model

- Each pooled key can now be **pinned to a model**: tick **Only this model** and
  enter a model # (the agent's code, like `#63BET7`) or a model id. That key is
  then used only for that model, so a provider can hold keys dedicated to one
  model and rotate around it while everything else keeps the single key. Blank #
  means all models.
- `apiPool.pickKey` filters the pool by scope before rotating; a scoped key that
  does not match is skipped (and if nothing matches, the provider's single key is
  used, as before). UI in `providerEditor.js`; styles in `components.css`.

---

## v311 — API pool: rotate several keys for one provider

- **A provider can hold a pool of extra keys** (Provider editor → *API pool*:
  label + key rows) and **rotate after N requests** you set (0 = every call).
  The agent's own Key Override still wins; with the pool empty or the feature
  off, the single provider key is used exactly as before.
- **A 429 rests a key.** A rate-limit refusal puts that key on a 60s cooldown and
  the next call picks a different one, so one exhausted free-tier key no longer
  stalls the whole provider.
- Feature-gated: **Config → Labs → "API pool"** (default **OFF**). Rotation
  counters are session-only — a reload simply starts a clean round, which is the
  safe direction (a stale counter only ever rotates away from a good key).
- New `ui/js/apiPool.js` (`pickKey` / `noteResult`); `chat.js` resolves the key
  through it and reports the outcome; UI in `providerEditor.js`, toggle in
  `sidebar.js`, styles in `components.css`.

---

## v310 — Dynamic tools: teach each model the environment it is really in

Free/quantised models used to burn several tool calls re-guessing the syntax.
Three changes, all behind **Config → Labs → "Dynamic tools"** (default ON; off
restores the classic behaviour exactly):

- **Environment-aware manifest.** The tool instructions now open with the facts
  that actually matter: the **server's** OS and working directory, and which
  allowlisted shell commands resolve — so a model is told to use `grep` where it
  exists and not to try `findstr` off Windows. Built from `GET /sandbox/status`
  (new `os`, `exec_allow`, `binaries` fields); the old check read the *browser's*
  user-agent, which is wrong when the app is served from another machine.
- **Parse-failure escalation.** If a reply clearly tries to call a tool but
  parses to nothing, the loop re-teaches **once** with a different dialect
  (`plain → json → native → anthropic`) instead of letting the near-miss become
  the final answer.
- **Learned dialect.** Once a call parses, the working dialect is remembered per
  `provider::model` and used first next time (Config → Labs → "Remember the
  working dialect", default ON).

New `ui/js/toolManifest.js`; edits in `chat.js`, `harness.js`,
`toolProtocol.js`, `store.js`, `sidebar.js`, `src/Sandbox.php`.

---

## v309 — an apps notch under the header; API Lab opens fullscreen

- **New "apps" pull-tab** centred just under the header, dipping a little into the
  chat area. A `\___/` notch with two stacked lines (top longer), sized for a
  thumb. Tapping it drops a small menu.
- **Brain Lab, API Lab and the Routing Chart moved into it** — out of the
  Agents-tab header (the two icons) and out of the header rail (the routing
  button), so a phone no longer has to hunt for them. The menu closes on an
  outside tap, on Esc, and when an item is chosen.
- **The API Lab now opens fullscreen from the main screen** (`show()` forces the
  full size unless it is embedded in Brain Lab); the HALF button still shrinks it
  for the session.

---

## v308 — MCP on the graph: nodes, traffic, and editable access

- **MCP servers you call (out) and friends' clients connected to you (in) are
  now nodes** on the topology — amber for a server, sky for a friend — with the
  same clickable cards as everything else. Outgoing calls animate agent → server
  → agent live (the tool layer emits the flow events); incoming friend traffic is
  polled from the server's audit log (`GET /api/mcp-server/activity`), so those
  beams tick in on the poll interval rather than frame-perfect (there is no push
  channel).
- **Cards**: a server card shows transport, reachability + tool count, the tool
  policy and your recent calls (tool, ok/err, ms, time). A friend card shows
  server on/off, their scope, and their recent calls.
- **Two extra tabs on every MCP card.** **Access** edits the node itself: a
  server's connection (command/args/env or URL/headers) plus a new **per-server
  tool allow/deny list** (deny is absolute; a non-empty allow list restricts to
  it — enforced server-side in `Mcp::callTool`), and a friend's **scope**
  (read/write/exec) and IP allowlist. **Permissions** edits the app-wide shell
  **allow/deny lists, interpreter levels, auto-approve / auto-deny and the code
  interpreter** — the same Config values, saved inline.
- **Audit log is JSON now** (`mcp=<label> tool ok err args result`), so cards and
  traffic can be reconstructed; each line keeps its index as `seq` for polling.
- New `ui/js/components/topology3d/mcpPanel.js`; changes in `topology.js`,
  `topology3d/{index,layout,nodes,popup}.js`, `tools.js`, `api.js`, `src/Mcp.php`,
  `src/McpServer.php`, `api/index.php`, `topology.css`.

---

## v307 — the graph's inline reply now shows the real tool work

- **Tool calls are shown verbatim in the topology's floating reply box** — each
  call's name, its arguments (pretty-printed), its status and duration, and the
  full tool output — followed by the model's closing answer. Reasoning, when the
  provider streams it, is shown first. Everything is raw text, verbose on
  purpose: no boxes, no collapsing, no "tool called" placeholder.
- `askAgentInline()` now returns `toolCalls` and `reasoning` alongside the text;
  `ask.js` composes them. The reply body scrolls (`min-height:0` + a styled
  scrollbar) once the content is taller than the box, and the view auto-scrolls
  to the newest content.
- Only the closing answer is read aloud by the Voice toggle — never the tool
  dumps.

---

## v306 — ask a model from its node card on the 3D graph

- **The 3D node card gained an `ASK` button** (bottom-left of the footer). It
  opens a small prompt box docked just under the card, with a play-button send
  (the same ▶ as the main composer) and a **Voice** toggle, default **on**, for
  read-aloud. That toggle is its own preference — deliberately separate from the
  main Config default of off.
- **The answer appears in the graph**, in a semi-transparent floating box pinned
  to the top corner with the most room; it flips left/right as the node is
  orbited. Raw text only (no markdown, code or tool cards) and an × to close.
- **The exchange is isolated**: it never enters the transcript and never fans
  out, so the map's little chat can't disturb the main conversation. It does
  still emit the normal flow events, so the traffic animates on the graph
  exactly as a composer prompt would — unlike the agent-list Ask, which stays
  silent on the map.
- New module `ui/js/components/topology3d/ask.js` (the dock); `askAgentInline()`
  in chat.js; wiring in app.js, popup.js and topology3d/index.js; styles in
  topology.css.

---

## v305 — topology traffic lines: model colour, dots that keep flowing

- **Traffic between You and a model is drawn in that model's colour, both
  directions.** A request used to be painted in the user's red because the line
  took the sender's colour, so the model only looked like itself on the reply.
  Agent-to-agent hops keep the sender → receiver gradient. Applied in both the
  SVG chart and the 3D beams.
- **The marching dots no longer stop at the "settle".** They used to freeze the
  moment an active line was demoted to the faint history record. They now march
  for the whole life of the line; only the final fade stops the motion (3D lowers
  the dash contrast instead of flattening to a solid line).
- **Removed a CSS animation that fought the per-line `stroke-dashoffset`
  animation**, which made the dots stutter or freeze.
- **Requests wait for the model.** An inbound request used to settle on a flat 6s
  timer, so a slow model saw its line fade while still generating. It now holds
  until `flow:respond` / `flow:fail`, capped at 120s; settle timers no longer
  fade a line that was refreshed back to active.
- Cache-buster tags aligned to `APP_VERSION` (303 → 305).

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
