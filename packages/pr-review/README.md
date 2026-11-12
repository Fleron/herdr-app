# Pull requests in Herdr

A personal PR review mod for the installed Herdr app on macOS. It adds a PRs
panel beside Files and Changes and opens a review mod beside an ordinary terminal.
The app and its shipped layouts are not rebuilt or replaced.

## Install

Requirements: the installed Herdr app and its `herdr-app` command, Git, an
authenticated GitHub CLI (`gh auth status`), Python 3 for installation, and Rust
for building the small helper. GitHub.com repositories on this computer are
supported. Remote machines and other Git providers are not supported yet.

From the `herdr-app` repository:

```sh
python3 packages/pr-review/install.py
```

The installer checks the current layout, builds the helper, checks the mod,
creates personal copies of the current layout and tab-bar mod, then adds PRs.
It uses unused names and never overwrites an existing mod or layout. The original
layout remains available in Herdr's layout menu. Personal copies do not receive
future upstream layout changes automatically.

Use `--home /path/to/herdr-home` for an isolated app. Use `--layout main` to copy
the standard layout instead of the current layout. The window for that home must
already be running; the installer never launches or restarts an app or core.

The command prints the installation name and the exact restore command. Restore
only changes the selected layout; PR terminals, drafts and checkouts are retained:

```sh
python3 packages/pr-review/install.py --restore pull-requests
```

## Data and refresh

The mod reads the active space's local repository and resolves its GitHub origin.
The panel groups open PRs into Merge queue, Ready for review, and Drafts. Ready for
review includes non-draft PRs whose checks fail. Queue membership comes from
GitHub's queue entry, rather than an auto-merge setting.

The panel refreshes every 30 seconds after first opening, and through Refresh or
`r`. Collection reads follow every cursor; page sizes do not limit the total
number of PRs. Checks use GitHub's aggregate counts. The approval indicator shows
GitHub's overall review decision. The overview lists actual current reviewers;
it does not invent a required-approval denominator.

The helper runs Git and GitHub CLI with the user's existing environment and
authentication. It fetches Git objects and stores owned checkouts, cached diffs,
drafts and review receipts under `HERDR_APP_HOME/data/pull-requests`. Credentials
remain with Git/GitHub CLI. The helper has per-request time and byte budgets;
exceeding one returns an error instead of a successful truncated diff.

The helper is a short-lived command, not a background service. Polling belongs to
the mod's view lifecycle. No claim is made that an unopened mod polls in the
background.

## Review tabs

Opening a PR focuses its existing tab when that tab still exists. Otherwise it
opens a new review tab with the configured shell in an isolated, detached
checkout. Tab identity is recorded from Herdr's returned IDs, not the tab title.

The diff is computed from the pinned commit objects. Editing the terminal's
checkout does not silently change the reviewed diff. Metadata refreshes may show
that a newer revision exists; updating code is an explicit action.

Before updating, the helper verifies the checkout registration, detached HEAD and
expected revision. It refuses dirty, switched or conflicting checkouts. It never
uses reset, clean or forced checkout. Conflicting ignored files are preserved.
Closing a review tab does not remove its checkout.

## Keyboard and clipboard

The accepted review UI includes its keyboard help. Navigation follows Vim's
`j/k`, `h/l`, `gg/G` and scoped movement commands. Viewed files fold; the changed
file tree remains on the left and can be resized.

`Cmd+Enter` opens the review composer and focuses its text field. In the composer:

- Enter inserts a newline.
- Escape leaves the text field.
- `j/k` cycles the review type; `1/2/3` selects Comment/Approve/Request changes.
- `i` returns to editing.
- Cmd+Enter submits the selected review type.
- Escape outside the text field closes the composer.

Copying produces clipboard text with repository, PR, file and revision context.
It never pastes into or executes commands in the adjacent terminal.

## Publishing

Only Submit or Cmd+Enter initiates a GitHub write. The helper checks the current
head and binds comments to the displayed commit and actual diff coordinates.
GitHub does not expose an atomic expected-head condition for review submission;
a concurrent push may still make a review outdated.

On submission the helper creates a pending review, durably records its ID, then
publishes that exact review. Repeated keys cannot start a second send. An
uncertain network result retains the draft and attempt state and requires
reconciliation with GitHub. A pending review created elsewhere is never silently
adopted or overwritten. An uncertain creation without a known ID requires an
explicit decision before another write.

## Development and validation

```sh
cargo test --manifest-path packages/pr-review/helper/Cargo.toml --locked
cargo clippy --manifest-path packages/pr-review/helper/Cargo.toml --all-targets --locked -- -D warnings
bun test packages/pr-review/tests
```

Validate the installed mod with `herdr-app check /path/to/home/mods/pull-requests`
and use an isolated Herdr home for populated-window checks. Git tests operate on
real temporary repositories, including changed checkouts and ignored conflicts.
Provider contract tests cover complete pagination, errors and interrupted review
submission. Live GitHub reads are safe smoke checks; a live review-write test
requires an explicitly agreed PR and review body.

The source package is `mods/pull-requests/` plus the helper and installer. Its
internal JavaScript modules stay under that one mod root; no shared app API or
cross-mod JavaScript imports are required.

The PR lifecycle icons are from [Primer Octicons](https://github.com/primer/octicons).
Their MIT notice is included in `mods/pull-requests/OCTICONS-LICENSE`; other status
icons use the installed Herdr assets.
