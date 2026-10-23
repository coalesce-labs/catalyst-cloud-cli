# Catalyst skill sources

The installer at the cloud's `/install.sh` (the app's setup page shows the command) installs both packs from exact commits, stops on any same-named skill it does not recognise, and on a home install schedules a daily refresh. Re-run it to refresh or repair; the table is the by-hand equivalent.

| Pack | Purpose | By hand | Optional Claude Code plugin |
| -- | -- | -- | -- |
| `coalesce-labs/catalyst-cloud-skills` | Cloud account setup and operation | `npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g` | `catalyst@catalyst-cloud` |
| `coalesce-labs/catalyst-dev-skills` | Coding workflows | `npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g` | `catalyst-dev@catalyst-dev-skills` |

Install each pack by one method: `npx skills` or its plugin.

## Where each install lands

Global (`-g`) installs go to `~/.agents/skills/`, linked from `~/.claude/skills/`, with the lock at `$XDG_STATE_HOME/skills/.skill-lock.json` or `~/.agents/.skill-lock.json`. Project installs go to `.agents/skills/` and `.claude/skills/` with `skills-lock.json`. Links are relative; resolve each with `readlink -f` before comparing paths.

`npx skills add --all` replaces same-named directories and links. Before running it on an existing machine, inspect every same-named destination and proceed only when each is absent or a verified, unmodified copy of the intended pack (a lock entry verifies nothing on disk). Resolve any other copy first. Schedule only the installer, never raw add commands.

## Keeping each pack current

Check installed components with `catalyst update --check --json`. Read each component's installed version, approved version, status and reason.
Apply enabled updates with `catalyst update` when the person asks you to update. For a component it does not install itself, it prints the exact command; offer that command the same way.
Keep every saved component hold. Do not turn a hold off without the person's instruction.
For a project's SDK, run `catalyst update --check --project <absolute project path>` and show the command it names. Run that command only when the person asks to update that project.
After a plugin update, start a new agent session to load the installed version.

## Is each pack there

`catalyst ready` checks the Cloud pack only. Look for `catalyst-onboard/SKILL.md` (Cloud) and `research-codebase/SKILL.md` (development) in the intended directory.

## Migrating an existing installation

Inventory source and scope before removing anything:

1. `claude plugin list`: record whether `catalyst-dev@catalyst` is installed, and at which scope.
2. Inspect the home and project skill directories separately, with their locks and provenance markers; a folder name does not prove its source, and `.claude/skills` may link elsewhere.
3. Remove only `catalyst-dev@catalyst`: `claude plugin uninstall catalyst-dev@catalyst --scope user --keep-data --yes`. For a copied skill whose lock source is the deprecated Catalyst runtime repository, `npx skills remove <name> -g -y` (no `-g` for a proven project install), and only when every agent path with that name is that copy or a link to it. Remove by name, never with `--all`.
4. Install the replacement packs in the intended scope with the commands above.
5. Read back the plugin list, each changed lock and the folders, and start a new agent session after a plugin change.

Keep any Catalyst checkout, local project data, and same-named skill of unknown source; if source or scope is ambiguous, stop and report it.
