# Raising a decision

The body, headings, option format and option cap come from the contract's `askTemplate` and are rendered by the cloud; `node scripts/raise.mjs` passes fields. The cloud labels the ask, keeps it out of dispatch, and holds every ticket it blocks until it is answered.

## When to file one

File an ask when active work is gated on a product call, a priority call between two things that cannot both go first, an approval, or an action only the human can take (a sign-in or consent, a credential, a payment). A settings change a command can make is yours to offer, not an ask. File it **before** proceeding on the default. A TODO line, board row, handoff note or chat question may point at the ask's identifier, never replace it.

Brainstorming, design back-and-forth, a question the human asked first, a retry-or-abandon call a project owner can make, and a system-level failure (one status line; the tickets retry on their own) are not asks.

## What it carries

1. **The question**, one sentence, as the title (`--title`).
2. **Context** the human needs to answer without opening anything else (`--context`), short.
3. **Options**, each one line, realistic, at most the number the contract allows (`--option`, repeated). The cloud letters and formats them.
4. **The default if silent** (`--default`): what proceeds and after how long. It must be sane enough to actually run. The raising agent applies it, after the ask exists, and records that it did; the cloud applies no default on a timer for the asks you raise. The exception is the ask a validate-budget or round-threshold hold raises: the cloud applies its default (re-plan) after 48 hours unanswered.
5. **What it blocks** (`--blocks`, repeated): every ticket held until the answer lands, related atomically with the ask. An ask that holds nothing is refused unless you pass `--nothing-to-block` on purpose, because it never surfaces in Waiting on me. Name every held ticket: the inbox ranks by that count (`references/reading-the-inbox.md`), so an ask that names one ticket when it really holds a project sinks below one holding two chores.

`--ask-key` is an idempotency key: a re-run with the same key does not file a second ask.

## When the answer releases a PR hold

When the decision is whether a held PR may merge, name the PR so the answer lifts the hold itself:

- `--gates-pr <n>` (repeated): each PR the answer releases.
- `--released-by <letter>` (repeated, required with `--gates-pr`): the option letters that release it. Options are lettered A, B, C in the order you gave them, and a letter outside that range is refused.
- `--gates-label hold|hold:preview` (repeated, default `hold`): the labels the answer removes. No other label is accepted.
- `--gates-repo <owner/name>`: the PR's repository. It defaults to the account's repository when the account registers exactly one, and must be one the account registers.

An answer with any other letter leaves the labels in place.

## One ask per decision

Run `node scripts/inbox.mjs` first. When the same decision is already open, attach the new held tickets to it (the `catalyst-linear` skill adds the relation or a comment) rather than filing a twin that splits its urgency.

## Who raises, and where

- A decision inside a project scope is raised by that project's owner; the desk raises what has no owner.
- The ask goes on the held work's team (`--team`); an approval with no natural team goes to the approvals team when the contract names one.
- Each scope's owner raises its own asks, and the human answers them.

## After filing

Cite the identifier the script printed, and only that. Proceed on the default if the work allows it, and say so in the ask's thread (a bookkeeping comment) so the record shows the default was taken. When the answer arrives, `references/settling-an-answer.md`.
