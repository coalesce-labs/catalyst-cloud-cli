# @catalyst-cloud/cli

[![skills.sh](https://skills.sh/b/coalesce-labs/catalyst-cloud-skills)](https://skills.sh/coalesce-labs/catalyst-cloud-skills)

## Install

Set up Catalyst Cloud and manage your account from the command line.

Check ticket progress and see which decisions need your attention.

Install: `npm install -g @catalyst-cloud/cli`

[CLI documentation](https://github.com/coalesce-labs/catalyst-cloud-skills#readme)

Run the installer, then run `catalyst onboard`:

```sh
curl -fsSL https://staging.catalystcloud.dev/install.sh | sh
catalyst onboard
```

The installer puts the CLI and both skill packs on this machine and connects it with one browser approval. Run `catalyst onboard` to finish setup from the command line. You can also use the onboarding skill in your coding agent after that. Everything else on this page is the reference.

This repository supplies skills for setting up and operating your Catalyst Cloud account. A coding workstation also uses [`coalesce-labs/catalyst-dev-skills`](https://github.com/coalesce-labs/catalyst-dev-skills) for research, planning, implementation, review, and shipping.

Or by hand. One command, for every coding agent on the machine:

On an existing machine, inspect same-named skill paths before running either add command. The
commands replace existing directories and links; the inspection rule is below.

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

It installs every skill in the bundle for each agent it detects (Claude Code, Codex, Cursor, OpenCode and the rest). A coding workstation also installs the development pack:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
```

The two packs have different jobs and independent versions. Omit `-g` for a project-scoped Cloud skills install. Copied skills do not auto-update. Re-adding the pack also picks up newly added skills; `npx skills update` refreshes only names already in the lock. Before an add or refresh, inspect the active global lock at `$XDG_STATE_HOME/skills/.skill-lock.json` when XDG state is set, or `~/.agents/.skill-lock.json` otherwise. A project install uses its own `skills-lock.json`. Check every same-named agent path, not just the canonical lock entry. Proceed only if each destination is absent or a verified, unmodified copy of the intended pack or its symlink. Leave independent, changed, or uncertain copies in place. Do not schedule raw add commands as an unattended refresh. After that check, re-run the Cloud add command above with `-g` for a workstation or without `-g` inside a project.

<details><summary><strong>Alternative for Claude Code: the plugin marketplace</strong></summary>

The plugin installs this pack's same `skills/` tree as a managed bundle, and `catalyst update` moves it to the version your workspace approved (see [Updating](#updating)). It needs a GitHub SSH key, and it does not load into the session you are already in — run `/reload-plugins` or restart afterwards. Pick one rail for this pack; installing both leaves you with every skill twice. The development pack has its own optional Claude plugin, `catalyst-dev@catalyst-dev-skills`.

```
/plugin marketplace add coalesce-labs/catalyst-cloud-skills
/plugin install catalyst@catalyst-cloud
```
</details>

<details><summary><strong>One agent at a time</strong></summary>

Codex:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a codex
```

Cursor:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a cursor
```

OpenCode, Amp, Windsurf and the rest:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills
```

Without `--all` the installer asks which skills to take and which agents to install them on.
</details>

### Then connect to your cloud account

The skills call one CLI, and the CLI holds your credential. Install it once and connect this machine — the keyless way logs you in as yourself, with nothing to mint or paste:

```sh
npm install -g @catalyst-cloud/cli
catalyst login
catalyst ready
```

`catalyst login` with no key opens a device-code login: it prints a short code and a URL, you approve it in your browser, and this machine is connected as you. On a machine with no browser (a remote box, a container) the code and URL still work — approve them from your phone. The short-lived session refreshes silently afterwards, so you log in about once a year. `npx -p @catalyst-cloud/cli catalyst login` works without the global install, and `bunx` works in place of `npx`. A non-default cloud is set with `CATALYST_CLOUD_BASE_URL` or `--base-url <url>`.

For a script or an unattended machine, where nobody can approve a code, pass a **personal key** instead. Minting one is a browser step: Settings → API keys in the Catalyst Cloud app (every member can; no admin needed). The environment form keeps it out of your shell history:

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst login
```

`--key <your-personal-key>` is the third form, for a script.

After a workspace owner connects your cloud account's Linear workspace, connect your personal Linear account. Connect your personal GitHub account only after the workspace's GitHub App is installed and its repository is registered. These personal grants are separate from the workspace's Linear connection and GitHub App installation. Your agent can start each connection and check whether it landed, but you approve each one in your browser:

```sh
catalyst connections personal linear start
catalyst connections personal linear status
# First install the workspace's GitHub App and register its repository:
# catalyst onboard --team <KEY> --repo <owner/name>
catalyst connections personal github start
catalyst connections personal github status
```

Each `start` prints a short-lived URL and attempts to open your browser. On a remote machine, open the printed URL on your own device. `status --json` gives the same result to an agent; `start --wait 60` waits up to one minute for approval. A connected result is the proof that the grant landed. If a provider reports unavailable, retry status later rather than starting a second approval.

The `catalyst-onboard` skill checks both grants before taking you through the rest of setup and the first ticket.

The command is `catalyst`. `catalyst-skills` still works as a deprecated alias, and `@catalyst-cloud/catalyst-skills` is the deprecated package name that forwards to this one.

## What this is

A set of skills that let your coding agent run your own Catalyst Cloud account (https://staging.catalystcloud.dev) from your seat: what is happening, what needs you, and what to do about it. They read your account through the Catalyst Cloud SDK, write to it through the account's agent proxy, and never compose a URL or run a tool of their own; every read, write and live watch is a `catalyst` verb with `--help`. Every skill is plain Markdown under `skills/<name>/SKILL.md` in this repository, and your own login — a keyless device-code session, or a personal key — is the only credential. Your agent acts as you: the asks it raises and the comments it posts carry your name, and "what needs me" means you.

## What connecting does

`login` does three things: it calls `GET /api/v1/me` with your credential, which discovers your cloud account and who you are from the credential alone; it writes `~/.config/catalyst-cloud/customer.json` with file mode `0600`, holding your credential (a keyless login session, or a personal key), who you are (id, label, role, your Linear user id) and the absolute path of the CLI so every skill script can spawn the same binary; and it fetches your account's contract (`GET /api/v1/agent/contract`) and caches it at `~/.config/catalyst-cloud/contract.json` with its ETag, so stage names and ids, label ids, the ask template, thresholds and the route table come from your account, live, and no skill restates them.

A keyless session's access token is short-lived and rotates on its own: every request refreshes it within a minute of expiry and rewrites the config atomically, so you stay connected for months without logging in again. You only log in again if the session is revoked or you have been away long enough to lapse — then one clear line tells you to run `login`.

`login` does not install skills; the install command above did that. Re-running `login` after a key rotation, or to switch rails, rewrites the config. `catalyst status` prints which cloud account this machine is connected to and as whom, `catalyst ready` prints one READY or NOT READY verdict with the fix for each failure and who can apply it, and `catalyst --version` prints the package version and its pinned contract range.

The setup skill Catalyst seeds into your repository ends by pointing at this same command. That served skill lives in the Catalyst Cloud application, not here; this is the only connect step a customer runs. Your cloud account's **account key** (minted by `catalyst onboard --runner`, run by an owner or admin) is a different credential — for a host or daemon that runs unattended — and is not what a person connects their own agent with: it would strip your name from everything your agent writes, and `login` says so if you use one.

## Run and resume setup

Run `catalyst onboard` for the steps supported by your installed CLI and cloud. The command shows its plan, opens supported browser consent links and saves progress. Resume with the same command; it rechecks completed steps before continuing. A missing cloud capability stays unfinished. In an interactive terminal, use the arrow keys to review the plan and choose cloud reads or optional local sync. Browser waits show progress. `--yes`, `--json`, `--dry-run` and non-terminal output stay plain.

```sh
catalyst onboard --dry-run --json
catalyst onboard
catalyst ready --onboarding --json
```

`catalyst setup` opens with the Catalyst Cloud mark in your terminal's colours. It asks the terminal whether its background is light or dark; set `CATALYST_THEME=light` or `CATALYST_THEME=dark` when it guesses wrong. `--no-color` or `NO_COLOR` prints plain text without the mark.

The dry run writes no files. `--only <step>` runs one step and reports its scope separately from full onboarding. Exit 10 means a failed step, 11 means waiting, and 12 means a guard refused the action. The private receipt is `install/last-run.json` under your machine's Catalyst state directory; credentials stay in the login config. A fake HOME reports old services and keeps them intact.

### Codex launches name their coding account

When Codex is on this computer (a `codex` command on your PATH, or `Codex.app` in `/Applications` or `~/Applications`), setup adds a `codex` shell function to `~/.zshrc` and `~/.bashrc`, between the lines `# >>> catalyst codex attribution >>>` and `# <<< catalyst codex attribution <<<`. It writes to each of those files that exists, and creates one only for your login shell (`$SHELL`), so a Mac that uses only zsh gets no `~/.bashrc`. Bash on macOS reads `~/.bash_profile` rather than `~/.bashrc`, so if you use bash and your `~/.bash_profile` does not already source `~/.bashrc`, add the line `[ -f ~/.bashrc ] && . ~/.bashrc` to it. Each time you run `codex`, the function asks `catalyst codex-env --print` which coding account the Codex home in use (`$CODEX_HOME`, else `~/.codex`) is signed in to, and passes the answer to that one launch as `OTEL_RESOURCE_ATTRIBUTES`. The answer comes from a local cache, so a launch never waits on the network. Running setup again replaces the block in place. Setup leaves a file alone, and says why, when it already defines `codex` as a function or an alias of yours, or when it is a link to a file outside your home folder. A link to a file inside your home folder is followed, and the file keeps its permissions.

On a Mac, setup also installs the `dev.catalystcloud.codex-attribution` LaunchAgent. It runs `catalyst codex-env --apply` when you log in, and again whenever Codex signs in to another account in its default home, so apps you start from the Dock or Finder, the Codex desktop app included, carry the same attributes. An app that is already open keeps the environment it started with. It picks up a change the next time it starts. On Linux, setup adds the shell function only. Without Codex, setup adds nothing and says it skipped this. Run `catalyst setup` again after you install Codex to add it.

`catalyst status` ends with one line that says whether this is installed, which coding account the Codex home resolves to, and how old the cached account list is. `catalyst setup --no-shell-hook` skips all of it. On a machine that is already set up, `catalyst setup --only codex-attribution` adds just this and runs no other step. Before it first changes `~/.zshrc` or `~/.bashrc`, it keeps a copy of the file beside it, ending in `.before-codex-attribution`. Run again, it reports each file as unchanged. With `--dry-run` it prints the exact block each file would get and the LaunchAgent file, and changes nothing. A Codex home other than the default one sends no telemetry until its own `config.toml` has an exporter. Name it with `--codex-home <dir>` (repeatable): when it is logged in to one of the workspace's coding accounts and has no exporter of its own, setup copies the default home's `[otel]` tables into it, after keeping a copy of its `config.toml` beside it. A dry run shows those tables with every header value as `<hidden>`. A home that already has an exporter, or whose login is not a workspace coding account, is left as it is. `catalyst setup --remove-codex-attribution` removes it and runs nothing else; with `--codex-home <dir>` it also takes the copied exporter out of that home's `config.toml`. Each file goes back to exactly what it was before the block was added, the LaunchAgent is unloaded and deleted, and the two attributes it set (the coding account and the machine name) are taken back out of the launch environment. Attributes you set there yourself are kept. A fake HOME gets none of this.

### Headless setup (CI, image builds, agent VMs)

`catalyst onboard --headless` (or `CATALYST_ONBOARD_HEADLESS=1`) is for a machine with no person at it. It assumes every browser approval already happened: the person's key exists, and Linear and GitHub are connected for the workspace and the person. It never prompts, never opens a browser and never starts the device sign-in. Every input comes from a flag, an environment variable or a file:

| Input | Flag | Environment |
|--|--|--|
| Personal key (Settings → API keys) | `--key-file <path>` | `CATALYST_CLOUD_TOKEN`, or `CATALYST_CLOUD_TOKEN_FILE` |
| Linear team | `--team <ID or key>` | `CATALYST_ONBOARD_TEAM` |
| Repositories | `--repo <owner/name>`, repeatable | `CATALYST_ONBOARD_REPOS` (comma or space separated) |
| Coding account | `--coding-account <slot>` (`catalyst accounts` lists them) | `CATALYST_ONBOARD_CODING_ACCOUNT` |
| Runner opt-in | `--runner yes\|no` | `CATALYST_ONBOARD_RUNNER` |
| Cloud | `--base-url <url>` | `CATALYST_CLOUD_BASE_URL` |

A flag wins over its variable. A machine that already has a saved login needs no key. The key is never accepted on the command line: `--key` under `--headless` exits 12, because other processes can read argv. A key file must be a regular file, owned by this user or root, that other users cannot write. A key for another person than the machine's saved login or setup record exits 12 and leaves the saved login as it was. With `--dry-run`, nothing is saved and no network call is made. The steps run without the key in their environment. The key is saved in the login config (mode 0600), the same as `catalyst login --key`, and it never appears in the output, the log or the receipt. In an image build, run setup when the container starts, or remove `~/.config/catalyst-cloud/customer.json` in the same step, so the key does not stay in a layer.

Before any network call, the run checks that every input is present. Each missing input is named with its flag and variable, and the run exits 11 at once. A browser approval that does not exist yet is never started. Its step waits with a named reason, and the item's `url` is the page that fixes it:

| Step | Reason | Page |
|--|--|--|
| Linear for the workspace | `linear_workspace_grant_missing` | Settings → Connections |
| GitHub App for the workspace | `github_app_grant_missing` | Settings → Connections |
| The person's Linear | `linear_personal_grant_missing` | Settings → Connected accounts |
| The person's GitHub | `github_personal_grant_missing` | Settings → Connected accounts |

With a person at the terminal, `catalyst onboard` starts each of these approvals itself and prints the exact link to approve.

With `--runner yes`, setup starts the self-hosted runner and verifies enrollment, advertised capacity and team admission. This needs Docker with Compose, pinned host images and an organization key file (`CATALYST_RUNNER_ORG_KEY_FILE`). When images, a key or admission are missing, exit 11 names that gate. A failed setup step exits 10. Use `--runner no` to skip the machine's runner. Unlike the interactive optional runner step, an explicitly requested headless runner must finish before exit 0. On a Mac, setup also installs the `dev.catalystcloud.host-disk` LaunchAgent, which measures the Mac's free disk space every 10 seconds, because Docker's virtual machine cannot see it. It needs Python 3 from Apple's Command Line Tools or Homebrew. When the machine takes no work because the disk Docker uses has less than 25 GiB free (`CATALYST_HOST_FREE_FLOOR_GIB` changes the amount) or has no fresh measurement, exit 11 says which, with the fix, and `catalyst ready` fails its `runner:disk` check the same way. If setup cannot tell which folder holds your Docker engine's disk image, set `CATALYST_HOST_DISK_PATH` to that folder.

### Stopping or removing this machine's runner

Run these on the machine itself:

| command | what it does |
| -- | -- |
| `catalyst runner stop` | The machine takes no new work. Work it already started finishes or reaches its deadline. Its registration, settings and checkouts are kept, and `catalyst hosts` shows it as `stopped`. |
| `catalyst runner start` | Starts it again with the same registration. |
| `catalyst runner status` | Says whether it is running, stopped or not installed. |
| `catalyst runner uninstall` | Asks first (`--yes` confirms without a terminal; an owner or admin login is needed). It stops new work, revokes the machine's registration and the runner key setup issued, and switches the project's runner admission off when no other machine runs it. Then it removes the runner's containers, their volumes and the session network, and the setup files in the runner folder. On macOS it also removes the storage LaunchAgent and its folders, and the disk-measuring LaunchAgent setup installed. On Linux it also removes the session-egress units, their script and state, and the `inet catalyst_session` nftables table, through `sudo`. |

Uninstall removes only what setup created. Anything that does not match what setup wrote, such as a network with another label, a changed unit file or a disk-measuring LaunchAgent that writes somewhere else, is left in place. Your repository and thoughts checkouts are kept unless you add `--delete-checkouts`. The command ends with a "Left behind" list naming everything it did not remove. When a step fails, such as a cloud call while you are offline, it says which one and exits 1. Run it again: it picks up where the last run stopped. Do not delete the runner folder by hand while the runner is installed. That deletes its settings while its containers keep running.

With `--json`, stdout carries exactly one document: the onboarding receipt plus a `headless` block (`schema: "catalyst-onboard-headless/1"`). The block holds the resolved `inputs` (the key appears only as its source: `env`, `file` or `saved`), and lists of items under `missing`, `refused`, `failed`, `deferred` and `warnings`. Each item has `id`, `kind` (`input`, `grant` or `step`), `reason` and a one-line `text`, plus `flag`, `env` and `url` where they apply. Everything else goes to stderr.

| Exit | Meaning |
|--|--|
| 0 | Ready for work. Optional steps can still be listed under `deferred`. A `--dry-run` exits 0 for a plan; its verdict stays `not-ready`. |
| 10 | A step failed. See `failed`. |
| 11 | Something is missing: an input, a browser approval or a step that waits. See `missing`. |
| 12 | Refused: a key on the command line, a key file other users can write or own, a host key instead of a personal key, a key for another person than the saved login, a malformed runner choice or an unknown option. See `refused`. |

```sh
# CI or an agent VM: the key comes from the secret store as an environment variable.
CATALYST_CLOUD_TOKEN="$CATALYST_KEY" catalyst onboard --headless --json \
  --team ENG --repo acme/api --coding-account claude-one --runner no
```

Local sync is optional. Include it in the plan with `--local-sync` when you need local SQL or sustained local reads. A resume keeps that choice. Readiness distinguishes failed checks from missing evidence and reports observed project work separately from unfinished setup.

## Requirements

- Node 22.15 or newer (Node 26 works), or bun 1.4 or newer. The bundle uses Node's built-in SQLite module (and, on bun, bun's own `node:sqlite`) for the optional local replica, so there is no native dependency to build; if `better-sqlite3` resolves on the machine it is used instead. `catalyst ready` names the exact reason when the runtime is too old, and `catalyst runtime install` installs a pinned Node under this CLI's own cache — without touching your machine's default Node — if you would rather not upgrade it.
- Your own login: a keyless `catalyst login`, or for an unattended machine a personal key you mint at Settings → API keys. The credential is the only account selector: you never type an account id. If your Linear identity is not matched yet, `login` says so; you match it yourself with `catalyst identity linear set` (an identity someone else already claims needs an admin at Settings → Members), and until then "what needs me" shows everyone's asks.
- An agent that discovers skills. Claude Code loads the plugin; Codex, Cursor, OpenCode and the rest read the `skills/<name>/SKILL.md` files the `npx skills` installer writes.
- Bun is optional, only if you prefer `bunx` over `npx` — bun 1.4 or newer, which is when `node:sqlite` arrives; older bun cannot run this CLI at all.

## First use

Open a new session and ask about your own cloud account. The skills read the config `login` wrote. For example:

- What's happening? Where are we, why is that stuck, what closed, what's next?
- What needs me?
- Run this project for me until it closes.
- Am I set up?

`catalyst team list` inventories visible teams without running readiness checks. `team check ENG` prints readiness for one team; `team check --all` runs checks for every team. `team map ENG`, `team adopt ENG`, and `team migrate ENG` print a plan and exit 3 before changing configuration; review the plan and rerun the chosen command with `--yes --plan-hash <hash>` from that preview. `team adopt ENG --undo` previews the exact previously created stages, and `team migrate ENG --retire` requires its own confirmation after the ticket move. `team checklist ENG` prints the same manual setup lines as the browser. These commands use the member's own login; an admin or owner seat is required for setup, and Adopt and Migrate also need that member's personal Linear connection.

## Repository status and pauses

Use your existing login to list the repositories visible to you, their status and attached projects:

```sh
catalyst repo status
catalyst repo status --json
catalyst repo pause acme/app --reason "flaky deploy"
catalyst repo resume acme/app --reason "deploy fixed"
catalyst repo resume acme/app
```

Any workspace member can read status. Pausing or resuming requires a workspace owner or admin. Pause requires a reason; resume accepts an optional reason. A supplied reason must contain 1 to 500 characters after trimming. These commands work outside a local checkout.

Paused rows show who paused the repository (their email, or the key or operator that paused it), when and why, when those details are available. An empty list means no repositories are visible to your login. After a write, the command reads and prints the repository's current state. If that read fails, it reports that the write succeeded and status could not be read; check `catalyst repo status` before repeating a write.

`--json` preserves the list response for status and prints the refreshed repository row for a write. An older cloud reports that repository status is not served yet and needs a newer cloud. Agents can use `catalyst capabilities --json` to check route availability against the cached cloud contract.

## Open pull requests over time

Print how many pull requests a repository had open, one row per day or per hour:

```sh
catalyst flow --repo acme/app --period 2w --granularity day
catalyst flow --repo acme/app --period 24h --granularity hour --json
catalyst flow
```

```text
$ catalyst flow --repo acme/app --period 2w --granularity day
2026-10-12  27
2026-10-13  31
...
2026-10-25  24  (now)
```

Each row is one bucket: its start, then the number of pull requests open at its end, drafts included. Daily rows show the date; hourly rows show the time with its UTC offset. Days start at midnight in your workspace's time zone, as the cloud reports it. The last row ends now and is marked `(now)`. A row reads `unavailable` when your workspace cannot attribute pull requests to that repository.

`--period` is one of `24h`, `2d`, `3d`, `1w`, `2w`, `4w`, `12w` or `26w`, and defaults to two weeks. `--granularity` is `hour` or `day`; left out, the period picks the width: one, two or three hours for `24h`, `2d` and `3d`, and a day for the week periods. Hourly rows over a long period can be too much for one answer; the command then exits 2 and suggests daily rows or a shorter period.

Without `--repo`, the command reads this checkout's GitHub origin and uses it when it is a repository of your workspace. Anywhere else it exits 2 and asks for `--repo owner/name`. Any workspace member can read it.

`--json` prints one JSON array with one entry per bucket, exactly as the SDK's `flow.series()` returns them in `series.columns`: `startMs` and `endMs` in epoch milliseconds, `label`, `partial`, and `pr` with `open` and the bucket's other pull request counts.

## What has to be running

Nothing, by default. After `login`, every read, write, ask and explanation goes to the cloud's origin-fresh API with the config file and the cached contract on disk. Two optional processes exist for people who want them:

| process | needed for | what it holds on disk | lifetime |
| --- | --- | --- | --- |
| none | every read, write, ask and explain | `customer.json` and `contract.json` | the default after login |
| `catalyst replica start` | local SQL, cheap repeated reads, and a shared local event cache read with `events ... --from-cache` | one SQLite file plus a bounded event cache under `$XDG_STATE_HOME/catalyst/events/` (fallback `~/.local/state/catalyst/events/`) | one long-running process; foreground by default, `--detach` writes a pidfile beside the database and returns; `login --start-replica` does the same at the end of login |
| `catalyst watch` | a project owner reacting to its scope | one cursor file (`~/.config/catalyst-cloud/watch-cursor.json`) stamped with the account | lives inside the session that armed it; exits with it |

CLI and skill reads use the cloud API by default, including on a machine with a fresh local replica. No background writer or local database is needed. `catalyst query ... --source replica` explicitly chooses the optional local view; the first stderr line names the source. Local sync does not promise offline browsing.

For a local view, `catalyst replica status` checks the writer, heartbeat and cursor. It exits `0` for fresh, `1` for present but stale, `2` for not connected, `3` for absent. `replica status --probe` compares its cursor with the cloud head. These diagnostics do not change the default read source, and an absent replica does not make `catalyst ready` fail.

`catalyst events tail`, `wait-for`, `query` and `status` read from the cloud by default, with no local file. `events tail` prints one JSON line per new event and stays in the foreground; `events wait-for --ticket ... --timeout ...` prints the first match and exits 0, or exits 1 when none arrives in time; `events query` reads one page of filtered history (`--ticket`, `--type`, `--limit` up to 200, `--order desc|asc`, `--before`, `--after`); `events status` names the cloud head.

`events wait-for` can also wait on a repository (`--repo owner/name`), a branch (`--ref owner/name:branch`), a pull request (`--pr owner/name#n`), a phase session (`--session TICKET/phase#n`), events addressed to you (`--to me`), or a family of types (`--type pr.*`). Values of one flag are OR'ed and different flags are AND'ed, and `--repo`, `--ref`, `--pr` and `--session` can repeat. Such a wait holds one connection and prints nothing until a match, so a long `--timeout` such as 14400 costs nothing while it waits. It prints every matching event as one JSON line. After a dropped connection it replays from its cursor, so no event is missed or printed twice.

| `wait-for` exit | Meaning |
| --- | --- |
| 0 | a match, printed on stdout |
| 1 | none arrived in time; with a scope flag, stderr names the `--after` to resume from |
| 2 | the cloud refused the wait (for example a ticket outside your teams), or the wait failed; stderr gives the reason |
| 3 | `--from-cache` and the local event cache is absent or its writer stopped |
| 4 | the cloud was unreachable for five attempts in a row: an outage, not a timeout |
| 130 | interrupted |

`catalyst messages read --ticket KEY-123 [--since SEQUENCE]` prints the messages sent to a ticket on your teams, with each sender and time, for example after a wait on `--type comms.message.posted` returns.

Add `--from-cache` to read this machine's local event cache instead, which pays off when several agents on one machine share one cloud connection. `catalyst events status --from-cache --probe` checks the cache's own cursor against the cloud head; `replica status --probe` checks the separate entity-replica cursor. A fresh replica does not prove event freshness. The replica process is the single writer and reports an event-sync failure without terminating a healthy entity replica. The event cache keeps closed daily segments for at most seven days or 256 MiB per account and reports an explicit gap when a requested sequence has retired.

The replica is a Node process, not a service: the supported path is the plain command, and `skills/catalyst-onboard/references/local-sync.md` gives launchd and systemd examples for people who want the writer to survive a reboot.

## The skills

| skill | what the person says | what it does | file |
| --- | --- | --- | --- |
| `catalyst-onboard` | "Set me up. I just signed up. Am I set up? What is missing? Log me in." | Walks you from nothing to your first ticket running, one step at a time: connect this machine, connect the workspace and your personal provider accounts, map one project, register one repository, then watch a card move. Afterwards it answers "am I set up?" with one READY or NOT READY verdict and who can fix each failure, logs a machine in again, and checks the optional local replica. Hands over browser consent and settings steps without claiming they happened until a status check confirms them. | [`SKILL.md`](skills/catalyst-onboard/SKILL.md) |
| `whats-happening` | "What's happening? Why is that stuck? How does this work? How does it prioritise?" | The desk for your account: reads the contract, what is running and queued, the eligibility explainer, the coding accounts and the open asks, and answers in one reply with ticket ids. Carries the facts behind the answers: the ladder, the stage map, failures, parks and holds, the queue order and every reason a ticket is excluded. Routes work to a project owner and decisions to `what-needs-me`. | [`SKILL.md`](skills/whats-happening/SKILL.md) |
| `what-needs-me` | "What needs me? What am I blocking?" | The human's decision inbox, ranked by how much open work each ask holds, and the one way an agent raises a decision on their behalf: files an ask through the cloud's ask route with the account's own template and records the answer so the held work releases. | [`SKILL.md`](skills/what-needs-me/SKILL.md) |
| `run-this-project` | "Run this project for me. Own it until it closes." | Single-threaded owner of one project: subscribes to the account's event stream for its scope, reacts to each change in the same turn, makes tickets ready and moves them to dispatch, parks what should stop, chases stalls, escalates inward, and keeps one status summary current. Never polls. | [`SKILL.md`](skills/run-this-project/SKILL.md) |
| `catalyst-linear` | "Show me the ticket, the history, what Catalyst wrote on it." | Reads a ticket with its comments, relations, labels, linked pull requests and agent sessions inline, from the cloud API by default, with explicit local opt-in and the source named; writes comments, card moves, labels and new tickets as the app actor; knows what a ticket accumulates as Catalyst works it. | [`SKILL.md`](skills/catalyst-linear/SKILL.md) |
| `catalyst-github` | "Show me the PR, the checks, the review, the queue." | A ticket's pull request with its checks, reviews and review threads; whether it is mergeable under the repository's policy; what a PR accumulates as the ticket moves (the branch, the draft, the rewrite, the force-pushes, the labels, the queue). | [`SKILL.md`](skills/catalyst-github/SKILL.md) |
| `unstick` | "Why is this parked? Unpark it. Get things flowing again." | Reads why a ticket is not running and every park or hold on it, decides whether the recorded cause is fixed, previews the release and releases it the right way from your own login — or one failure class across a team — and raises an ask only for what a person has to do. | [`SKILL.md`](skills/unstick/SKILL.md) |
| `what-this-repo-needs` | "What env vars does this repo need? What belongs in its environment declaration?" | Scans a repository offline — no login, no network — and lists the environment variable names it needs, grouped build/test, deploy-only and bindings, each with where it was found, what uses it, and where a local value would come from. Never reads or prints a value. Also checks TOML syntax and the environment variable table in `.catalyst/catalyst.toml`. | [`SKILL.md`](skills/what-this-repo-needs/SKILL.md) |

Some of these only read, and some write: a comment, a card move, an ask, a release. Your agent may pick any of them from what you ask. Picking a skill is not permission to write: each write goes through your own login, spends the daily write budget your account sets, and is recorded against your name, and the skills preview first where the product offers a preview (a release's dry run, a stage mapping's plan). Each skill's `agents/portability.yaml` says whether it writes. Every skill declares `allowed-tools` scoped to this package's own binary, so none of them needs a blanket shell grant.

## What a key cannot see yet

Your personal key reads everything the skills need — tickets, pull requests, the eligibility explainer, the dispatch queue, fleet activity, per-ticket execution history (`catalyst explain --history <ticket>`: phase attempts, remediation rounds, park state) and coding-account status (`catalyst accounts`: provider, declared and observed state, usage limits, walls, quarantine — never a credential; enrolling or pausing one is `<your cloud>/settings/coding-accounts`, with no command yet). It also releases a parked or held ticket once its cause is fixed: `catalyst release <ticket> --because <what changed>` (the `unstick` skill runs it), recorded against your name and shown in the ticket's history. And it declares what your containers need: `catalyst environment` reads the account-wide declaration, `environment propose --file <path> --approve` proposes and approves it in one compare-and-set, and the values behind the names stay in the cloud — reading needs any active seat, proposing and approving need an admin or owner one. An admin or owner can put a repository's values in from the terminal. `catalyst secret import .env --repo owner/name` stores every name in the file and lists the declared names that still have no value. `catalyst secret set NAME --repo owner/name --command 'op read op://Vault/item/field'` runs the command on your machine and stores its output; with no `--command` it reads the value from stdin, or asks for it without echoing. No value is ever printed, and the cloud's audit records the command, not its output. That is the account's own declaration — a repository's own `.catalyst/catalyst.toml`, which `catalyst-onboard` already reports on, is a separate thing. `catalyst env inventory` lists the environment variable names a repository needs — never a value; `env check` checks the TOML syntax and environment variable table in `.catalyst/catalyst.toml` offline; `env migrate [catalyst.env.json]` prints a TOML environment table from a legacy declaration, with all names optional and values omitted. `env draft --write` writes a new `.catalyst/catalyst.toml` from the repository's files and from this computer — the names the repository's `.envrc` exports, and Claude Code's HTTP MCP servers with each header as a variable reference — then offers to store this computer's values; `catalyst env import` stores them later. A value is never written to the file or printed. These commands need no login, except `env import` (the `what-this-repo-needs` skill walks through them). Two things it cannot do, and the skills say so by name rather than guess:

- Read pull-request labels or the reviewer's reaction. The mirror does not carry them; GitHub's own page does.
- Compute a flow number — cycle time, throughput, or how long pull requests have been open. Nothing serves those yet, so say they are not computed rather than counting something else and calling it that.

`catalyst env shell` opens this repository's environment on your computer: the image Catalyst's agents work in, the toolchain your `.catalyst/catalyst.toml` declares, and the variables it names, with values taken from your terminal or an `--env-file`. It needs Docker (Docker Desktop, OrbStack or Docker Engine) and no sign-in. The first run downloads the image, about 2.3 GB, with no credential. `catalyst env shell --check` prepares the same environment and reports each toolchain and variable without opening a shell.

## Versions and origins

The package pins the contract range `1.x || 2.x`, recorded in `package.json` under `catalystCloud.tenantContractRange`, and reports it in `--version`, `status` and `login`. An account whose contract version falls outside that range is refused with one line naming both versions; update the bundle. Every skill carries a `vendored-from:` line naming this package as its origin, and that line now also carries the version it was vendored at; all of them are written in this repository for customer accounts.

## What it writes on your machine

- `~/.config/catalyst-cloud/customer.json`, written with mode `0600`, holding your personal key, who you are, and the CLI path.
- `~/.config/catalyst-cloud/contract.json`, your account's cached contract.
- `~/.config/catalyst-cloud/published.json`, the cached answer to "what is the newest release" — no credential in it.
- The Codex launch hook: one marked block in `~/.zshrc` and `~/.bashrc`, and on a Mac `~/Library/LaunchAgents/dev.catalystcloud.codex-attribution.plist` with its log at `~/.config/catalyst-cloud/codex-attribution.log` (see "Codex launches name their coding account").
- After `catalyst update` moves the CLI: `~/.config/catalyst-cloud/cli-runtimes/`, one directory per CLI version it installed and `active.json` naming the one your `catalyst` command runs.
- Only if you start them: `~/.config/catalyst-cloud/replica.db` with its `.pid`, `.writer.lock` and `.writer.state` sidecars, `$XDG_STATE_HOME/catalyst/events/<tenant>/backbone/` (or the home-directory fallback) with bounded daily event segments, and `~/.config/catalyst-cloud/watch-cursor.json`.

The skill files themselves are written by whichever install command you ran, in that tool's own location. Your personal key goes into that one config file and nowhere else.

## Updating

`catalyst update --check` lists each installed component beside the version your workspace approved and changes nothing. For skills packs and the Cloud plugin, the report also compares `installedCommit` with `approvedCommit`. Matching versions alone do not establish that the installed skills match approval. Add `--json` for the machine-readable report, or `--project <absolute path>` to include a project's SDK. A project's files change only when you run `catalyst update sdk --project <path>`, or after you turn its SDK updates on with `catalyst update policy sdk on --project <path>`.

`catalyst update` moves enabled components to the approved release. Owned skills packs move to the exact approved repository commits, including correction of a pack ahead of approval. It verifies existing contents before replacing them, preserves independent skills and local edits, and adds no missing skill names. The Cloud plugin uses the same verified Cloud checkout as a local user-scope marketplace. Run `/reload-plugins` or restart Claude Code after it updates. A missing `claude` executable, unsupported plugin scope or uncertain ownership leaves the plugin in place with a reason. Dev skills move only when the approved release includes a Dev pack; `pack_not_approved` means the installed pack was kept.

The new CLI is installed beside the old one, and your `catalyst` command runs it at the same path. A running local replica restarts on it and keeps its synced data; a stopped one stays stopped. CLI, SDK and image updates keep their existing policy against moving to an older version. Ordinary CLI startup never replaces skills with its bundled copy.

On a machine checking for releases every 15 minutes (`catalyst runner auto-update on`), that check applies the same component policies. Otherwise components move when you run `catalyst update`. That check moves the runner images to a newer release as soon as it finds one, with no set times of day. An update does not stop work that is already running: that work finishes on the image it started with. When work is running and the new release cannot take over from it in place, the check leaves the release waiting. Once a release has waited a day, the next check asks Catalyst to send the machine no new work. It waits for the running work to finish, however long that takes, then moves to the release and takes work again. `catalyst runner update --check` says when a machine is waiting like this, and `catalyst runner auto-update off` ends the wait. If you want updates only at set times, `catalyst update policy windows 06:00,18:00 --time-zone America/Chicago` sets your own times, `catalyst update policy windows default` goes back to none, and `catalyst runner update` or `catalyst update` applies a waiting release at once. Each component is on by default; turn one off with `catalyst update policy <component> off` (for example `cli`), and `catalyst update policy` lists every setting. If you turned the installer's daily update off, the CLI and both skills packs start held, and `catalyst update policy cli on` turns the CLI back on.

The installer's daily job runs the same release check, so it moves the CLI and the Cloud skills only to the approved release and keeps your holds. Until the development skills join the release, it refreshes them from their repository.

A CLI older than `catalyst update` cannot move itself: install it once with `npm install -g @catalyst-cloud/cli@latest && catalyst login`. The re-login rewrites the CLI path the skills spawn, so they stop running the old bundle. To run one command against the latest publish without installing, use `npx -p @catalyst-cloud/cli@latest catalyst login`. The next `catalyst` run prints a one-line notice:

```
[catalyst] updated 0.1.1 → 0.2.0: <that version's CHANGELOG.md summary> · update with: npm install -g @catalyst-cloud/cli@latest && catalyst login
```

A `customer.json` written by an older bundle is still read unchanged; it gains the CLI path and the cached contract the next time you run `catalyst login`.

`catalyst ready` also says when either the installed skills or the CLI is behind, naming both versions and the command for each. It compares them with the approved release this machine last read, and only a machine that has not read one yet compares them with the latest publish. It is a note, never a failure, and `--offline` (or `CATALYST_SKILLS_OFFLINE=1`) skips the lookup.

## Uninstalling

If this machine runs Catalyst's work, run `catalyst runner uninstall` first (see "Stopping or removing this machine's runner").

Remove the skills the way you installed them: `/plugin uninstall catalyst@catalyst-cloud` in Claude Code, or delete the skill directories (`catalyst-github`, `catalyst-linear`, `catalyst-onboard`, `run-this-project`, `unstick`, `what-needs-me`, `what-this-repo-needs`, `whats-happening`) from wherever `npx skills add` wrote them. Skills an earlier release shipped (`catalyst-setup`, `connect-me`, `how-catalyst-works`) go the same way; the CLI removes its own stamped copies of them when it installs or refreshes skills. Then remove what the CLI wrote:

```sh
catalyst replica stop
catalyst setup --remove-codex-attribution
rm -f ~/.config/catalyst-cloud/customer.json ~/.config/catalyst-cloud/contract.json ~/.config/catalyst-cloud/published.json ~/.config/catalyst-cloud/watch-cursor.json
rm -f ~/.config/catalyst-cloud/replica.db ~/.config/catalyst-cloud/replica.db.pid ~/.config/catalyst-cloud/replica.db.writer.lock ~/.config/catalyst-cloud/replica.db.writer.state
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/catalyst/events"
rm -rf ~/.config/catalyst-cloud/cli-runtimes
rm -f ~/.config/catalyst-cloud/codex-accounts.json ~/.config/catalyst-cloud/codex-attribution.log
npm uninstall -g @catalyst-cloud/cli
```

## If login fails

- `catalyst: GET /me failed (401): credential not accepted. Run catalyst login to sign in again; an unattended machine needs a new personal key from Settings → API keys` — the key is stale, mistyped or revoked. Run a keyless `catalyst login`, or on an unattended machine mint a new key, then run `login` again.
- `catalyst: GET /me failed (403): account-not-operational` — your cloud account is suspended. This is a conversation with your account's admin, not a local fix.
- `catalyst: could not reach <url>: <detail>` — the machine cannot reach the cloud. The URL is named in the message; check `CATALYST_CLOUD_BASE_URL` or `--base-url`.
- A line naming two contract versions after `Connected to` — your account serves a contract outside this bundle's `1.x || 2.x` range. The config is written; update the bundle before using the other skills.
- `[catalyst] GET /api/v1/agent/contract refused (403): this cloud is older than the bundle …` on stderr — the cloud has not yet deployed personal-key access to the contract. Update the cloud, or connect with your account key until it has.

## License

MIT — see [LICENSE](LICENSE). How to contribute and how releases happen are described in [CONTRIBUTING.md](CONTRIBUTING.md). The install commands above are one canonical block kept in [`.agents/install-block.md`](.agents/install-block.md); change them there first.

### Unmatched Linear identity

Personal Linear consent normally binds the provider viewer automatically. For an unmatched identity, inspect your choices and explicitly select yourself:

```sh
catalyst identity linear status
catalyst identity linear options --json
catalyst identity linear set <linearUserId>
```

The command uses your personal credential and reads the result back after selection. It cannot change another member, replace an automatic match, or take an already-claimed identity. A missing options field means no choice was offered, which can include a temporarily unreadable roster. This command depends on the pending SDK 0.12.0 release with identity support.
