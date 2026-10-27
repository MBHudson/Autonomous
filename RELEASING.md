# Releasing

Two numbers tell the update check at **Config → Updates** that something new
exists. Bump the right one and nothing else is needed.

| # | Number | Lives in | Bump it when |
| --- | --- | --- | --- |
| 1 | **release number** | [`VERSION`](VERSION) (repo root) | **every** release — including one that changes no browser file, e.g. a PHP or docs fix |
| 2 | **cache-buster** | `APP_VERSION` in [`ui/js/store.js`](ui/js/store.js) | a file the browser loads or caches changed (`ui/**`, `index.html`) |

Neither is optional decoration: the check announces a release when **either**
number is newer than the running copy's. The release number is what makes a
PHP-only release visible at all — the cache-buster correctly does not move when
no cached asset changed, so it cannot report one.

## Checklist

1. **Bump `VERSION`** — replace the number on its last line. Plain integer, only
   ever increasing, and never *below* `APP_VERSION` (a test fails if it is).
2. **Bump `APP_VERSION` only if you touched anything under `ui/` or
   `index.html`.** When you do, it must change in **three** places together, or a
   browser mixes a new module with an old one:
   - the `APP_VERSION` constant in `ui/js/store.js`
   - every `?v=` module import under `ui/js/**`
   - the `<script>` / `<link>` tags in `index.html` and `ui/index.html`

   ```bash
   OLD=346 NEW=347
   sed -i "s/APP_VERSION = $OLD;/APP_VERSION = $NEW;/" ui/js/store.js
   for f in $(grep -rl "v=$OLD" --include=*.js --include=*.html ui index.html); do
     sed -i "s/v=$OLD/v=$NEW/g" "$f"
   done
   grep -ro "v=$OLD" --include=*.js --include=*.html ui index.html | wc -l   # must print 0
   ```

3. **Add a [CHANGELOG](CHANGELOG.md) entry.** Say which numbers moved, and say
   *"no cache-buster bump"* plainly when you left it alone — that is information,
   not an omission.
4. **Run both suites:** `php tests/php/run.php` and `node tests/run.mjs`.
   `tests/php/update.test.php` fails when `VERSION` is behind `APP_VERSION`,
   which is the mistake this checklist exists to prevent.
5. **Push.** Running copies get a notification in the bell on their next page
   load; the check is cached server-side for six hours, and nothing installs
   itself — **Config → Updates → DOWNLOAD UPDATE…** is still a manual,
   compare-first step.

## The one caveat

A copy that predates `VERSION` has no release number to compare, so it can only
see the **cache-buster**. If a release has to reach those copies, bump the
cache-buster as well — it costs every browser one re-download, which is why it is
worth bumping only when it buys something. (The release that introduced `VERSION`
did exactly that, once.)

## Where this is enforced

- `src/Update.php` — `check()` probes both files; `isNewerVersion()` decides.
- `tests/php/update.test.php` — the drift guard, plus the parsing and cache rules.
- `README.md` → *Updates* — what the check does and what it deliberately cannot.
