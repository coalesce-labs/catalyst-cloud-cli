# Changelog

## Unreleased

New: `catalyst mcp status <server>` shows one MCP server's state, how it authenticates, how many of its tools are granted to this machine's login, and how many tools it offers. It then lists the server's last 50 tool calls: when each ran, the ticket and phase it ran for, the tool, how long it took and the outcome. A call that failed names its reason in plain words. The command exits 0 whenever it could read the server, even when some of the calls failed. `--json` prints the server's status and calls exactly as Catalyst Cloud returns them.

## 0.16.23

You can now answer an ask by telling your agent in chat, and have the agent record it for you. `catalyst ask answer <ask> --proxy --quote "<your exact words>" --said-in <session>` records your words on the ask as an answer by proxy, with `--option <letter>` when you picked one. It is kept apart from answers you give on the ask yourself, and the work the ask held moves on. It works only on your own asks, and only after you turn it on with `catalyst ask proxy on` (`catalyst ask proxy` shows whether it is on; `off` turns it off). If an agent recorded something you did not mean, `catalyst ask disown <ask>` takes it back and reopens the ask. Update the Catalyst plugin's skills with the CLI so your agent knows when it may do this.

## 0.16.22

A self-hosted Linux machine set up over SSH now keeps updating after you log out, with no `sudo` step. Setup turns on lingering for your user by itself, and says so along with how to undo it (`loginctl disable-linger $USER`). Only when the machine does not allow that does setup name the one `sudo loginctl enable-linger $USER` command, and it says updates stop at logout until you run it. `catalyst runner auto-update status` now says whether updates keep running after you log out. For a machine you already set up, install this version and run `catalyst runner auto-update on`.

## 0.16.21

`catalyst accounts` now leaves out removed AI accounts: ones an admin revoked, or whose paid access ended. They take no work and take no new credential, so they no longer appear as accounts to repair. The list says how many it left out, and `catalyst accounts --all` shows them, marked "removed — kept for history". Setup now names a revoked account as ended instead of asking you to turn it on. Update the Catalyst plugin's skills along with the CLI: setup's account check uses `--all`, which older CLIs do not know.

## 0.16.20

Setup on Linux now prints every command whole, on its own line, so you can copy it from any terminal width. When this computer still needs the session egress service, setup prints one `sudo` command that checks the installer's fingerprint and installs and starts the service. Run it, then run the same setup command again. When nothing may take work for your workspace yet, setup now names the command that enrolls this computer as a self-hosted machine: `catalyst onboard --runner --team <your team>`.

New: `catalyst env shell` opens your repository's declared environment on your own computer in Docker, with the declared toolchain versions on `PATH`.

## 0.16.19

A self-hosted Mac whose `catalyst` command was installed with Homebrew's Node now keeps its images current and finishes setup's private thoughts storage step. Before, Docker Desktop could not read a file the check needs from the Homebrew folder, so every update and that setup step stopped. Install this version; the next 15-minute check updates the machine.

## 0.16.18

A self-hosted machine now returns to the approved release by itself after setup runs again on it. Before, re-running setup could put older images back while the machine still counted itself current, so it stopped updating. On Linux, the 15-minute update schedule now keeps running after you enable lingering for your user. Install this version, then run `catalyst runner auto-update on` to rewrite the schedule.

## 0.16.17

A self-hosted machine now keeps its own images current. Every 15 minutes it checks for the release Catalyst approved, waits until no work is running on it, switches to the new images, and goes back to the previous ones if the machine is not ready within five minutes. `catalyst runner update --check` shows what would change, and `catalyst runner auto-update status|on|off` controls the schedule. Setup turns it on and now starts new machines on the current approved images. To turn it on for a machine you already set up, run `catalyst runner auto-update on`.

## 0.16.16

Publishing a browser verification recording now saves its proof card with the required attachment details. Update the CLI before using `browser-verify --publish`.

## 0.16.15

Command-line workflows can report stage progress with `catalyst stage start`, `renew`, `done`, and `fail`, and choose an eligible AI account and model for a local session with `catalyst seat checkout`. Retries reuse the same stage attempt. `catalyst write create --label` and `write label --add`/`--remove` now accept a label by name, and a refused write exits non-zero with a JSON error on stdout under `--json`.

## 0.16.14

Setup uses the updated macOS folder checks and verifies the required release image before starting work. Re-run setup to update this computer.

## 0.16.13

Setup on macOS now verifies private file access when Docker changes a folder’s displayed owner in either direction. Signed access verification remains required. Re-run setup to update this computer.

## 0.16.12

Setup on macOS now handles changing folder ownership during the local storage check. Signed file-access verification remains required. Re-run setup to update this computer.

## 0.16.11

