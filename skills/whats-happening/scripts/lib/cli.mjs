#!/usr/bin/env node
// lib/cli.mjs — the one way a skill script reaches Catalyst Cloud: spawn the catalyst CLI.
// The CLI holds the SDK and the key; this file holds neither. It reads customer.json only
// to learn where the CLI lives, and it exits 2 with one line when the machine is not connected.
// Run any script beside this one with --help; this file is a library and is never run directly.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_COMMAND, hasCredential } from "./credential.mjs";

export const PACKAGE = "@catalyst-cloud/cli";
/** The package ships two commands, so npx needs the one to run named: `npx -p <package> catalyst`. */
export const NPX_ARGS = ["-p", PACKAGE, "catalyst"];
export const NOT_CONFIGURED_EXIT = 2;

export function configPath() {
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/";
  return join(home, ".config", "catalyst-cloud", "customer.json");
}

/** The connected-machine config, or exit 2 with the one line that says how to connect. */
export function loadConfig() {
  const path = configPath();
  if (!existsSync(path)) notConfigured(`no config at ${path}`);
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (!hasCredential(cfg)) notConfigured(`config at ${path} has no key or login`);
    return cfg;
  } catch (err) {
    if (err && err.exitCode === NOT_CONFIGURED_EXIT) throw err;
    notConfigured(`config at ${path} is unreadable`);
  }
}

function notConfigured(why) {
  process.stderr.write(`not connected (${why}) — run: ${CONNECT_COMMAND}\n`);
  process.exit(NOT_CONFIGURED_EXIT);
}

/**
 * Run one catalyst verb and return {code, stdout, stderr}. Uses the CLI path the login
 * recorded when it still exists, else `npx <package>`. A CLI exit of 2 with a "not joined" or
 * "not connected" line is turned into this script's own exit 2, so every caller sees one contract.
 * A caller that must not pass the CLI's words on as they are gives `say`, which rewrites that line before it is printed.
 */
export function runCli(args, opts = {}) {
  const cfg = loadConfig();
  const useRecorded = typeof cfg.cliPath === "string" && existsSync(cfg.cliPath);
  const cmd = useRecorded ? process.execPath : "npx";
  const argv = useRecorded ? [cfg.cliPath, ...args] : [...NPX_ARGS, ...args];
  const res = spawnSync(cmd, argv, {
    input: opts.stdin,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: !useRecorded && process.platform === "win32",
    env: process.env,
  });
  if (res.error) {
    process.stderr.write(`could not run ${cmd}: ${res.error.message}\n`);
    process.exit(NOT_CONFIGURED_EXIT);
  }
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.status === NOT_CONFIGURED_EXIT && /not (joined|connected|configured)/i.test(stderr)) {
    process.stderr.write(opts.say ? `${opts.say(stderr)}\n` : stderr);
    process.exit(NOT_CONFIGURED_EXIT);
  }
  return { code: res.status ?? 1, stdout, stderr };
}

/** Run a verb and require success; on failure print the CLI's own stderr and exit with its code (or 1). */
export function mustRun(args, opts = {}) {
  const r = runCli(args, opts);
  if (r.code !== 0) {
    if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    if (r.stdout && !opts.quiet) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    process.exit(r.code === 0 ? 1 : r.code);
  }
  return r;
}

/** Parse the CLI's --json stdout; a non-JSON answer is a failed check, exit 1. */
export function parseJson(stdout, what = "output") {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    process.stderr.write(`could not parse ${what} as JSON: ${stdout.trim().slice(0, 200)}\n`);
    process.exit(1);
  }
}

/** Minimal flag parsing for the scripts: --name value, --name=value, --flag, repeated flags collect. */
export function parseFlags(argv, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true, flags, positionals };
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const s = spec[name];
      if (!s) {
        process.stderr.write(`unknown option --${name} (try --help)\n`);
        process.exit(1);
      }
      if (s.value) {
        if (value === undefined) value = argv[++i];
        if (value === undefined || value === "") {
          process.stderr.write(`--${name} needs a value\n`);
          process.exit(1);
        }
        if (s.repeat) (flags[name] ??= []).push(value);
        else flags[name] = value;
      } else flags[name] = true;
      continue;
    }
    positionals.push(a);
  }
  return { help: false, flags, positionals };
}

export function printHelp(usage, spec, notes = []) {
  const lines = [`Usage: ${usage}`, ""];
  const names = Object.keys(spec);
  if (names.length) {
    lines.push("Options:");
    for (const n of names) lines.push(`  --${n}${spec[n].value ? " <value>" : ""}  ${spec[n].help}`);
    lines.push("");
  }
  lines.push(...notes, "", "Exit codes: 0 ok · 1 the check failed or the arguments were wrong · 2 this machine is not connected");
  process.stdout.write(lines.join("\n") + "\n");
}
