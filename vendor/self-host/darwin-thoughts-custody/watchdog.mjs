import fs from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, normalize, dirname } from "node:path";
import { armProducerDeadline } from "./watchdog-deadline.mjs";

// Separate process: blocked worker IO cannot prevent the absolute process-group kill.
function fail() {
  process.stderr.write("darwin_thoughts_producer:service_refused\n");
  process.exit(1);
}
if (
  process.platform !== "darwin" ||
  !process.getuid ||
  !process.geteuid ||
  process.getuid() <= 0 ||
  process.getuid() !== process.geteuid() ||
  process.argv.length !== 4
)
  fail();
const [artifact, config] = process.argv.slice(2);
for (const path of [artifact, config]) {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.endsWith("/") ||
    path.includes("\0") ||
    fs.realpathSync(path) !== path
  )
    fail();
  const stat = fs.lstatSync(path);
  const parent = fs.lstatSync(dirname(path));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600 ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o7777) !== 0o700
  )
    fail();
}
const deadlineMs = Date.now() + 20_000;
const worker = spawn(process.execPath, [artifact, config, String(deadlineMs)], {
  cwd: "/",
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let bytes = 0;
let timedOut = false;
function kill() {
  guard.expire();
}
const guard = armProducerDeadline({
  workerPid: worker.pid,
  deadlineMs: deadlineMs + 2000,
  onDeadline: () => {
    timedOut = true;
  },
  onUnreaped: fail,
});
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 4096) kill();
  });
}
worker.on("error", () => {
  guard.cancel();
  fail();
});
worker.on("close", (code) => {
  guard.cancel();
  if (timedOut || code !== 0) fail();
  process.exit(0);
});
process.on("SIGTERM", () => {
  kill();
});
process.on("SIGINT", () => {
  kill();
});
