# What the browser owns

Headless first: when the catalyst CLI, the SDK or an agent route can do a step, ask "Want me to do that for you?" and run it on a yes; name a web page only for a step that needs a person in a browser by nature (signing in, an OAuth or app-install consent), and then hand over the exact link the CLI printed. A step with no command yet is a gap: say so in one clause and hand over the exact page.

## Commands you offer to run

| step | command |
| -- | -- |
| registering a repository and attaching it to a project | `catalyst onboard --team <KEY> --repo <owner/name>` (an owner or admin) |
| checking, mapping or adopting a project's stages | `catalyst team check <KEY>`, `catalyst team map <KEY>`, `catalyst team adopt <KEY>` |
| entering a repository's values | `catalyst var set NAME --repo <owner/name>`, `catalyst secret set NAME --repo <owner/name>` |
| creating `<your GitHub org>/thoughts` | `gh repo create <org>/thoughts --private --add-readme` |

## A browser by nature

Each is a sign-in or a consent a person grants in their own session. Start it with the command, then hand over only the link it printed.

| step | how it starts |
| -- | -- |
| approving the login | the URL and short code `catalyst login` printed |
| connecting the Linear integration, installing the GitHub App | `catalyst onboard` prints the consent link; without one, `<their cloud>/settings/connections` (Settings → Integrations) |
| letting the App reach `<your GitHub org>/thoughts` | the App's installation page for that org: All repositories, or add `thoughts` (step 5 of `references/the-one-path.md`) |
| connecting personal Linear, then personal GitHub | the URL `catalyst connections personal <linear\|github> start` printed |

## Not a command yet

These have no command in this CLI yet. Say so in one clause, hand over the page, and never guess at a route.

| step | where |
| -- | -- |
| adding a coding account, or replacing its credential | the AI accounts page the script printed |
| approving one repository's declaration | that repository's Environment page (`references/declaring-a-repository.md`) |

`catalyst environment` handles a workspace-wide declaration. `catalyst capabilities` lists what this CLI can do; a verb it lists replaces the page for that step. ⛔ Only the CLI makes requests; if you find yourself building a URL for one of these, stop.

## The link to hand over

Use the links `node scripts/where-am-i.mjs` prints, built from the `API:` line of `catalyst status`, never a host from memory: the wrong account's settings page costs more than none.

## Handing over, and coming back

Hand over one link, one action named the way the page names it, and what you will check when they are back. Then wait, without running anything.

When they come back, read the part again (step 5 of a turn in `SKILL.md`). The contract is cached, so a page can be seconds ahead of it: refresh once before reporting a disagreement, then ask what they saw. A step is done when the instrument reads done.
