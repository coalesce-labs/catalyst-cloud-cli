# Proving one ticket end to end

A green readiness verdict says each part is connected. It does not prove a real ticket gets all the way to a merge. `catalyst smoke readme` proves that with one small ticket. Offer it as the last step of onboarding, once, and only after a full `catalyst onboard` run exits 0.

## When to offer it

- Offer it once, as a yes-or-no question with the default no. Never run it unasked, and never with `--yes` unless the person asked for the check.
- First run `catalyst capabilities --json`. If it does not list `smoke readme`, say that CLI 0.16.52 or later adds the check (`catalyst update`), and stop there. No other command does this job.
- It needs a project: one Linear team and a repository registered to it. Use the team the person picked during onboarding, and ask which repository only when the team has more than one.

## What to say before running it

Say what it writes, in one or two sentences:
- one real ticket on that team, titled "Catalyst Cloud smoke: add one README line";
- one pull request that adds the line `Catalyst Cloud enabled` at the end of README.md;
- the comments the pipeline normally posts on a ticket.

The team's own merge rules apply. If a person keeps merge control on that repository, the check stops at "waiting on the owner", and that is a correct result.

## Running it

```sh
catalyst smoke readme --team <KEY> --repo <owner/name>
```

- It prints one line each time the ticket moves: elapsed seconds, the ticket's stage, the phases so far, and the pull request.
- Each stage gets a deadline: 15 minutes to start, 45 for a phase, 60 for the merge. `--deadline phase=90` changes one of them.
- `--json` prints one result on stdout, with progress on stderr. The result carries `status`, `reason`, `next`, `ticket`, `url`, `pullRequest` and `elapsedSeconds`.
- If the run is interrupted, run the same command again. It picks up the same ticket and files no second one.

## Reading the result

Read back `status`, the ticket and pull request links, and the `next` line, which says who acts. Only `merged` means the check passed.

| status | exit | what it means | who acts next |
| -- | -- | -- | -- |
| `merged` | 0 | The ticket's own pull request merged into the default branch, the commit it landed as is on that branch, and README.md there has the line | nobody: work can run end to end |
| `refused` | 3 | Nothing was created. `reason` says why: the line is already there, there is no README.md, Catalyst cannot read the repository, the repository is not registered to the team, the team is not set up for Catalyst, or the team's dispatch is closed | the person or an owner or admin, as `next` says |
| `waiting_on_owner` | 4 | The pull request is ready, and a hold label or a person's own pull request keeps merge control with a person. Or the pull request was ready and nothing merged it by the merge deadline | the person who merges on that repository |
| `blocked` | 5 | Something holds the ticket until a person acts, the ticket was canceled, or the pull request closed without merging. `next` names what releases it | read it with the `whats-happening` skill, then `unstick` |
| `deadline_missed` | 6 | A stage made no progress before its deadline. `reason` names the stage | read the ticket with the `whats-happening` skill |
| `merged_unverified` | 7 | It merged, but the merge could not be confirmed. `reason` names what is missing | see below |

`merged_unverified` reasons:
- `cloud_omits_merged_commit`: the workspace's cloud does not report the commit a pull request landed as yet.
- `merged_commit_unknown` or `ancestry_unknown`: the cloud had not recorded the merge commit, or could not compare it with the default branch, before the deadline. Running the command again re-reads it.
- `merged_commit_not_on_default_branch` or `merged_into_other_branch`: the pull request merged somewhere other than the default branch.
- `merged_without_marker`: it merged, but README.md on the default branch does not have the line.
- `marker_unavailable:<cause>`: Catalyst could not read README.md to confirm.

Exit 2 is an error before any result. `smoke-unsupported` means the workspace's cloud does not offer the README check yet, so nothing was created. Exit 1 is a mistake in the command line.

## What you never do

- Report the check as passed for anything but `merged` with exit 0.
- Merge, close, revert or approve the trial's pull request, or remove a hold label, to get a result. Those are the person's.
- Run it against a different repository or team to get a green result.

## After the trial

The ticket and pull request stay as a record. The line stays on the default branch. It is harmless, and the person decides:
- **Keep it.** Nothing else to do.
- **Remove it.** The person opens a normal pull request that deletes the line and merges it under their usual rules.

Running the command again re-reads the same trial and never files a second ticket or adds a second line. Once the line is removed, that re-read reports `merged_unverified` with `merged_without_marker`. That is expected, because this trial already passed. A canceled trial ticket frees the slot, and the next run files a new ticket. A merged trial cannot be started over yet.
