# What a phase needs to run

A phase needs the `coding accounts` and `host` parts of `node scripts/where-am-i.mjs`, however much else is finished. Say a phase can run only when the script's last line says nothing is left; otherwise name the unfinished part and its owner, and say no work will start yet.

## Coding accounts

One coding account is enough to start. A second gives the router somewhere to go at a limit; offer it later.

### The kinds, and enrolling

Settings → AI accounts lists the providers this workspace can connect and what each one asks for; an API key is billed per token by its provider. Do not promise a provider. Ask which provider the person has a key for. No command lists the providers yet, so check the name against that page; if it is not there, say so and ask whether they have a key from one that is.

Adding an account has no command yet, so it is a browser step for now: on Settings → AI accounts, an owner or admin picks the provider, labels the account, and pastes the key into a write-only field. If the page says Catalyst takes over a login, say so before the paste. Call an account by its label, else its email, else its slot (`displayName` in `catalyst accounts --json`).

### The states

**Instrument:** `codingAccounts` in `catalyst contract`; with `enrolled`, the script also reads `catalyst accounts` for each credential. With no `codingAccounts` (an older cloud) it reads `catalyst accounts` alone, and the owner is an owner or admin at `<their cloud>/settings/coding-accounts`.

| state | what it says | what to do |
| -- | -- | -- |
| `enrolled` | one is active; another can still have a dead credential | "<provider> account <slot> needs a new credential" is the next step: `references/replacing-a-credential.md`. `unreadable` detail: read again later |
| `none_enrolled` | none enrolled | hand over the page to the enroller the contract names; there is no command to add one yet |
| `inactive` | every account is out of rotation | reactivate one on its page (no command does this yet), never enrol another |
| `unread` | the cloud could not read them | it is not "no accounts"; read again later |

**A cancelled or ended account** stays for reporting, unused, and does not hold setup up; say so in one clause. It keeps its own login: a token from another login would put a live account onto a dead slot. It stays enrolled rather than retired or deleted, and is reactivated on its page only if it can run again.

## Host

The `hosts_current` check reads the same on every project, because it is about the whole account. `pass` means nothing waits on a host, including an account that runs none. `no_host_connected`, `hosts_unreported` (clears when the host reconnects) and `hosts_behind` each mean: name the owner and stop. `unreadable` means no project has been checked yet. The owner and where they act (`fixedWhere`) come from `catalyst contract --path readinessChecks`; when `fixedWhere` is null, name the owner with no page.

⛔ `catalyst ready` treats this check as a note, so it can print READY while no host is connected. The `host` part, not READY, says whether a phase can run.
