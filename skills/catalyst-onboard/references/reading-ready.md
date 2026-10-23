# Reading `catalyst ready`: what each check proves and who fixes it

Read this before telling a person something is not ready or what to do about it. `catalyst ready` prints one verdict over the machine and every project; `node scripts/check.mjs` adds each failure's fix and owner and a "who can click what" list.

## The parts, and the instrument that owns each

| part | instrument | a pass does not prove |
| -- | -- | -- |
| **machine** | `catalyst status`, and the machine checks of `ready` | anything about the cloud account |
| **person** | `catalyst me`, `catalyst connections personal <linear|github> status` | an active seat (an owner or admin fixes it in Settings → Members; no command does this yet, so raise one ask to them) |
| **account** | `catalyst contract --path account` (a resolved Linear workspace) | that the GitHub App is installed |
| **project** | `catalyst team list`, then `team check <KEY>` and the `team:` checks of `ready` | that an unchecked team is ready |
| **repository** | `catalyst contract --path merge.repositories` | that it is active, attached to a project, or declared |
| **repository declarations** | `environment_declared` in `catalyst contract --path teams` | that the values behind the names exist |
| **coding accounts**, **host** | `references/what-a-phase-needs.md` | that a phase has headroom |

⛔ **An empty contract project list means nothing is mapped yet**; pick one from `catalyst team list`. `team check --all` checks every team and may file an ask for each. ⛔ **A registered repository is not a dispatchable one**; if a card does not start, `catalyst explain <ticket>` names the reason.

## Triaging NOT READY

Split the verdict first. In `catalyst ready --json`, an id that begins with `team:` is a **project** finding; the rest are **machine** findings. Report the two groups separately, machine first, each with its owner, its `pass`, `fail` and `unknown` counts, and when each team verdict was computed (`teams[].readiness.checkedAt`, null before any pass).

- **A machine check failed:** the person's, here, now. Do its `fix` line.
- **A project check failed:** name the check, the project and the `who`. Offer to run the repair: `catalyst team check`, `team map` or `team adopt` for a mapping, and `catalyst onboard` to start a Linear reconnection, whose consent link the owner or admin approves. Only Linear's own team access is a page in Linear. Re-running `ready` fixes nothing.
- **A note** never moves the verdict; waiting is not failing, and unknown is not a pass.

End every readiness answer with the verdict and the who-can-click-what list, in that order. Run each check once; waiting for one to clear is the project owner's watch (`run-this-project`).

## The checks

The contract's `readinessChecks[]` is the list of record, with each check's severity; `teams[].readiness` holds each team's states. A check listed there and not here is newer than this page: `node scripts/check.mjs` still prints its line, fix and owner, so read that and say you did.

A team is `ready`, `degraded`, `blocked` or `unchecked` (no pass yet, a note). Severity decides whether a failing check blocks, degrades or only informs; an unknown (the engine could not look) degrades regardless. Readiness is stamped with the mapping revision it read, so a stale verdict shows as stale.