Setup on macOS now downloads missing components before checking local storage access. Failed downloads leave setup waiting and preserve the existing enrollment. Re-run setup to update this computer.

## 0.16.10

Setup on macOS now accepts the initial ownership mapping of its private response folder during the local storage check. Signed file-access verification remains required. Re-run setup to update this computer.

## 0.16.9

Setup on macOS now accepts Docker’s initial folder ownership mapping during the local storage check. Updating this computer keeps its verified file-access enrollment and can resume an interrupted update to a newer version.

## 0.16.8

Setup can resume an update stopped by a local storage check. Failed access checks keep the earlier settings and report which check stopped setup.

## 0.16.7

Setup can update an existing installation that still runs its saved, older image version. Headless setup names which key input Catalyst rejected and shows how to try a saved personal login when one is available. Installer checks leave existing skill files in place until the installer updates them.

## 0.16.6

On macOS, setup verifies access to your workspace files before starting work and gives a repair step when that check fails.

## 0.16.4

Setup keeps this computer's saved disk limits when it updates the service that runs your work.

## 0.16.3

Setup checks your local Docker engine's capabilities on macOS and explains mount or network problems.

## 0.16.2

Setup keeps verified earlier Catalyst skill copies and reports where it moved them.

## 0.16.1

Setup lists your existing projects and lets you finish this computer without choosing a team again.

- Keep your saved machine name when setup finds an existing installation, even if its settings file is missing.
- Check readiness across projects that share a Linear team, with a clear next action when a check cannot finish.
- Remove recognized older background jobs automatically. Preserve shared data and explain any cleanup that needs attention.
- Recheck the existing installation before offering a replacement, and distinguish an ended enrollment from one that could not be verified.

## 0.16.0

The CLI, skills and plugin now share the 0.16 release line with the SDK and installer. The CLI installs the matching Node replica module for local cache commands. Update the CLI and update the Catalyst plugin through your agent's plugin manager.

## 0.15.6

Setup checks current readiness and waits up to one minute while Catalyst reads repository settings.

## 0.15.5

Setup explains what running work on this computer means and lists every repository registered to your Linear team.

## 0.15.4

- Setup shows a colour mark and clearer progress, with a plain display when your terminal needs it.
- Setup separates your next steps from tasks waiting on an owner or admin, and reports when it stops waiting for an account connection.
- Setup wraps long text by words and keeps numbered steps in order.

## 0.15.3

- Setup can finish once the steps needed to run work are ready. It lists optional next steps and keeps your first-ticket choice when you resume.
- Setup shows one progress display with numbered steps and the reason a step needs attention.
- When the Connect accounts page is available, setup uses it to finish account connections. Any usable AI account counts without a test request.
- Setup offers API keys by default. Subscription account options appear only when your workspace enables them.

## 0.15.2

- `catalyst setup` is the command to set up Catalyst. It runs the same steps as `catalyst onboard`, which still works.
- When a browser link times out, setup says so and asks whether you are ready to try again. Yes gives a new link; stopping pauses setup without moving on to steps that depend on it.
- The GitHub link opens GitHub's install page directly. An install request already waiting on an organization owner is not requested again, and setup still shows the link to install it yourself.
- Setup asks whether to run work on this machine only after Catalyst is installed on GitHub.
- Sign-in says which Catalyst workspace you joined, without internal account numbers. `catalyst ready` describes each team problem in plain words, with the page to fix it and who can fix it.

## 0.15.1

- Runner setup accepts verified personal team admission before a repository has been mapped to that team. Older cloud servers keep their existing admission check.

## 0.15.0

- Installation and onboarding share a plan and progress display. Browser approvals stay in the same flow, and resumed runs recheck saved choices against current access.
- Linear permission updates open an explicit review page. Opening that page does not change the connection.
- Onboarding can choose an existing Linear team or create one when the connected person has permission. Missing permission names the action needed to continue.
- Onboarding can configure this machine as a Catalyst runner. It checks Docker, image compatibility, enrollment, capacity and team admission, and reports prerequisites that still need attention.
- Headless and JSON runs avoid interactive prompts and report missing inputs. Readiness reports distinguish completed setup from evidence of a first ticket running.
- The CLI uses SDK 0.14.1, which accepts the current cloud contract while refusing unknown write routes.

## 0.14.10

- `catalyst onboard` refreshes its sign-in when it starts and between steps. A run started a while after signing in no longer asks for the browser sign-in again, and a long run of approvals no longer stops with "Renew your login".

## 0.14.9

- Onboarding's workflow step passes on Linear teams that have the built-in Duplicate state. Before, it waited even after the team was adopted.
- While an earlier setup step still waits, for example for a coding account, the readiness step waits too instead of reporting a failure.

