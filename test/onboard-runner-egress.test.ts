import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {packageRoot} from '../src/config.js';
const pins={
 'session-egress.py':'a20cedfa1e883127ec461e4b7f9588d379fe1633b8244ecd703c81f589d3f142',
 'catalyst-session-egress.service':'703c150ab23ec87aea47cfc394f63e061b66c4b8c1454a88a9be879c161ce2a5',
 'catalyst-session-egress-attest.service':'94fa75ea0616f6a1172fc20ca637a5727c36456357e4a977d5bdd65f2fad2e8d',
 'catalyst-session-egress-attest.timer':'176622c11c835601b95f36e375ba3c2e993136976c67e5d49559f13a3454fef9',
};
test('customer package carries the four exact reviewed native producer artifacts',()=>{
 const root=join(packageRoot(),'vendor/self-host');
 const manifest=JSON.parse(readFileSync(join(root,'provenance.json'),'utf8'));
 expect(manifest.commit).toBe('b304efd232e298c01cba433f5f916c784cbe1165');
 for(const [name,digest] of Object.entries(pins)){
  expect(createHash('sha256').update(readFileSync(join(root,'linux-session-egress',name))).digest('hex')).toBe(digest);
  expect(manifest.sha256['deploy/self-host/linux-session-egress/'+name]).toBe(digest);
 }
});

import {EGRESS_ARTIFACTS,NATIVE_EGRESS_DIR,nativeEgressReady,nativeEgressInstallCommands,type EgressRead} from '../src/onboard-runner-egress.js';
const now=Date.now();
function fixture(){
 const state={uid:0,symlink:false,corrupt:false,enabled:true,proof:{version:1,enforcement:'nftables-docker-forward-v1',bridge:'catalyst-sess0',verifiedAtMs:now}};
 const calls:string[][]=[];
 const io:EgressRead={
  stat:path=>({uid:state.uid,symlink:state.symlink,file:path!==NATIVE_EGRESS_DIR,directory:path===NATIVE_EGRESS_DIR,mode:path===NATIVE_EGRESS_DIR || path.endsWith('.py')?0o755:0o644}),
  read:path=>{const artifact=EGRESS_ARTIFACTS.find(a=>a.path===path);return artifact ? state.corrupt ? Buffer.from('changed') : readFileSync(join(packageRoot(),'vendor/self-host/linux-session-egress',artifact.name)):Buffer.from(JSON.stringify(state.proof));},
  systemctl:async args=>{calls.push(args);return args[0]==='is-enabled' ? state.enabled?'enabled\n':'disabled\n':args[1]?.endsWith('.timer')?'ActiveState=active\nSubState=waiting\nNextElapseUSecMonotonic=10min\n':'ActiveState=active\nSubState=exited\nResult=success\n';},
 };
 return{state,io,calls};
}
test('genuine producer bytes, root-owned proof and active timer are required',async()=>{
 const f=fixture();expect(await nativeEgressReady(now,undefined,f.io)).toBe(true);expect(f.calls).toHaveLength(4);
 expect(nativeEgressInstallCommands()).toContain('sudo /usr/bin/python3 /usr/lib/catalyst/session-egress.py attest');
});
test.each(['non-root','symlink','changed producer','disabled timer','stale','future','wrong bridge'])('%s cannot certify native egress',async kind=>{
 const f=fixture();if(kind==='non-root')f.state.uid=1000;if(kind==='symlink')f.state.symlink=true;if(kind==='changed producer')f.state.corrupt=true;if(kind==='disabled timer')f.state.enabled=false;if(kind==='stale')f.state.proof.verifiedAtMs=now-900001;if(kind==='future')f.state.proof.verifiedAtMs=now+300001;if(kind==='wrong bridge')f.state.proof.bridge='other';
 expect(await nativeEgressReady(now,undefined,f.io)).toBe(false);
});
