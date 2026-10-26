---
name: catalyst-onboard
description: >-
  Set up Catalyst Cloud and say whether setup is working. Walks a person from nothing to their first ticket running, one step at a time: the coding account, the project, the integrations and connected accounts, each repository's settings file, then one real ticket moving. Also logs this machine in, reads the readiness verdict with who can fix each failure, and checks the optional local replica. Use when someone says "set me up", "onboard me", "I just signed up", "get me started", "what do I do first", "log me in", "which account is this machine on", "am I set up", "what is missing", "why does nothing happen" or "is the replica running", when a login expired, or when a skill script exits 2 saying this machine is not connected. Does every step a key can do through the catalyst CLI, hands over the exact page for the steps only a browser can do, and never claims a step it did not watch succeed.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.40 — written in this repository for customer accounts -->

# Onboard me

Guide setup through the same `catalyst onboard` flow that the installer runs. The command owns its plan, questions, browser handoffs and saved progress. Read back what it observed, and help with the next unfinished check.

## Use the onboarding command

1. Accept the workspace invitation first. Catalyst has no self-serve sign-up: a person joins by accepting the invitation email their workspace admin sent. Until it is accepted, sign-in is refused with "This sign-in has no Catalyst workspace yet"; if no invitation ever arrived, asking that admin is the next step, and nothing below runs before it lands.
2. Run `catalyst capabilities --json`. If its `onboard` entry is available and advertises `bootstrapHandoff: true`, use this path. If absent, use the older step-by-step references below and name the CLI update needed for the continuous flow.
3. For a requested setup, run `catalyst onboard`. To inspect first, run `catalyst onboard --dry-run --json`. Resume with `catalyst onboard`; the command rechecks saved results. Do not ask the person to confirm completed browser steps or add a separate approval before the command's plan question.
4. In a terminal, the command shows the verified person, workspace and plan before approval. Without terminal input, or with `--json`, use `--yes` only when the person has accepted the displayed defaults; otherwise setup waits with exit 11 and keeps the saved connection and receipt. JSON keeps progress, identity and the plan on stderr and returns one result on stdout. A supplied key needs `catalyst login` before onboarding; browser sign-in does not replace it.
5. For the current onboarding checks, run `catalyst ready --onboarding --json`. A failed check needs attention. An unknown check needs evidence. Report observed project work separately from incomplete setup; an unknown setup check does not prove work stopped.
6. Exit 0 completes the requested scope. For a full run, exit 0 means work can start. If the receipt's `complete` is false, a repository value or the first ticket is still open, and the command lists it under "Next, when you want". The daily update never keeps `complete` false, and neither do repository settings this computer cannot review (no checkout here, or not yet approved); a settings review that timed out or could not keep its draft does. Only a person at a terminal picks the first ticket; `--yes`, `--json` and headless runs leave it waiting with an action. Exit 10 means a failed step, 11 means waiting, and 12 means a guard refused the action. A successful `--only` step does not mean onboarding is complete. Keep the command's safe fix and supported resume command in your reply.

Use cloud reads for ordinary workstation setup checks. Offer local sync for local SQL or sustained local reads inside the plan review. Local sync does not promise offline browsing. It is optional; do not make an absent replica a setup failure. Browser approval belongs to the person. Missing bearer capabilities stay unfinished; never call a session-only route from the CLI or invent a command.

Choose an existing Linear team explicitly in the command's team picker or with `catalyst onboard --team <team ID or unique key>`. Unattended setup does not pick the first team, even when only one is visible. Resume rechecks the saved selection; final readiness reads only that team. A team used to verify the workspace grant is not a project selection. Setup creates a Linear team only when the cloud advertises it, which is off until approved. The picker then ends with "Create a new Linear team…", which asks for a name and an editable key, creates the team as the person (owner or admin only) and sets up Catalyst's workflow on it. A definite taken key is asked again before a new team is created. An unconfirmed result keeps its key for recovery and asks you to check Linear before another creation. If Linear refuses the person, setup says why and returns to the picker. If the workflow step fails, setup names the created team and the `catalyst team adopt <KEY>` retry. For an owner or admin selecting an existing team, the workflow step shows that team's adopt plan (the stages and labels it creates or keeps) and asks before applying it. `--yes` applies that previewed plan without asking, so use it only when the person has accepted the plan. Native sign-in waits for up to ten minutes across all device-code rounds; a timeout saves progress for the next run.

Default invited-member setup handles personal accounts and leaves workspace administration to an owner or admin. It does not ask the team or repository questions. A member can explicitly request an existing-team selection with `--team` or `--only linear.team`; that request only reads and verifies the selection.