## 0.14.8

- Onboarding on a computer with no browser, such as a Docker container, prints the Catalyst page that finishes each Linear and GitHub approval and keeps waiting, instead of stopping.
- Onboarding accepts cloud repository IDs such as `tenant-9:owner__repo`, so registering a project no longer fails on them.
- When the sign-in expires during a provider approval, onboarding stops and says to run `catalyst login`, instead of waiting for the approval to time out.
- Steps that wait name the next action and the page to use, and the end of a run lists what is left.
- `catalyst login` says the browser opened only when it did.
- Onboarding finishes once everything work needs is in place. Repository settings, values and the daily update are listed as next steps instead of blocking.

## 0.14.7

- Setup uses cloud reads by default and offers local sync as an option. Onboarding preserves verified account and repository choices when it resumes.
- Settings drafts stay private for review; keeping a draft does not approve it or import values.

## 0.14.6

- A current Catalyst data folder no longer triggers a legacy-runtime cleanup warning. Legacy checks and removal keep current shared data and report it separately.

## 0.14.5

- Onboarding checks the server's advertised support before provider and repository setup. An unavailable route waits with a public web link instead of reporting declined consent.
- GitHub App installation can open a verified browser handoff and checks every installation with fresh live probes. It remains separate from your personal GitHub connection and repository selection.
- A route removed during browser approval stops with a waiting result. Signed provider approval links remain out of logs and receipts.

## 0.14.4

- Personal Linear and GitHub approval links stay out of logs and receipts. Setup validates the signed browser destination and its expiry before opening it.
- Personal connection checks and browser waits stop on interruption or a deadline. Setup rechecks the current person and workspace, and keeps existing approval when its status is available.

## 0.14.3

- Setup can open the workspace's Linear approval from a personal login and wait for a fresh connection check before continuing. A saved credential alone does not count as connected.
- Workspace approval links stay out of logs and receipts. Interrupted setup resumes with a fresh check, and older clouds keep their supported read-only verification path.

## 0.14.2

Choose an existing Linear team and its accessible repositories in the setup flow. Saved repository choices are checked again against current access and IDs before later setup.

Interactive onboarding uses Clack for the shared plan choice, grouped progress and browser-wait spinners. Local sync is offered within the plan; unattended, JSON and dry-run output keep their plain defaults. Cancelling saves resumable progress and releases only the current setup lock.

`catalyst onboard` runs setup steps with a private saved record and resumes by checking their current state. `--dry-run --json` prints a plan without changing files; `--only` completes a named step without claiming full onboarding. Sign-in validates the live person and workspace, and fake-HOME runs preserve legacy services and data.

`catalyst ready --onboarding` distinguishes failed checks from missing evidence and reports observed work separately. Local sync is optional and can be included with `--local-sync`. Steps whose cloud capabilities are unavailable remain unfinished with a supported resume command. The installer handoff stays gated until its live prerequisites are verified.

## 0.14.1

Legacy cleanup keeps all shared Catalyst config and data folders, including with the historical --data flag. It no longer removes ~/.catalyst/bin wholesale or recursively deletes directories. The onboarding skill keeps data and no longer offers data deletion.

## 0.14.0

The `catalyst onboard` command starts a resumable setup journal, migrates the installer receipt, and safely coordinates with the install script through an owner-token lock. It supports JSON plans, dry runs, step selection and resume validation. The first executable slice checks legacy local runtime files while preserving user data; provider and project steps remain staged for later releases.

## 0.13.1

The Cloud pack now has eight skills. catalyst-onboard includes connection and setup, and whats-happening includes the guide to how Catalyst works. The guides use the catalyst command and call a tenant your cloud account. They explain asks, holds and the 48-hour fallback from the running code. Install and refresh remove retired Cloud-pack skills that carry the pack's provenance.

The CLI adds project wip-limit get and set, repo agents-block and agent-setup, and legacy. These commands inspect or change a project's WIP limit, check or install repository agent guidance, and find old local runtime files. Legacy cleanup requires consent. The CLI now depends on SDK 0.13.1.

## 0.13.0

Catalyst's released pieces now share one version line, 0.13: `@catalyst-cloud/cli` and the deprecated `@catalyst-cloud/catalyst-skills` name, these skills, `@catalyst-cloud/sdk`, the installer, and the schema, replicate and read-model libraries. A CLI on 0.13.x belongs with a cloud whose tenant contract names `releaseLine` 0.13. The CLI moves from 0.9 straight to 0.13 and runs on `@catalyst-cloud/sdk` 0.13. The tenant contract keeps its own version, which tracks the document's shape.

