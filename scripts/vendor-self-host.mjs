#!/usr/bin/env node
// The self-hosted runner's Compose file, copied byte for byte from catalyst-cloud's deploy/self-host
// at a pinned commit. That repository is private, so a customer's `catalyst onboard` cannot fetch it.
// Never edit vendor/self-host/compose.yaml by hand: move `commit` and regenerate.
// The Mac host-disk sampler and its LaunchAgent template ride the same commit (CTC-5929).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "b304efd232e298c01cba433f5f916c784cbe1165";
const files = ["deploy/self-host/compose.yaml", "deploy/self-host/compose.darwin-thoughts.yaml", ...["producer.mjs", "verifier.mjs", "verifier.d.mts", "watchdog.mjs", "watchdog-deadline.mjs", "service.plist.in", "manifest.json"].map(name => "deploy/self-host/darwin-thoughts-custody/"+name), ...[
  "session-egress.py", "catalyst-session-egress.service", "catalyst-session-egress-attest.service", "catalyst-session-egress-attest.timer",
].map(name => "deploy/self-host/linux-session-egress/"+name), "deploy/self-host/host-disk-sample.py", "deploy/self-host/launchd/dev.catalystcloud.host-disk.plist"];
const target = join(root, "vendor/self-host");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceRepo = process.env.CATALYST_SELF_HOST_SOURCE;
if (!sourceRepo && process.argv.includes("--check")) {
  const manifest = JSON.parse(readFileSync(join(target, "provenance.json"), "utf8"));
  if (manifest.commit !== commit) throw new Error("Unexpected self-host source commit");
  if(Object.keys(manifest.sha256).sort().join("\n")!==[...files].sort().join("\n"))throw new Error("Unexpected self-host artifacts");
  for(const file of files) if (sha(readFileSync(join(target,file.replace("deploy/self-host/","")))) !== manifest.sha256[file])
    throw new Error("Vendored self-host artifact drifted from its recorded hash: "+file);
  process.exit(0);
}
if (!sourceRepo) throw new Error("Set CATALYST_SELF_HOST_SOURCE to a catalyst-cloud checkout containing the pinned commit");
const contents=files.map(file=>[file,execFileSync("git",["-C",sourceRepo,"show",`${commit}:${file}`])]);
const provenance=`${JSON.stringify({repository:"coalesce-labs/catalyst-cloud",commit,sha256:Object.fromEntries(contents.map(([file,bytes])=>[file,sha(bytes)]))},null,2)}\n`;
for(const [file,bytes] of contents){
 const destination=join(target,file.replace("deploy/self-host/",""));
 if(process.argv.includes("--check")){
  if(!bytes.equals(readFileSync(destination)))throw new Error("Vendored self-host artifact drift: "+file);
 }else{mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes);}
}
if(process.argv.includes("--check")){
 if(provenance!==readFileSync(join(target,"provenance.json"),"utf8"))throw new Error("Vendored provenance drift");
}else writeFileSync(join(target,"provenance.json"),provenance);
