import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
const require=createRequire('/mnt/projects/teleprompt/package.json');
const {chromium}=require('@playwright/test');
const root='/tmp/teleprompt-audit-2026-09-04';
const profile=await mkdtemp(root+'/profile-');
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const executable=root+'/release/linux-unpacked/teleprompt';
const child=spawn(executable,[`--remote-debugging-port=${port}`,'/mnt/projects/teleprompt/README.md'],{env:{...process.env,XDG_CONFIG_HOME:profile,CHROME_DEVEL_SANDBOX:'/mnt/projects/teleprompt/release/linux-unpacked/chrome-sandbox'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
const results={profile,source:'/mnt/projects/teleprompt/README.md',checks:[]};
let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
for(let i=0;i<100&&!browser;i++){if(child.exitCode!==null)throw Error(`exit ${child.exitCode}: ${logs}`);try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:500});}catch{await delay(100);}}
if(!browser)throw Error('CDP timeout '+logs);
async function surface(name){for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages())){if(p.url()===`teleprompt://app/${name}.html`&&await p.evaluate(()=>!!document.querySelector('#root')?.children.length).catch(()=>false))return p;}await delay(100);}throw Error('surface unavailable '+name);}
let controls=await surface('controls');let overlay=await surface('overlay');
for(let i=0;i<100;i++){if((await controls.evaluate(()=>window.controlsApi.bootstrap())).activeDocument)break;await delay(100);}
const boot=await controls.evaluate(()=>window.controlsApi.bootstrap());
const source=await readFile(results.source,'utf8');
results.checks.push({name:'real README import',pass:boot.activeDocument?.content===source,documents:boot.snapshot.documents.length});
try{const empty=await controls.evaluate(({id,revision})=>window.controlsApi.updateDocument(id,revision,''),boot.activeDocument);results.checks.push({name:'empty update accepted',pass:empty.ok,result:empty});}catch(e){results.checks.push({name:'empty update accepted',pass:false,error:String(e)});}
await controls.screenshot({path:root+'/controls.png'});
await overlay.screenshot({path:root+'/overlay.png'});
const o=await overlay.evaluate(()=>window.overlayApi.bootstrap());
results.checks.push({name:'overlay source paths absent',pass:!JSON.stringify(o.snapshot).includes('/mnt/projects/')});

await controls.evaluate(()=>window.controlsApi.togglePlayback());await delay(650);
const oldProgress=await controls.evaluate(()=>window.controlsApi.bootstrap());
await controls.evaluate(()=>window.controlsApi.seek(0));
const staleResult=await overlay.evaluate(old=>window.overlayApi.checkpoint({documentId:old.activeDocument.id,revision:old.activeDocument.revision,sessionId:old.snapshot.playbackSessionId,position:old.snapshot.scrollPosition,terminal:!old.snapshot.playing}),oldProgress);
const afterSeek=await controls.evaluate(()=>window.controlsApi.bootstrap());
results.checks.push({name:'observed pre-seek checkpoint rejected',pass:!staleResult.ok,observedPosition:oldProgress.snapshot.scrollPosition,result:staleResult,positionAfterReplay:afterSeek.snapshot.scrollPosition});
if(afterSeek.snapshot.playing)await controls.evaluate(()=>window.controlsApi.togglePlayback());

const recoveries=[];
for(let i=0;i<4;i++){
const t=Date.now();const session=await controls.context().newCDPSession(controls);await session.send('Page.crash').catch(()=>{});
await delay(350);controls=await surface('controls');
const next=await controls.evaluate(()=>window.controlsApi.bootstrap());recoveries.push({attempt:i+1,elapsedMs:Date.now()-t,documentIntact:next.activeDocument?.content===source});
}
results.checks.push({name:'recovery stops after three failures within 60s',pass:recoveries.length<=3||recoveries.reduce((total,item)=>total+item.elapsedMs,0)>=60000,recoveries});
} catch(e){results.error=String(e);} finally {
if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(8000)]);if(child.exitCode===null)child.kill('SIGKILL');}
if(browser)await browser.close().catch(()=>{});
await writeFile(root+'/runtime.log',logs);await writeFile(root+'/runtime-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}
