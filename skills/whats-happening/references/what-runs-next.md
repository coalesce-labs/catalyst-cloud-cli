# Dispatch

Queues update within seconds. Dispatch sorts by priority, created time, identifier; mid-ladder tickets precede them by phases completed. Order never grants eligibility.

An operator sets the repository concurrency cap, default 20, displayed in settings. Pause means zero, preserving the cap. Any member reads which repositories are paused, by whom, when and why with `catalyst repo status`; a workspace owner or admin pauses one with `catalyst repo pause <owner/name> --reason <why>` and resumes it with `catalyst repo resume <owner/name>`. Teams share capacity, including comment-wake.

WIP limits starts per project, one Linear team across repositories: project setting, operator's account value, then 12; zero prevents starts. Members read `catalyst project wip-limit get --team <KEY>`; owners/admins use `set <n>` or set default. Only first phases are held; later phases continue. Count live tickets past dispatch or granted a first phase, including waits/blocks/parks; exclude never-started, backlog and local-lane. Idle at the limit means started tickets wait; use unstick, catalyst-github or what-needs-me.

Routing selects the first candidate passing capability, configured model, provider availability, eligible slot/headroom when needed, and parameters. No survivor gives `no_eligible_account_slot` if capacity skipped a candidate, otherwise routing_unavailable. Stage defaults are global; no routing setting exists and a Codex-first pipeline cannot be promised.

Priority reorders; dispatch starts; backlog stops future phases/rounds without canceling. The person/project owner moves cards. Contract merge.prLabels holds keep PRs out of the queue; ask relations block tickets; the release label corrects ask-shape false positives. Nothing interrupts a running phase. Failed phases need no requeue; manual moves usually restart counts. Priority never overrides blockers.

Explain why not next: position means capacity, so report tickets ahead/running. With none running, read accounts. Reasons use why-is-it-stuck.md; missing means another team, terminal or unknown, so verify the id.
