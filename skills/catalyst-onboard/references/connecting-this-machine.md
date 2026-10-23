# Connecting this machine

## Which cloud account is this machine on

`catalyst status` prints the account on its `Tenant:` line, the API, and the config paths. Say "your cloud account" and its name. The credential is the only account selector; there is no `--account`. If the cloud names no account for the login, stop and say so.

## Logging in

Keyless is the preferred rail: `catalyst login` with no key prints a short code and a URL the person approves in a browser, or from a phone. Ask first, and run it once per code. The session refreshes silently, so they stay connected for months.

A **personal key** is the fallback for a script or an unattended shell, where nobody can approve a code. Offer `catalyst login` first; a key is minted only in the browser, so for an unattended machine any active member mints one at Settings → API keys. The environment form keeps it out of shell history:

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst login
```

`CATALYST_CLOUD_BASE_URL` or `--base-url` pins a non-default cloud. The account key (`ctc_acct_`) belongs to hosts and runners: a person connected with it has no name on anything their agent writes, and "what needs me" cannot mean them.

## An unmatched Linear identity

An unmatched Linear identity is the person's to match: `catalyst identity linear status`, then `catalyst identity linear options`; they pick their own listed identity and you run `catalyst identity linear set <linearUserId>`. An identity someone else claimed, and an inactive seat, need an owner or admin at Settings → Members; no command does this yet, so raise one ask to them. Connecting Linear personally does not set the identity: the identity and the personal grant are two different stored facts. Until the identity is matched, "what needs me" shows everyone's asks.

## What login writes

`~/.config/catalyst-cloud/customer.json` (mode 0600) holds the credential, the resolved account and person, and this CLI's path for skill scripts; `contract.json` beside it caches the contract. `CATALYST_SKILLS_HOME` moves the directory. With no home directory (a container, or `HOME` unset or `/`) the config lands under `/`: stop, confirm this is the person's own machine, and set `CATALYST_SKILLS_HOME` if it is. Login installs no skills (`references/skill-sources.md`).

## When login fails

- **"Your login expired or was revoked."** One fresh `catalyst login`.
- **A 401 on the key rail.** A stale, mistyped or revoked key: offer a keyless `catalyst login` instead; an unattended machine needs a new key from Settings → API keys.
- **A 403 on the contract naming an older cloud.** The cloud lacks personal-key access: update the cloud, or use the account key until then.
- **A line naming two contract versions.** `npm install -g @catalyst-cloud/cli@latest && catalyst login` before using the other skills.
- **A refusal naming `jwt-no-membership`.** The cloud learns of a person at their first sign-in to the app. Hand over the app's sign-in link once, then offer to run `catalyst login` again. If it repeats, their seat is inactive and an owner or admin activates it.
- **A refusal naming `jwt-org-unmapped`, or "no Catalyst workspace yet".** The sign-in reached Catalyst with no workspace behind it: Catalyst is joined by invitation, not sign-up. The invitation email (or the workspace admin who sends one) is the missing step; once it is accepted, run the install command or `catalyst login` again.

Retry a failed login once, by hand, after the fix. A key goes into the login command or `CATALYST_CLOUD_TOKEN` and nowhere else: never a ticket, a transcript, or a file you write. After a bundle update, the next command prints a one-line notice; read it to the person if they are watching.
