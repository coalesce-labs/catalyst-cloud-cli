# Settings

Use live values and the person's cloud prefix. Owner/admin acts unless stated. Name screen, route, rule. Where a command does the change, offer to run it before naming the screen.

| screen and route | rule |
| -- | -- |
| Integrations, /settings/connections | Connecting Linear needs an admin's consent in their browser, which chooses the account; `catalyst onboard` starts it and prints the consent link. A workspace binds to exactly one account and vice versa; a conflict needs a decision, not retry. |
| Profile, /settings/profile, then Connections | The personal GitHub grant comes first; missing identity or another person's installation refusal means grant personal GitHub first. Offer `catalyst connections personal github start` and hand over the link it prints. |
| Connections | Removing the App on GitHub self-heals the registry; Catalyst unlink uninstalls upstream; neither needs support. |
| Your projects, /settings/projects | Each Catalyst project pairs one Linear team with its registered GitHub repositories. Attach a repository with `catalyst onboard --team <KEY> --repo <owner/name>`; choose the team's default repository here, with no command for that yet. |
| Merging, /settings/projects/$projectId/repositories/$repoId/merging | Merge policy is the variable `CATALYST_MERGE_EVIDENCE_POLICY`: offer `catalyst var set CATALYST_MERGE_EVIDENCE_POLICY --repo <owner/name>`, or change it here. A policy declared in `.catalyst/catalyst.toml` wins over the variable: change it there in a pull request; contract merge gives value/source; catalyst-github only reads. |
| Code reviews, /settings/projects/$projectId/repositories/$repoId/code-reviews | Post review requests as selects a connected member. Strict policy without reviewer never earns ready label; configure reviewer here (no command yet) or change policy. |
| Merge queue, no Catalyst page | After ready label, the merge itself is whatever the repository's own setup does with it; the repo admin owns this. This bundle cannot identify its queue vendor; never guess. |
| Repositories | Shows operator-set runner cap, default 20, paused effective zero; see what-runs-next.md. |
| Secrets /settings/secrets and Environment /settings/environment, plus repository sections | Secrets write-only, variables readable; names are never both. Repository values override account values. Variables may reference vault secrets, expanded only in container. Offer `catalyst var set NAME [--repo <owner/name>]` or `catalyst secret set NAME --repo <owner/name>`; a workspace-wide secret has no command yet. |
| Repositories | Without a registered team nothing reaches a runner, and the failure is silent; an owner or admin can register it with `catalyst onboard --team <KEY> --repo <owner/name>`, so offer that, otherwise raise the fix as an ask. |
| Routing, no settings page for this | Global stage defaults and empty per-account table select default provider; never promise Codex-first. |
