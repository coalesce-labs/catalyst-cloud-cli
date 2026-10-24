---
name: what-this-repo-needs
description: >-
  What environment variable names does this repository need, and where does each one come from? Scans the repository offline (no login, no network) and lists the names in three groups (build/test, deploy-only, bindings), each with where it was found, what uses it, and where a local value would come from. Never reads a value or prints one. Also checks the environment variable table in `.catalyst/catalyst.toml` offline. Use when someone asks "what does catalyst.env.json mean", "what env vars does this repo need", "why does the container need this", or before reviewing or writing the declaration.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.36 — written in this repository for customer accounts -->

# What this repository needs

Say this first, in your own words, before you scan: the fleet builds and tests this repository in a container that has only what is declared, nothing guessed. The names below are what that container needs; none of them is a value, and this tool never reads or shows one.

## Run first

- `node scripts/inventory.mjs [path] --help`: scans the repository (default: here) and prints the names in three groups: build/test, deploy-only, bindings. Each name shows where it was found (file:line), what uses it, and where a local value would come from: a `.env` file, your shell, a CI secret, or a Cloudflare binding. `--json` gives the same data in machine form.
- `node scripts/check.mjs [path] --help`: checks TOML syntax and the environment variable table in `.catalyst/catalyst.toml` (default) or the repo-relative path you name. It never reads or prints a variable value. The old root JSON declaration is not read by the cloud.

Then ask the person to review the grouped list: for each name, keep it, drop it, or move it to a different group. Keep your own reasoning short; the list is the point.

## Load on demand

| when | read |
| -- | -- |
| the person asks what a group means, or why a wrangler.toml entry is or is not a binding | `references/what-each-group-means.md` |

## Rules

- Report only. This tool writes no `.catalyst/catalyst.toml` and proposes nothing.
- Print names only: never a `.env` value, a secret, or a committed `wrangler.toml [vars]` value. Give the name, where it was found, and where a local value would come from.
- A Cloudflare (or other platform) binding is not an environment value; keep the two apart.
- This reads the repository only, with no login and no network call. The account-scope `catalyst environment` verb reads your cloud account's own declaration.