| check id | proves | when it fails | who clicks |
| -- | -- | -- | -- |
| `oauth_scope` | the Linear connection has the permissions it needs | re-authorise it: `catalyst onboard` starts it and prints the consent link | owner or admin, in their browser |
| `token_live` | the Linear connection is accepted now | reconnect with `catalyst onboard` if expired, revoked or never connected; `catalyst team check <KEY>` if Linear was unreachable | owner or admin |
| `team_visible` | Catalyst can see the team | usually it went private: grant access in Linear, then `catalyst team check <KEY>` | owner or admin, in Linear |
| `mapped_states_exist` | every mapped stage still exists | `catalyst team map <KEY>`; `stages_pending_write` means a mapping was just saved, so wait | owner or admin |
| `mapping_total` | every stage Catalyst moves tickets into is mapped | map them ("absent": never mapped) | owner or admin |
| `types_compatible` | each load-bearing stage is the right kind (dispatch and intake unstarted or backlog, PR started, done completed, canceled canceled) | map a stage of the right kind | owner or admin |
| `labels_present` | Catalyst's labels exist | none: they are created on first use | nobody |
| `writes_land` | Catalyst has written to the team | `no_write_observed` clears on the first move; a refused write: check the connection and permissions | owner or admin when refused; otherwise nobody |
| `webhook_covers_team` | the team's events arrive | `no_delivery_observed` clears once a registered repository's events flow | owner or admin, by registering the repository: `catalyst onboard --team <KEY> --repo <owner/name>` |
| `hosts_current` | no connected host runs an older mapping | `references/what-a-phase-needs.md`; `no_host_connected` is waiting | whoever runs that host |
| `environment_declared` | the default repository's `.catalyst/catalyst.toml` is ingested, valid and approved | the reason names the step: register a default repository, commit or fix the file through a reviewed pull request, or approve a revision that merged without one (`references/declaring-a-repository.md`) | owner or admin, except committing the file, which is whoever can push |
| `tools_resolvable` | every MCP server and CLI the declaration names resolves | `tool_reference_unresolved`: set the secret with `catalyst secret set NAME --repo <owner/name>`, or fix `.catalyst/catalyst.toml` in a pull request; `toolchain_cli_missing` is not self-service | owner or admin |
| `reviewer_required` | the repository can merge under its policy | a strict policy with no reviewer: relax the policy with `catalyst var set CATALYST_MERGE_EVIDENCE_POLICY --repo <owner/name>` (a policy declared in `.catalyst/catalyst.toml` wins over the variable, so change it there in a pull request), or configure a reviewer at Settings → Your projects → the project → Repositories → the repository → Code reviews (no command for that yet); only the merge waits | owner or admin |
| `reviewer_configured` | a code reviewer is configured at all | configure one there; a fail never blocks or degrades | owner or admin; nobody is required when it fails |

## The machine checks the CLI adds

Each failing line prints its own fix.

| id | proves |
| -- | -- |
| `runtime` | this runtime can run the CLI: Node 22.15+ or bun 1.4+. The fix, `npx -y -p @catalyst-cloud/cli catalyst runtime install`, puts a pinned Node in the CLI's cache and leaves the default Node alone |
| `config` | `customer.json` exists and loads (`references/connecting-this-machine.md`) |
| `contract` | the contract is cached and its major version is in this bundle's range |
| `bundle` | the CLI meets the account's minimum version; a note |
| `cliPath` | the CLI path recorded at login still exists |
| `skills` | the Cloud pack's copied skills are all present; a pack installed another way reads as a note (`references/skill-sources.md`) |
| `cliRelease` | the CLI is not behind the newest release; a note |
| `skillsRelease` | the skill files are not behind the newest bundle; "could not run" means the registry was unreachable |
| `sdk` | the SDK loads, so the replica and the watch are available; reads work through the API meanwhile |
| `replica` | the optional replica is fresh; a note (`references/local-sync.md`) |

## Setting up one team at a time

A team receives work once its stages are saved. Saving one team changes no other team's stages or tickets; only the labels Adopt creates are shared. Once saved, tickets in its dispatch stage start, so pilot on a low-stakes team and first move anything there that should wait back to Backlog. Nothing reads `gitAutomation` in the contract.

Each action is a command; offer to run it for an owner or admin:

- **Check** (`catalyst team check <KEY>`) saves the team's verdict, changing no ticket or mapping, and files one setup ticket for an admin if something is missing.
- **Map** (`catalyst team map <KEY>`) saves a mapping from the team's existing stages and creates nothing in Linear.
- **Adopt** (`catalyst team adopt <KEY>`) creates the missing stages and Catalyst's labels with the admin's own Linear authorisation, including the hold label a failed phase uses when the team has no remediate stage (`teams[].labels.hold`). The label alone means nothing failed.

Map when the team's stages already cover the work, Adopt when they do not.
