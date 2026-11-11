# Roadmap — what's next

**Updated as things ship.** This is one person's project, so this list is short and honest about order — and it is an order, not a schedule. Nothing here is promised or dated; the only commitments are in *Not doing* below. If something matters to you, say so in the comments — a request with a real use case behind it moves up; a request with a thumbs-up does not.

---

## Now — the next release

- [ ] **An install that survives a hostile host.** The launcher is the first thing anyone meets, and the first thing that fails on an unusual box: locked folders, a PHP that isn't the one on `PATH`, a port already taken, `www-data` that cannot write the app folder.
- [ ] **Backup and restore you can trust.** Export already walks every section, but a restore that meets a file from an older version is the least-tested path in the app, and it touches the thing people care about most.
- [ ] **A five-minute promise.** From download to a first agent reply, measured on a clean Windows machine and a clean Debian one, written down in the README — including the parts that make it slower.
- [ ] **Say what broke, in words.** Error messages that name the fix (which file, which permission, which port) instead of surfacing a PHP notice.

## Next

- [ ] **A docs site that isn't a 1,700-line README.** The documentation is thorough; it is also one page. Sections move to pages with search, and the README keeps the pitch and the quick start.
- [ ] **Android packaging** — the WebView shell or the PWA, whichever gets a working build first. PHP on-device via Termux/KSWEB stays the documented path.
- [ ] **Glass theme on weak GPUs** — a cheaper default (fewer shaders, lower frame cap, static floor) so the pretty interface isn't a machine-class decision.
- [ ] **Streaming on shared PHP hosts** — a documented, tested configuration for hosts where `php -S` is all you get, and an honest note in the docs about what that costs.
- [ ] **More guard tests, not more guards.** Every refusal that exists should have a test that makes the real request.

## Later — thinking about

- [ ] **Mesh between copies**, hardened: sharing agents across two installs is the feature most likely to become a security hole, so it ships slow or not at all.
- [ ] **A systemd unit and a Windows service wrapper**, for people who want it always running rather than launched.
- [ ] **Provider additions** — driven by requests with a real endpoint to test against, not by logos.
- [ ] **Configurable tool sets per agent**, so a small local model is not handed twenty tools it cannot use.

## Not doing — on purpose

These are not "not yet". They are the shape of the project:

- **No accounts, no cloud, no sync service.** Your machine, your keys.
- **No Docker requirement.** A folder of PHP is the whole deployment story.
- **No build step and no runtime dependency install.** No `composer install` before it runs, no `npm run build` before it loads.
- **No telemetry.** The app does not phone home, and it will not start doing so.
- **No bypass around the approvals.** A feature request that amounts to "let the model skip the prompt" is a no.

## Recently shipped

- **v447** — Tunnels: start and stop ngrok and Cloudflare quick tunnels from Config, so the MCP server can leave the LAN without a terminal.
- **v445** — `glob` matches a path-relative pattern once instead of twice, and a zero-match message quotes the pattern rather than the arguments object.
- **v437** — the update installer probes the deepest folder that exists, so a release that adds one no longer looks like a locked folder.

## How to help, concretely

- **Reproduce something in "Now"** on your machine and report what happened — that is worth more than a star.
- **File a bug with the version and your launcher.** Two fields turn a paragraph into a fix.
- **Write down the workaround you are living with.** A workaround is a feature request with evidence.
- **Improve one paragraph of the docs** where it lost you. Docs pull requests are the easiest ones to accept.
