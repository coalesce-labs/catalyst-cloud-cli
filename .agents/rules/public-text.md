---
paths:
  - "README.md"
  - "CONTRIBUTING.md"
  - "packages/catalyst-skills/README.md"
  - "skills/**"
  - "evals/**"
  - "evals-walkthrough/**"
---

# Public text in this pack

This repository is public, and every skill under `skills/` is installed into customers' agents. Treat the README, the skills (their references and the strings their scripts print) and the eval cases as product copy.

## AI accounts

Subscription AI accounts are offered only to workspaces Ryan enables, behind a flag (CTC-4716, 2026-10-03). Everyone else connects token-billed AI accounts. Published text must stay true for everyone, so:

- Describe AI accounts as token-billed: an API key is billed per token by its provider. Never define every AI account as an API key; some workspaces connect other kinds, and published text says nothing about those.
- Do not promise a provider. Ask which provider the person has a key for. No command lists the providers a workspace can connect yet, so Settings → AI accounts is where to check the name, as a gap.
- Never mention AI subscriptions, plan tiers (Claude Pro or Max, ChatGPT Plus, a "coding plan"), setup tokens (`claude setup-token`), Codex `auth.json`, "Sign in with ChatGPT", or 5-hour and 7-day usage windows. Say "usage limits", or "when a provider is limiting an account".
- For an event stream, say "live watch", not "subscription".
- Asked to document a subscription login, decline in a sentence and offer the token-account text instead. Publishing it anyway is Ryan's decision.

## The rest

- Headless first: when the catalyst CLI, the SDK or an agent route can do a step, ask "Want me to do that for you?" and run it on a yes; name a web page only for a step that needs a person in a browser by nature (signing in, an OAuth or app-install consent), and then hand over the exact link the CLI printed. A step with no command yet is a gap: say so in one clause and hand over the exact page.
- A customer has a **workspace**, never a tenant. "Account" means one person's login somewhere. Quoting the CLI's own `Tenant:` output line is the one exception.
- No internal component names (fleet, host, runner, mirror, Durable Object, registry, slot) and no operator routes (`/admin/*`).
- Code comments, `src/`, tests and published CHANGELOG entries are out of scope. Reword only new changelog entries, and flag an old one to Ryan instead of rewriting it.

## The check

`test/public-text.test.ts` fails `bun run test` on any published line that breaks the AI-account rules, naming the file, the line and what to write instead. Fix the text. Add to its `ALLOWED` map only a file that must name the word (a grader that forbids it, say), with the reason.
