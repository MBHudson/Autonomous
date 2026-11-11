# Contributing

Thanks for looking. Bug reports and pull requests are both welcome.

## The quick version

- Open an issue before a large change, so we don't build the same thing twice.
- Keep the project's constraint: **the app stays plain PHP with no build step and
  no runtime dependency install.** No `composer.json` at runtime, no `package.json`
  for the app. Node is only ever needed to run the JS tests.
- Tests: `node tests/run.mjs` (PHP first, then JS). A change that touches the
  sandbox, the guards, the harness or the update installer should come with one.
- Match the surrounding style — the codebase comments *why*, not *what*.

## Sign-off (Developer Certificate of Origin 1.1)

Contributions are accepted under the same license as the project,
**Apache-2.0**. By making a contribution you certify the Developer Certificate of
Origin below, and you agree the contribution is licensed under Apache-2.0.

Add a sign-off to each commit:

```bash
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Your Name <you@example.com>
```

### Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
