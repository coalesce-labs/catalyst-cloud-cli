# Stalls and escalation

The stall thresholds are **local judgment**, set once by the project's owner and read by `scripts/scope-status.mjs`. The cloud publishes no stall policy and enforces none of these numbers; what it does about a failing ticket is in the contract's `thresholds`.

## The policy file

`assets/stall-policy.json` ships the defaults: minutes a ticket may sit in each slot, with no update and nothing running or leased, before it counts as stalled. To change them, copy it to `~/.config/catalyst-cloud/stall-policy.json` and edit the copy; the script prefers it and prints which file it used (`--stall-policy <file>` picks another). On a busy account a waiting dispatch card is capacity, not a stall, and reviews and CI take real time, so set the dispatch and PR thresholds generously.

## What counts as stuck

All at once: an active slot, nothing running or leased, a last update older than the slot's threshold, and an explainer reason that is not a clock. `scope-status.mjs` checks the first three and hands you the fourth as a command. A running phase is never a stall; its own timeout fails it and the outcome card says so.

## The chase order

Run `catalyst explain <ticket>` and look the reason up in the `whats-happening` skill's `references/why-is-it-stuck.md`. For you as the owner:

- **It releases itself:** wait for the outcome card.
- **The person, with their own login, acts:** do it when the move is yours (re-dispatch, a comment that clears a no-change or validate-budget hold, a question routed to `what-needs-me`), and file an ask when it is theirs.
- **A park or hold a release clears:** once its cause is fixed, the `unstick` skill releases it (`catalyst release <ticket> --because <what changed>`). A round-threshold hold and a review that will not converge refuse that release; the table says what clears each.
- **An owner or admin, in settings, or an operator:** when the person holds that seat and a command can make the change, offer to run it; otherwise one ask per repository or setting.
- **Finished:** close the loop in the summary.

Quote a reason the table does not know as the explainer spelled it.

## Shared causes are one note

When several tickets are offered and nothing takes them, or the explainer names a routing, slot, provider or image condition, the cause is shared (coding-account headroom, a provider outage, a paused repository, a bad runner image). Write one summary line naming the condition and the tickets it holds. `catalyst accounts` reads coding-account status; enrolling or pausing one is the settings page.

## Escalate inward

The order is instrument, you, the desk (`whats-happening`), then the human, who only ever sees an ask. Before anything reaches the human:

1. **Can I decide this myself?** Approach, retry or abandon, rebase or re-cut, ordering: yours. Decide, record it in a bookkeeping note, move on.
2. **Does it need to block?** With a sane default, take it, record it, and file the ask anyway so the human can overrule.
3. **Who else can move it?** A peer steward, the desk or a repository owner comes before the human.

What survives is a product, priority or approval decision, or an action only a human can take: close their own pull request, read a review that will not converge, change a repository setting, apply the release label, answer a merge-policy question.

## Filing the ask

File it through `what-needs-me`, as the app actor: the question as its title, the options, the default if silent, and the stalled ticket in its blocks list so the inbox ranks it by what it holds. Search for an existing ask on the same decision first and attach to it, because two asks split one decision's urgency. Then proceed on the default and say so on the ticket.