Ask your agent what a setting does and where it is set, and it names the screen, the route and the rule instead of guessing: connecting Linear, installing the GitHub App, registering a repository, the merge policy and its reviewers, secrets versus environment variables, and why routing has no write route yet all have a home in `how-catalyst-works`. `whats-happening` now maps every reason a ticket can be held to a next action and who takes it — the person with their own login, a tenant owner or admin in settings, an operator, or "no one acts" when it is genuinely just waiting — and three reasons that were missing from the stuck-state table (a live container holding a later phase, too many claims in an hour, and a repository at capacity) are documented for the first time. Connecting your own Linear account and being matched as a Linear identity are now explained as two different, sometimes disagreeing, facts, so "I connected Linear, why am I still not getting asks?" has a real answer. And the README says plainly what it still does not know: flow metrics — cycle time, throughput, how long a pull request has been open — are not computed yet, rather than counting something else and calling it that.

## 0.9.5

The CLI calls itself `catalyst` everywhere: usage lines, every verb's `--help`, hints, remedies and errors. `catalyst-skills` still works as a deprecated alias. The npx form is `npx -p @catalyst-cloud/cli catalyst …`, because bare `npx @catalyst-cloud/cli` cannot pick a binary. A replica read on the `node:sqlite` fallback no longer prints a notice every time; `CATALYST_DEBUG=1` still shows it.

`catalyst team` sets up a Linear team as a Catalyst project from the terminal: `list`, `check`, `map`, `adopt`, `migrate` and `checklist`. Writes need a reviewed plan and the cloud's mapping, adoption or migration hash.

`catalyst capabilities` lists what this CLI can do, the role each verb needs (member or admin), and whether this cloud serves the route. It reads only the cached contract, so it never touches the network.

`/catalyst-onboard` runs `team check` and `team map` itself for an admin, where it used to send you to a page. It tells a member which role can run a step. With an older CLI or cloud it keeps the page, as before. A project whose readiness reads blocked is no longer counted as set up: the guide names the blocking checks and who fixes each.

