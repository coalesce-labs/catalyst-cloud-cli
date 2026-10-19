import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {packageRoot} from './config.js';

export const NATIVE_EGRESS_DIR='/var/lib/catalyst/session-egress';
export const EGRESS_ARTIFACTS=[
 {name:'session-egress.py',digest:'a20cedfa1e883127ec461e4b7f9588d379fe1633b8244ecd703c81f589d3f142',path:'/usr/lib/catalyst/session-egress.py',mode:0o755},
 {name:'catalyst-session-egress.service',digest:'703c150ab23ec87aea47cfc394f63e061b66c4b8c1454a88a9be879c161ce2a5',path:'/etc/systemd/system/catalyst-session-egress.service',mode:0o644},
 {name:'catalyst-session-egress-attest.service',digest:'94fa75ea0616f6a1172fc20ca637a5727c36456357e4a977d5bdd65f2fad2e8d',path:'/etc/systemd/system/catalyst-session-egress-attest.service',mode:0o644},
 {name:'catalyst-session-egress-attest.timer',digest:'176622c11c835601b95f36e375ba3c2e993136976c67e5d49559f13a3454fef9',path:'/etc/systemd/system/catalyst-session-egress-attest.timer',mode:0o644},
] as const;
interface Metadata {uid:number;mode:number;file:boolean;directory:boolean;symlink:boolean}
export interface EgressRead {
 read:(path:string)=>Buffer;
 stat:(path:string)=>Metadata;
 systemctl:(args:string[],signal?:AbortSignal)=>Promise<string|null>;
}
const nodeReads:EgressRead={
 read:readFileSync,
 stat:path=>{const s=lstatSync(path);return{uid:s.uid,mode:s.mode,file:s.isFile(),directory:s.isDirectory(),symlink:s.isSymbolicLink()};},
 systemctl:(args,signal)=>new Promise(resolve=>{execFile('/usr/bin/systemctl',args,{timeout:10000,signal,maxBuffer:65536,env:{PATH:'/usr/bin:/usr/sbin:/bin:/sbin',LC_ALL:'C'}},(error,stdout)=>resolve(error?null:stdout));}),
};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Read-only prerequisite. It cannot install units, invoke the producer or synthesize a proof.
 * The unprivileged supervisor independently validates the same mounted proof before work. */
export async function nativeEgressReady(now:number,signal?:AbortSignal,io:EgressRead=nodeReads):Promise<boolean>{
 if(signal?.aborted)return false;
 try{
  for(const artifact of EGRESS_ARTIFACTS){const stat=io.stat(artifact.path);if(stat.symlink || !stat.file || stat.uid!==0 || (stat.mode&0o777)!==artifact.mode || hash(io.read(artifact.path))!==artifact.digest)return false;}
  const dir=io.stat(NATIVE_EGRESS_DIR),path=join(NATIVE_EGRESS_DIR,'attestation.json'),stat=io.stat(path);
  if(dir.symlink || !dir.directory || dir.uid!==0 || (dir.mode&0o777)!==0o755 || stat.symlink || !stat.file || stat.uid!==0 || (stat.mode&0o777)!==0o644)return false;
  const bytes=io.read(path);if(bytes.length>4096)return false;
  const proof:unknown=JSON.parse(bytes.toString('utf8'));
  if(!proof || typeof proof!=='object' || !('version' in proof) || proof.version!==1 || !('enforcement' in proof) || proof.enforcement!=='nftables-docker-forward-v1' || !('bridge' in proof) || proof.bridge!=='catalyst-sess0' || !('verifiedAtMs' in proof) || typeof proof.verifiedAtMs!=='number' || !Number.isSafeInteger(proof.verifiedAtMs) || proof.verifiedAtMs>now+300000 || now-proof.verifiedAtMs>900000)return false;
  for(const unit of ['catalyst-session-egress.service','catalyst-session-egress-attest.timer'])if((await io.systemctl(['is-enabled',unit],signal))?.trim()!=='enabled')return false;
  const boot=await io.systemctl(['show','catalyst-session-egress.service','--property=ActiveState,SubState,Result'],signal);
  const timer=await io.systemctl(['show','catalyst-session-egress-attest.timer','--property=ActiveState,SubState,NextElapseUSecMonotonic'],signal);
  if(!boot || !timer)return false;
  const fields=(text:string)=>Object.fromEntries(text.trim().split('\n').map(line=>line.split('=')));
  const b=fields(boot),t=fields(timer);
  return !signal?.aborted && b.ActiveState==='active' && b.SubState==='exited' && b.Result==='success' && t.ActiveState==='active' && t.SubState==='waiting' && typeof t.NextElapseUSecMonotonic==='string' && t.NextElapseUSecMonotonic!=='0' && t.NextElapseUSecMonotonic!=='';
 }catch{return false;}
}

/** Exact bundled bytes are checked before showing the one elevated install command (CTC-6180). */
export function nativeEgressInstallCommands():string|null{
 const vendor=join(packageRoot(),'vendor'),root=join(vendor,'self-host/linux-session-egress');
 try{readFileSync(join(vendor,'install-session-egress.sh'));for(const artifact of EGRESS_ARTIFACTS)if(hash(readFileSync(join(root,artifact.name)))!==artifact.digest)return null;}catch{return null;}
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 return `sudo sh ${quote(join(vendor,'install-session-egress.sh'))}`;
}
