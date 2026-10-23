# Coding accounts

snapshot.mjs --accounts omits credentials/emails. An owner/admin enrols, pauses, removes or replaces credentials at `<their cloud>/settings/coding-accounts`; no command does these yet. `catalyst accounts` reads them. It leaves out removed accounts (revoked, or paid access that ended). They are kept for history, never take work again and take no new credential, so never suggest reviving one. `catalyst accounts --all` lists them.

Slots identify credentials, not emails. Claude/GLM/Qwen use Claude CLI, Codex uses Codex; GLM/Qwen also use OpenCode. Routing names the model.

Declared state is operator-set active/disabled. Observed health is healthy/degraded/unknown, polled every five minutes for active slots and daily for disabled ones. Credential conflicts/auth mismatches quarantine; Replace credential on the account's page clears it.

Providers can limit how much one account runs in a period. An account at its limit (walled) is left alone until it can run again. Hitting a limit mid-phase ends that phase's session. Where the provider reports an account's usage, a phase is offered only to an account with room to finish it. Some accounts take several phases at once up to a cap; others take one. A provider's status page does not show one account's limits.

When idle, explain. routing_unavailable or no_eligible_account_slot points here. Read --accounts: empty means no enrolment; inspect walled, quarantined and reason. Silence proves nothing.