The how-catalyst-works and whats-happening skills explain the WIP limit as the code applies it. The limit is per Catalyst project (the project's setting, else the tenant-wide value, else 12; 0 holds every new start). It holds only new starts, and a ticket already in progress keeps getting phases. `catalyst explain` prints the `wip_limit` reason in words.

## 0.9.4

`/catalyst-onboard` walks a new member through setup one step at a time, in the order a person can act on it: coding account, Linear integration, project, GitHub App and repository, connected accounts, the repository's `.catalyst/catalyst.toml` declaration, then the host, ending with one ticket moving. Each turn asks one question, says why in a line, and checks the result after. A new reference covers choosing a coding account (a Claude setup token, a Codex `auth.json`, or a GLM or Qwen API key), and it says plainly that a plain Anthropic or OpenAI API key cannot be enrolled today. Accounts are named by their label. The skills use the product's own nouns (workspace, project, repository, integration, connected account).

An ended or cancelled coding account is kept for reporting and not used. Onboarding no longer tells you to retire or delete it, and never to put another login's credential on it; reactivate it only if its subscription is live again. `catalyst accounts` marks it "subscription canceled — kept for reporting, not used".

The onboarding step engine never names a next step it cannot back with a check, and it says when a newer CLI is announced but not yet published.

## 0.9.3

A machine the Catalyst installer moved from `@catalyst-cloud/catalyst-skills` to `@catalyst-cloud/cli` works without logging in again. The recorded launcher pointed into the removed package, so `ready` failed its CLI-path check and skill scripts could not start the CLI; any command now repoints it at the launcher that is running. The CLI also leaves the installer's skills alone: it never writes through a symlinked skill folder, and when the installer owns skill placement it does not refresh skills at all. When a refresh does fail, it tells you to re-run the install command.

Onboarding no longer tells you to re-credential an ended or cancelled coding account: it says to retire it on the AI accounts page, and such an account no longer leaves setup unfinished. Before you mint a replacement token, it has you check that your terminal is logged into the account the slot belongs to. `catalyst accounts` names each account by its label, else its email, with the slot id second, adds `displayName` to `--json`, and marks a cancelled subscription "subscription canceled — retire on the AI accounts page".

## 0.9.2

The CLI works against a tenant serving contract 2.x. Catalyst Cloud's tenant contract moved to 2.0.0 when it removed `merge.cloudRemediateRequiredChecks`, and every earlier bundle accepted only 1.x, so `ready`, onboarding and most commands stopped with "the tenant serves contract version 2.2.0 but this bundle accepts 1.x". This bundle accepts `1.x || 2.x`. The one place that read the removed field already treated it as absent.

## 0.9.1

Onboarding now teaches `.catalyst/catalyst.toml`, the only file the cloud reads a repository's settings from. The skills still described `catalyst.env.json`, which the cloud has ignored since 2026-09-27, so a declaration written from them was silently dropped. The repository reference shows the file's shape (`[project]` with `linear_team`, then `[[environment.variables]]` and `[[environment.setup]]`) and the approval step: an owner or admin opens the repository's Environment page, goes to the Setup declaration tab, and clicks Approve this revision.

A ticket filed through the catalyst-linear skill now carries a description: `catalyst write create` takes `--description <text>` or `--stdin`, where before it could file only a title. The skill content never asks for a personal Linear token or a direct Linear API call.

## 0.9.0

Onboarding now guides your own Linear and GitHub consent. `catalyst connections personal <linear|github> start` opens the provider's consent page in your browser and `status` confirms the grant landed; the tenant's own Linear connection and GitHub App install stay separate, and personal GitHub waits until the App is installed and a repository is registered.

An unmatched Linear identity can be fixed from the terminal: `catalyst identity linear status`, `options` and `set <linearUserId>` choose your Linear user from the roster and read the choice back. An existing match is never replaced.

The local replica and event cache report whether they are current. `catalyst replica status --probe` and `catalyst events status --probe` compare each local feed with its cloud head and require a live writer; onboarding starts the writer only when you opt in, and a missing local cache never blocks setup.

Register, list and remove MCP servers with `catalyst mcp`, using vault-secret names for authentication. Custom HTTPS servers wait for account-admin approval; query strings, userinfo and fragments are refused. The cloud side shipped on 2026-09-28; registration does not yet make a server callable through the portal.

This release needs `@catalyst-cloud/sdk` 0.12. `@catalyst-cloud/catalyst-skills` is deprecated in favour of `@catalyst-cloud/cli`; it still installs and forwards to this version.

## 0.8.0

`catalyst-skills ready` loads the SDK on Node 26, the current Homebrew default, and has since 0.7.0: the type-stripping loader tries Node's `strip` mode before `transform`, because Node 26 accepts only `strip`. The 0.7.0 entry did not say so. If you saw `sdk: could not load` on Node 26 on 0.5.0 or earlier, updating is the fix.

The supported runtime range is now declared in one place and every message names it accurately: Node 22.15 or newer (22.15 is where `node:module.registerHooks` arrives, which the SDK's TypeScript dependencies need), or bun 1.4 or newer (1.4 is where `node:sqlite` arrives, which the replica needs). The old advice to "run under Node 22.15 or newer, or under bun" was wrong for any bun older than 1.4: that bun has no `node:sqlite` at all and could not run this CLI, so the suggestion sent you to a runtime that could not even start. No message in this package recommends bun any more without saying which version.

The CLI itself no longer dies part-way through loading on a runtime it does not support. `node:sqlite` used to be imported at the top of a module every verb loads, so a bun without it aborted the whole process before `ready` ever got a chance to explain why — you saw a raw `ResolveMessage`, not a fix. The engine now loads on first use, and its absence becomes a named `runtime` check with the one command that fixes it, on every runtime, every time.

That one command is `catalyst-skills runtime install`. It downloads a pinned Node release into this CLI's own cache, verifies it against that release's published checksum before unpacking anything, and uses it from then on — without touching your machine's default Node and without admin rights. Run it any time `ready` reports the runtime as unsupported, or ahead of time if you would rather not manage your system Node at all.

## 0.7.0

`catalyst-skills env inventory [path]` scans a repository offline — no login, no network — and lists
the environment variable NAMES it needs, never a value. Names are grouped build/test (needed to
install, build and run the tests), deploy-only (a CI secret only a deploy job uses) and bindings (a
Cloudflare or other platform binding, which is not an environment value). Each name shows where it
was found (file:line), what uses it, and where a local value would come from — a `.env` file, your
shell, a CI secret, or a Cloudflare binding. `--json` gives the same data in machine form. `env check
<file>` validates a `catalyst.env.json` offline, against this bundle's own dated, cited copy of the
cloud's validation rules (it does not compute the cloud's canonical hash — only a `valid` / `invalid`
verdict and the refusal reasons). The new `what-this-repo-needs` skill explains why a cloud container
needs these names before it scans, then asks you to review the list: keep, drop or move each one.

Reading a GitHub Actions workflow now goes through a real YAML parser (`yaml`, now a runtime
dependency of this package — it carries no transitive dependencies of its own) rather than a
hand-written line scanner, so a workflow that declares its `env:` in flow style (`{ A: 1, B: 2 }`) is
read correctly instead of silently missed.

`explain` and `ready` now name a team that cannot start work even when the live read is not available. Your tenant's contract carries each team's dispatch gate, and this machine already keeps a copy of that contract on disk; until now only the live eligibility read could name the gate, so a network hiccup, or a cloud older than that read, left `explain` printing nothing at all. `explain` now leads with the gate and the fix from the cached contract when the live read is unavailable or sends no gate, and says which of the two it read; when both answer and disagree, the live read wins and the paragraph says the cached one disagreed. A refusal from the cloud — a credential that is not accepted, for instance — is still a refusal, never quietly replaced by a cached answer. `ready` now prints one dispatch-gate line per team: open teams read `ok`, and a team whose stages are not saved reads `FAIL` with the remedy your tenant sent and turns the verdict to NOT READY, because nothing in that team can start. A cloud that does not send the gate changes nothing.

`catalyst-skills ready` now tells you when the skills on this machine, or the CLI itself, are behind the newest published release — it names the version you have, the version that is out, and the one command that updates each, as a note that never changes the verdict. Every skill file now records the bundle version it was vendored at, so a copy installed months ago is visible as such instead of only by diffing files. The check reads the npm registry's `dist-tags.latest`, capped at 1500ms and cached for six hours, and never blocks: an unreachable registry is one note that says so, and `--offline` (or `CATALYST_SKILLS_OFFLINE=1`) skips the lookup entirely.

A list read now returns the whole scope or says plainly that it did not. `catalyst-skills query issues --all` and `query pulls --all` follow the cloud's page cursor to the end of the scope instead of stopping at the first page, and a read without `--all` that was cut short now prints `truncated at N of M` on stderr, where M is the full count the cloud reports for the same scope. `catalyst-skills ask list` — and the what-needs-me skill that wraps it — reads every page, so a workspace with more than a few hundred tickets no longer gets an inbox that quietly omits the asks past the first page, or scores the ones it does show against a partial view of what they hold.

Every skill this bundle ships now carries a routing case proving it still fires on a sentence its own description promises, and a deterministic check that fails by name the moment a description drops a phrase a case relies on — this repository's own test suite now catches a broken trigger before it ever reaches an install. A publish also runs a security scanner over every skill's scripts first, so a script that reads a sensitive directory or embeds an instruction override blocks the release unless someone has written down why it does not.

## 0.6.1

The local replica writer no longer retries a failing snapshot pull forever. After a failed or incomplete pull it backs off with jitter (30s doubling to a 15-minute cap) and gives up after five consecutive failures, recording why; a pull that completes resets the count. `catalyst-skills replica status` and `catalyst-skills ready` both name the stopped state, the count, the last error, and the command that restarts it. Until the read side of a large snapshot is safe, `ready` no longer suggests starting the replica at all — it says plainly that the replica is optional and off by default for large tenants, and every read still works through the API either way.

## 0.6.0

A new `catalyst-onboard` skill walks you from nothing to your first ticket running, one step at a time. You install the bundle yourself and type `/catalyst-onboard`; from there your agent does each step, shows you what actually came back, and stops — no page is fetched and no instruction arrives from anywhere but the skill you installed. It reads setup as five separate parts, each with the instrument that owns it: this machine (`status` and the machine half of `ready`), you (`me`), your account's Linear workspace, the projects that have been mapped, and the repositories that have been registered. Nothing answers for a part it does not own, so a project that is not ready is reported as a project finding with the tenant owner who can fix it and the page it is on — never as something to retry here. `node scripts/where-am-i.mjs` prints the whole reading, `--next` reduces it to the one next step, and every page link it prints is built from the cloud this machine is connected to rather than typed from memory.

It also says plainly what it cannot do. Approving the login, connecting Linear and installing the GitHub App are browser steps by construction and always will be. Seeing every project you could set up, mapping stages, adopting the workflow, registering a repository and declaring an environment are settings-page steps today because the routes behind them take a browser session rather than a key; the skill hands you the page for each, says it is a gap rather than the design, and never guesses at a route. Two silences are called out because both read as absence and are not: an empty project list means nothing is mapped yet, not that you have no projects, and a registered repository is registered and nothing more — that list carries no status and no project attachment, so it never proves work can be dispatched into it.

`catalyst-skills environment` is new, and it is the first setup action an agent can perform end to end. The tenant-wide environment declaration — the names your builds need — has been callable with your own login since the routes shipped, and nothing could call it, so every part of setting a tenant up was a page in the app. `environment` reads the current revision, whether it is approved, and which revision a phase's checkout actually carries (a proposal nobody approved changes nothing, and the verb says so); `environment propose --file <path>` proposes one from a JSON file or stdin, `--expect-revision` refuses if someone moved it since you read it, and `--approve` approves exactly the revision the propose returned. `environment approve` on its own reads the current revision and approves that, so the compare-and-set the cloud requires never depends on a hash copied between two commands. Reading needs any active seat; proposing and approving need an admin or owner one, and the cloud's refusal says which. The route paths come from your tenant's own contract and the derived ones are checked against it, so a cloud that does not serve them yet is named as older instead of answering 404. Repository-scope declarations are still a page. `catalyst-onboard`'s step for declaring what the containers need is now a command rather than a handover, and its report reads the declaration back.

The package description and the README no longer count the skills or list them in prose. A count written in a sentence cannot be kept true by anything, and the last one was wrong in the direction that made a correct install report itself as failed.

## 0.5.0

The local replica can now keep the durable tenant event backbone beside its entity database. `catalyst-skills replica start` owns both synchronizers in one process, while `catalyst-skills events tail`, `events wait-for`, and `events query` read the bounded local cache with exact event-type and ticket filters. A failed event synchronizer is reported without stopping a healthy entity replica. This requires `@catalyst-cloud/sdk` 0.10.0 or newer.

You can release a stuck ticket yourself now. `catalyst-skills release <ticket> --because "<what changed>"` asks your tenant to release every park or hold on the ticket the right way for each one — after repeated failures, a spent repair-round cap, a repair that changed nothing, a validate failure that recurred — or to release nothing and name, for each thing it will not release, what a person has to do instead (close their own pull request, read a review that will not converge, answer the ask for a spent repair budget). `--dry-run` previews it and changes nothing; `--retry-unchanged` says something changed that the cloud cannot see, such as an outage that ended; `release --class <failure-class> --team <key>` does the same for every ticket on one team parked for the same reason. A refusal exits 1. Every release is recorded against your login, and `explain --history` now prints what holds the ticket and the ticket's past releases. The new `unstick` skill runs the whole loop — read why nothing runs, read the history, judge whether the cause is fixed, preview, release — and raises an ask only for what needs a person; the desk, the project owner and the failure references no longer say a park needs an operator. The eligibility explanation knows seven more reasons, including a parked phase and a person's own pull request. Needs a cloud that serves the release route (tenant contract 1.6.0); an older cloud says so.

Every skill's scripts now work for a machine connected with the keyless login. Since 0.4.0 a keyless `login` stores a login session and no key, and every skill script except the new `unstick` one read that as "not connected" and stopped before doing anything; only a personal key worked. The scripts now accept either, spawn the CLI, and let it authenticate and refresh the session as it always has. The check lives in one file vendored into every skill, so the next kind of credential lands once, and the not-connected line now names the keyless login first.

## 0.4.1

`explain` now tells you when a whole team cannot start work. A team whose stages are not saved (no stage chosen for dispatch, PR, done and canceled, or a chosen stage since deleted in Linear) gets no dispatch queue at all, and `explain` used to answer a ticket in that team's Todo with "state Todo is not a dispatch state" — which sent people looking at the wrong setting. It now says the ticket cannot start because the team has no saved stage mapping, names the missing stages, and names the fix: a tenant owner or admin opens Settings → Linear teams, picks the team and presses Map my stages (or Adopt the Catalyst workflow). Needs a cloud that sends the team's dispatch gate; an older cloud prints what it did before. The reason table's wording for `workflow_mapping_unknown` and `ordering_never_published` no longer reads as a passing hiccup, since neither clears on its own for an unmapped team. The references now say plainly that `teams[].gitAutomation` in the contract is a stored consent for a feature that is not built — nothing reads it, so it never starts or stops work — where they used to say enabling it could delete a team's review automation. The catalyst-setup reference gains a section on setting up one team at a time as a pilot: what starts, what stays where it is, and that no other team's stages or tickets change.

## 0.4.0

You can connect keyless now: run `catalyst-skills login` with no key and it opens a browser device-code login — it prints a short code and a URL, you approve in your browser (or from your phone on a machine with no browser), and this machine is connected as you, with nothing to mint or paste. The short-lived session token refreshes silently on every request and the config is rewritten atomically each time, so you stay connected for months and log in again only if the session is revoked or you have been away long enough to lapse — then one clear line tells you to run `login`. `customer.json` now holds exactly one of a login session (`auth`) or a personal key; `status` names which ("Credential: your login (expires …)" vs "Credential: personal key"). The personal key rail is unchanged and remains the fallback for scripts and unattended shells — `--key` or `CATALYST_CLOUD_TOKEN` — and keyless is the preferred rail everywhere the docs and the connect-me skill lead with it. Under the hood the auth layer is reworked around one credential provider (SDK 0.9): the replica and the live watch use the SDK's bearer auth strategy and resolve a fresh token per connect, so an OAuth session rotates underneath a long-running watch without a reconnect, and every HTTP read and write refreshes on the same path.

## 0.3.1

`ready` now names the person you connected as: when your key is a personal key, the config line reads "joined <tenant> as <you> (<role>)" instead of the generic "as service" that every api key showed, and an account (host) key still names the tenant with no person. `ready` also learns the bundle version your tenant expects, when the cloud publishes one: if this installed bundle is older than that minimum you get a one-line warning that names both versions and the upgrade command, but it stays a note — `ready` never refuses over a stale bundle, and a cloud that does not publish a minimum changes nothing. `explain` no longer calls every ticket with no dispatch row "unknown": a ticket that merely sits in Backlog (or any non-dispatch state) is now named as known to the mirror with the state it is in, and only a ticket the mirror has never seen keeps the unknown wording.

## 0.3.0

You connect with your own personal key now, not the tenant's shared account key: mint it yourself at Settings → API keys in the Catalyst Cloud app (every member can; no admin needed), and `login` prints who you connected as beside which tenant. Your agent acts as you — an ask it raises names you, and "what needs me" means you: `ask list` (and the what-needs-me skill) keeps only the asks assigned to your Linear user by default, `--anyone` lists the whole tenant, and when your Linear identity is not matched yet it says so and shows everything rather than an empty list. `customer.json` gains a `user` block (id, label, role, your Linear user id); an older config is still read unchanged. Connecting with the account key still works — it is the right credential for a host or daemon — but `login` tells you it names no person. Every skill, reference and help line that said "account key", or said execution history and coding-account status were not readable, has been rewritten: `explain --history` and `accounts` read them, and the two things your key genuinely cannot do (release a park, read PR labels or reactions) are named instead. The catalyst-setup reference now lists all eleven team checks, including `environment_declared`. Needs a cloud that admits personal keys on the agent routes; on an older cloud the contract read says so by name, and the account key still works until it is updated.

## 0.2.1

Fixes five defects found by running 0.2.0's verbs against a live tenant. Three skills (catalyst-github, catalyst-setup, how-catalyst-works) carried a colon-and-space inside an unquoted description, which YAML reads as a nested map rather than text, so `npx skills add` skipped them and still reported success — every Codex, Cursor and OpenCode install of 0.2.0 quietly got five of the eight skills, and reinstalling with this version gives you all eight. `running` no longer asks for lease attributions it has no coordinates for, so the headline "what's happening?" verb works instead of failing for every tenant; the lease read is still available as `running --ticket T --phase P`. The CLI no longer truncates its own output at 64KB when a skill reads it through a pipe, which made `query issues --json` on a tenant past roughly eighty tickets return invalid JSON with a success code. `accounts` now actually reads your coding-account slots and renders them, `history <ticket>` (also `explain --history`) shows a ticket's execution history, and both say plainly when your cloud is older than this bundle rather than printing an empty success. `queue` with no `--team` reads every team on your tenant instead of being refused, as its help always promised. `query changes` works at all now: it reads the feed's NDJSON, where before it called any successful response a non-JSON body — nothing noticed because the documented `--since 0` is refused on any tenant whose feed has rotated, so a success was never reached. That refusal now names a cursor you can actually use, and `--since head` starts from now.

## 0.2.0

Eight skills named from the executive's seat (whats-happening, what-needs-me, run-this-project, catalyst-setup, catalyst-linear, catalyst-github, how-catalyst-works, connect-me) replace the six; reads and the live event stream go through the Catalyst Cloud SDK and writes through the tenant's agent proxy, all behind catalyst-skills verbs (me, contract, query, replica, explain, running, queue, watch, write, ask, ready, accounts), with every stage id, label id, threshold and route read from the tenant contract; Node 22 is now required; installing the skills has moved to your agent's own command (the Claude Code plugin marketplace in this repository, or npx skills add for Codex, Cursor, OpenCode and the rest) and the CLI no longer copies them, leaving install only as a repair path; catalyst-skills login replaces join, which stays as a deprecated alias for one minor version, and login now prompts for the key without echoing it when no CATALYST_CLOUD_TOKEN is set; every SKILL.md declares allowed-tools scoped to this package's binary, so no skill needs a blanket shell grant; your existing customer.json is still read unchanged and gains the CLI path the next time you run catalyst-skills login, which also caches the tenant contract; run catalyst-skills ready to confirm.

## 0.1.1

The bundle now lives and publishes from its own public repository, coalesce-labs/catalyst-cloud-skills, so every skill can be read before it is installed; the README leads with the CATALYST_CLOUD_TOKEN form of join, and join's output no longer names an internal ticket.

## 0.1.0

First published customer skill bundle: vendored customer editions of concierge, steward, ask and linearis plus the new join and setup skills, one-command tenant discovery via GET /api/v1/me, config written to ~/.config/catalyst-cloud/customer.json, and a placeholder 0.x tenant contract range (CTC-1924 in flight).
