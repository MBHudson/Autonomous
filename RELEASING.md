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
4. **Put the feature where it will still be found.** [README](README.md)'s
   **What's new** holds only the current release, so a capability a release adds
   also needs a row in the ✨ **What's inside** table — one capability per row,
   with its emoji, in the words an operator would use — and, whenever it changes
   what a model or a stranger is allowed to do, a line under the 🔐 **Security**
   section's matching numbered rule. A fix with nothing new to name needs
   neither. When the next release lands, fold the previous entry into those two
   lists: once it leaves the top of the page, the table is the only place the
   feature is described.
5. **Run both suites:** `php tests/php/run.php` and `node tests/run.mjs` (which
   runs the PHP suite first, then the JS one).
   `tests/php/update.test.php` fails when `VERSION` is behind `APP_VERSION`,
   which is the mistake this checklist exists to prevent.
6. **Push.** Running copies get a notification in the bell on their next page
   load; the check is cached server-side for one hour, and nothing installs
   itself — **Config → Updates → DOWNLOAD UPDATE…** is still a manual,
   compare-first step.
7. **Tag it** — `v<VERSION>` and nothing else. See *Tags* below.

## Tags — one scheme, from here on

The tag is the name a stranger reads on the releases page, and the thing a directory listing or a
package manager keys on. It is not a status field.

**Format:** `v` followed by the integer in `VERSION`, exactly — `v447`, `v448`. No suffix.

| Do | Do not |
| --- | --- |
| `v448` | `v448-Open-Testing`, `Open-Testing-v448` |
| `v448`, with the release marked **pre-release** | `v448-beta`, `v448-rc1` |
| one tag, one commit, never moved | a tag re-pointed at a later commit |

**Status belongs in the release, not in the tag.** A build you want to call "open testing" is a
GitHub *pre-release*: the tag stays `v448`, the release is marked pre-release, and the body says what
is unproven. That keeps the tag immutable and the channel explicit, instead of encoding a mood into
the one string that is meant to be permanent.

```bash
git tag v448                       # on the commit that bumped VERSION
git push origin v448
gh release create v448 --title "v448 — one short phrase" --notes-file notes.md
# add --prerelease only when it really is one
```

**The title carries the story, the body carries the changelog.** `v447 — Tunnels leave the terminal`,
followed by that release name in the CHANGELOG entry, verbatim. A title of "v448" alone tells a
reader nothing, and "various fixes" tells them less.

**The tag must agree with `VERSION`.** If `VERSION` says 448 the tag is `v448`. There is no release
where the two differ, and no tag for a number that was never shipped.

**History stays where it is.** `v358-Open-testing`, `Open-Testing-v365`, `v374-Open-Testing`,
`v381-Open-Testing` and `v437-Open-Testing` already exist with inconsistent naming. They are not
renamed or deleted: a moved tag breaks every clone and every link that pinned it, and the cost lands
on whoever tries to reproduce an old build six months from now. The scheme starts at the next
release — and `v410` and `v447` are already in the target shape, so there is nothing new to invent.

**One release, one tag.** Not one per commit. A release is a decision that the tree at that commit is
installable, and `VERSION`, the CHANGELOG entry and the tag should all describe that same commit.


## The one caveat

A copy that predates `VERSION` has no release number to compare, so it can only
see the **cache-buster**. If a release has to reach those copies, bump the
cache-buster as well — it costs every browser one re-download, which is why it is
worth bumping only when it buys something. (The release that introduced `VERSION`
did exactly that, once.)

## Pushing a workflow file

Everything above pushes with an ordinary `git push`. There is one exception: a
commit that creates or edits a file under `.github/workflows/`.

GitHub refuses those from a credential without the **`workflow`** scope, and it
refuses them at the very end, after the objects have already been sent:

```
! [remote rejected] master -> master (refusing to allow an OAuth App to create
  or update workflow .github/workflows/tests.yml without `workflow` scope)
```

The trap is that the message blames the *OAuth app* even when a perfectly good
token is sitting in the repository. `gh auth login` mints a token with `gist`,
`read:org` and `repo` only, and installs itself as a git credential helper.
Helpers are consulted in order and the first answer wins, so putting a
`workflow`-scoped token on the machine changes nothing -- git never asks for it.

**Where the token lives.** `.gh-workflow-token` in the repository root: one
classic personal access token (`ghp_...`, 40 characters, scopes `repo` and
`workflow`), with no quotes and no second line. The name is in the tracked
`.gitignore`, so every clone and every `freshClone.php` copy already refuses to
stage it; this clone also lists it in `.git/info/exclude`, which covers the same
name a second time and is worth knowing about when one of the two is edited.
Never commit it, and never paste it into a commit message, an issue or a chat.

**How this checkout is wired.** The repository-local config stops inheriting the
system helpers and answers with that file instead:

```bash
git config --local credential.helper ""
git config --local --add credential.helper '!f() {
  echo username=x-access-token
  echo "password=$(tr -d "[:space:]" < "$(git rev-parse --show-toplevel)/.gh-workflow-token")"
}; f'
```

The path is built from `git rev-parse --show-toplevel` rather than typed out: the
helper runs from wherever git was invoked, and an absolute path to one machine's
checkout is the kind of thing that works for its author and for nobody else.

The `tr -d "[:space:]"` is load-bearing: a trailing newline or a CRLF paste ends
up inside the Authorization header, and the push fails with a 403 that says
nothing about scope. To undo the wiring, `git config --local --unset-all
credential.helper` and `gh`'s keyring token takes over again.

**Check it without printing the secret.** The username is enough to tell which
token answered, and the length without the value says which one it is:

```bash
printf 'protocol=https\nhost=github.com\n\n' | git credential fill |
  sed -n 's/^username=//p'                                 # x-access-token
printf 'protocol=https\nhost=github.com\n\n' | git credential fill |
  sed -n 's/^password=//p' | wc -c                         # 40 = the PAT, 36 = gh's
```

To ask a token directly whether it can do this at all, `gh api -i user | grep -i
x-oauth-scopes` with that token in `GH_TOKEN`. A list without `workflow` cannot
push a workflow file, whatever else it is allowed to do.

Nothing above is needed for an ordinary release: only the release that adds or
edits the workflow itself pays for it.

## Where this is enforced

- `src/Update.php` — `check()` probes both files; `isNewerVersion()` decides.
- `tests/php/update.test.php` — the drift guard, plus the parsing and cache rules.
- `README.md` → *Updates* — what the check does and what it deliberately cannot.
- `.github/workflows/tests.yml` — the runner this section exists for; its scope
  requirement is enforced by GitHub, not by a test here.