**Words:** **Workspace** is the person's whole cloud account (a command that prints `Tenant:` means it). **Project** is one Linear team plus its registered repositories. **Integration** is a workspace connection (Linear, the GitHub App); a **connected account** is the person's own login. **Coding account** is the AI provider login the work runs on.

## Which branch you are on

- **"Am I set up?", "what is missing?", "why does nothing happen?"** Run `node scripts/check.mjs`, read it with `references/reading-ready.md`, and end with the verdict and the who-can-click-what list.
- **Not connected, a login expired, "which account is this?"** `references/connecting-this-machine.md`.
- **"Is the replica running?", or local SQL.** `node scripts/local-sync.mjs`, then `references/local-sync.md`.

## Older CLI: step-by-step setup

1. Run `node scripts/where-am-i.mjs --next` and read its one line; trust it over your memory of the last turn. A `note:` after it is worth one clause.
2. Say what the step is for.
3. Ask one question or do one thing. Offer to run every step a command can do, run it on a yes and show its output; hand over a browser step only as `references/what-the-browser-owns.md` says.
4. Wait for the answer. Two or three short sentences a turn; the full report is for you, not to paste.
5. Re-run the script and read back the part that should have changed. Still unchanged after one `catalyst contract --refresh`: report both what the page said and what the instrument says.

## Run first

Scripts are run, never read; each prints `--help`.
- `node scripts/where-am-i.mjs [--next] [--json] [--repo <path>]`: every part of setup with its instrument, verdict, and who can fix what is unfinished; works before the machine is connected. A `note:` names a cancelled coding account, old-runtime leftovers (`catalyst legacy`), or a named checkout's agent-setup offers.
- `node scripts/check.mjs [--json]`: the `catalyst ready` verdict, with fix and owner under each failure. Exit 0 READY, 1 NOT READY, 2 not connected.
- `node scripts/local-sync.mjs [--start]`: the optional local replica and event cache; `--start` only once chosen.

## Load on demand

| when | read |
| -- | -- |
| walking the path, step by step | `references/the-one-path.md` |
| logging in, a refused or expired login, which account this is, the Linear identity | `references/connecting-this-machine.md` |
| anything reports not ready, a check id, or who fixes something | `references/reading-ready.md` |
| the coding account or the `host` part, or before saying work can run | `references/what-a-phase-needs.md`; a credential to replace, `references/replacing-a-credential.md` |
| preserving an existing paused Darwin runner during owner-managed replacement | `references/preserving-runner-replacement.md` |
| which steps a command does and which need a browser, or confirming a page that said it worked | `references/what-the-browser-owns.md` |
| the repository's `.catalyst/catalyst.toml` and its approval; its AGENTS.md block and agent layout | `references/declaring-a-repository.md`; `references/repository-agent-setup.md` |
| the replica or event cache | `references/local-sync.md` |
| local SQL, only when `catalyst replica status --json` reports `configured: true` | `references/local-replica.md` |
| installing, updating, or migrating Catalyst skills | `references/skill-sources.md` |
| what Catalyst is, or why the first ticket did not start | the `whats-happening` skill, then `unstick` if something holds it |

## Rules

- **The command owns the continuous flow.** For an older CLI, open with the current step and ask one question at a time. One question has one answer: a yes-or-no, or one fact. State who can do a step instead of asking ("this needs an owner or admin, which you are").
- **Report what you observed.** Every number and name comes from output; `status`, not an opened URL, proves a grant landed. Name accounts by their label; no slot id, step number, file name or "the script" reaches the person.
- **Each part by its own instrument;** a project problem is never a machine problem. Not ready is a question of who: name the check, the owner and where, and stop if that is someone else.
- **Previews before project writes.** `team map`, `team adopt` and `team migrate` preview; pass `--yes --plan-hash` only after the person approves that exact plan.
- **The plan explains changes before they happen.** The onboarding command owns that review. In the older manual path, say what you will write and where before asking for its approval.
- **Local sync is opt-in.** Every skill works through the API without it; a started process is not proof of freshness.
- **Running work on this machine is opt-in.** In a terminal the command asks once, default no. Unattended, pass `--runner` only when the person asked for this machine to run Catalyst's work, and `--no-runner` to skip without asking. It needs Docker and an owner or admin. Its waits name who acts: an organization key file from an owner or admin (`CATALYST_RUNNER_ORG_KEY_FILE`), or images and team admission from Catalyst support. Relay that ask; never sign in to a registry or edit the runner's files yourself.
- **Stop at a wall.** A suspended workspace, an inactive seat, an owner or admin needed where the person is neither, a blocked command: say what you found and who can act, then stop. An older cloud is not a broken command. A person with no account joins one by invitation from its admin.
- **Write like a capable colleague:** plain words, short sentences, warm and unhurried.
