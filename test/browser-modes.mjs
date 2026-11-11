// Run with Node 24 and Chrome installed. Uses only the existing ws dependency.
// All servers, profiles, screenshots and databases are isolated under /tmp.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { puzzleDateAt } from '../src/calendar.js';

// Chrome 134 can stall when switching device emulation between contexts.
// Give each viewport its own Chrome process and storage profile.
if (!process.env.BROWSER_VIEWPORT) {
  for (const viewport of ['desktop','phone']) {
    await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[new URL(import.meta.url).pathname], {
        env:{...process.env,BROWSER_VIEWPORT:viewport},stdio:'inherit',
      });
      child.once('error',reject);
      child.once('exit',code=>code===0 ? resolve() : reject(new Error(`${viewport} browser checks failed (${code})`)));
    });
  }
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(),'squaredle-browser-modes-'));
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const processes = [];
const launch = (cmd,args,env=process.env) => {
  const p = spawn(cmd,args,{env,stdio:['ignore','pipe','pipe']});
  p.logs = '';
  for (const stream of [p.stdout,p.stderr]) stream.on('data',b=>p.logs+=b);
  processes.push(p); return p;
};
async function until(fn,message) {
  for (let i=0;i<100;i++) { const value=await fn(); if(value) return value; await pause(100); }
  throw new Error(message);
}
let ws;
try {
  const server = launch(process.execPath,['src/server.js'],{...process.env,PORT:'0',DB_PATH:join(dir,'db.sqlite3'),NO_FETCH:'1'});
  const port = await until(()=>server.logs.match(/http:\/\/localhost:(\d+)/)?.[1], 'Server failed: '+server.logs);
  const base = `http://127.0.0.1:${port}`;
  const api = async (path,body) => {
    const r=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
    const j=await r.json(); assert(r.ok,JSON.stringify(j)); return j;
  };
  await api('/api/admin/puzzles',{date:puzzleDateAt(),mode:'regular',grid:['A','B','C','D','H','G','F','E','I','J','K','L','P','O','N',''],required:['ABCD','ABCDE','ABCDEF','ABCDEFG','ABCDEFGHIJKL'],bonus:['DCBA']});
  const chrome = launch(process.env.CHROME_PATH || '/opt/google/chrome/chrome',[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0',`--user-data-dir=${join(dir,'chrome')}`,'about:blank',
  ]);
  const endpoint = await until(()=>chrome.logs.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chrome failed: '+chrome.logs);
  ws = new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let seq=0;
  const pending=new Map(),errors=[];
  ws.on('message',data=>{
    const m=JSON.parse(data);
    if(m.id) { const p=pending.get(m.id); pending.delete(m.id); if(!p) return; clearTimeout(p.timer); if(m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
    if(m.method==='Page.javascriptDialogOpening') { console.log('Unexpected dialog:',m.params.message); ws.send(JSON.stringify({id:++seq,sessionId:m.sessionId,method:'Page.handleJavaScriptDialog',params:{accept:false}})); }
    if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text+': '+m.params.exceptionDetails.exception?.description);
  });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000); pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params,sessionId}));
  });
  for (const [name,width,height,mobile] of [['desktop',1280,1000,false],['phone',390,844,true]].filter(([name])=>!process.env.BROWSER_VIEWPORT || process.env.BROWSER_VIEWPORT===name)) {
    console.log(`${name}: starting browser checks`);
    const {browserContextId}=await send('Target.createBrowserContext');
    const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const cdp=(method,params)=>send(method,params,sessionId);
    const evaluate=async expression=>{
      const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}).catch(e=>{throw new Error(`${e.message}: ${expression}`);});
      if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const visible=id=>evaluate(`!!document.getElementById(${JSON.stringify(id)}) && !document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
    const waitVisible=id=>until(()=>visible(id),`${name}: ${id} not visible`);
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:mobile});
    await cdp('Page.navigate',{url:base});
    await until(()=>evaluate("!!document.getElementById('modeExpress')?.onclick"),'App did not initialize');
    await evaluate('localStorage.clear()');
    await cdp('Page.navigate',{url:base});
    await until(()=>evaluate("!!document.getElementById('modeExpress')?.onclick"),'App did not initialize');
    assert.equal(await evaluate("document.getElementById('modeExpress').getAttribute('aria-pressed')"),'true');
    const room=`BR${name.toUpperCase()}`;
    await evaluate(`document.getElementById('roomCode').value=${JSON.stringify(room)};document.getElementById('nickname').value='Anna';document.getElementById('joinBtn').click()`);
    await waitVisible('lobbyView');
    const initial=JSON.parse(await evaluate("localStorage.getItem('roomUsers')"))[room];
    assert(initial.raceIds.express);
    await click('modeRegular');
    await waitVisible('raceView');
    console.log(`${name}: joined Regular`);
    assert.equal(await visible('countdownOverlay'),false);
    assert.equal(await evaluate("document.querySelectorAll('#board .cell').length"),16);
    assert.equal(await evaluate("document.querySelectorAll('#board .cell.blank').length"),1);
    assert.equal(await evaluate("document.querySelector('#board .cell.blank').disabled"),true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'Horizontal overflow');
    // Real pointer gestures on the 4x4 board, with its blank cell retained.
    await evaluate("document.getElementById('board').scrollIntoView({block:'center'})");
    const centers=await evaluate("[...document.querySelectorAll('#board .cell')].slice(0,4).map(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})");
    console.log(`${name}: dragging on the board`);
    if(mobile) {
      await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[centers[0]]});
      for(const point of centers.slice(1)) await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
      await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } else {
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...centers[0],button:'left',buttons:1,clickCount:1});
      for(const point of centers.slice(1)) await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'left',buttons:1});
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...centers[3],button:'left',buttons:0,clickCount:1});
    }
    await until(()=>evaluate("document.getElementById('foundCount').textContent==='1'"),'Drag did not find ABCD');
    console.log(`${name}: drag accepted`);
    const regular=JSON.parse(await evaluate("localStorage.getItem('roomUsers')"))[room];
    const regRace=regular.raceIds.regular;
    const started=(await api(`/api/races/${regRace}?playerId=${regular.playerId}`)).myStartedAt;
    await click('modeExpress'); await waitVisible('lobbyView');
    await click('modeRegular'); await waitVisible('raceView');
    assert.equal(await evaluate("document.getElementById('foundCount').textContent"),'1');
    assert.equal((await api(`/api/races/${regRace}?playerId=${regular.playerId}`)).myStartedAt,started);
    console.log(`${name}: switching/resuming passed`);
    // Race a slow Regular join response against newer Express/Regular choices.
    await evaluate(`window.originalFetch=window.fetch;window.fetch=async (...args)=>{if(args[0]==='/api/rooms/join' && JSON.parse(args[1]?.body||'{}').mode==='regular') await new Promise(r=>setTimeout(r,350)); return window.originalFetch(...args)}; document.getElementById('modeExpress').click();`);
    await waitVisible('lobbyView');
    await evaluate("document.getElementById('modeRegular').click();document.getElementById('modeExpress').click()");
    await waitVisible('lobbyView'); await pause(500);
    assert.equal(await evaluate("document.getElementById('modeExpress').getAttribute('aria-pressed')"),'true');
    assert.equal(await visible('raceView'),false);
    await evaluate('window.fetch=window.originalFetch');
    await click('modeRegular'); await waitVisible('raceView');
    console.log(`${name}: checking reload`);
    await cdp('Page.navigate',{url:base});
    await waitVisible('raceView');
    assert.equal(await evaluate("document.getElementById('modeRegular').getAttribute('aria-pressed')"),'true');
    assert.equal(await evaluate("document.getElementById('foundCount').textContent"),'1');
    console.log(`${name}: checking results`);
    // Finish Regular, then check separate results/crown and mode-aware share URL.
    for(const word of ['ABCDE','ABCDEF','ABCDEFG','ABCDEFGHIJKL']) await api(`/api/races/${regRace}/words`,{playerId:regular.playerId,word});
    await waitVisible('resultsView');
    assert.match(await evaluate("document.getElementById('shareCard').textContent"),/mode=regular/);
    assert.match(await evaluate("document.getElementById('kingBanner').textContent"),/Regular/);
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    writeFileSync(join(dir,`${name}-results.png`),Buffer.from(shot.data,'base64'));
    await click('modeExpress'); await waitVisible('lobbyView');
    assert.equal(await visible('kingBanner'),false);
    // Restore a legacy browser session without a mode key or raceIds map.
    await evaluate(`localStorage.removeItem('mode');localStorage.setItem('roomUsers',JSON.stringify({[${JSON.stringify(room)}]:{nickname:'Anna',playerId:${JSON.stringify(regular.playerId)},raceId:${JSON.stringify(initial.raceIds.express)}}}));`);
    await cdp('Page.navigate',{url:base});
    await waitVisible('lobbyView');
    assert.equal(await evaluate("document.getElementById('modeExpress').getAttribute('aria-pressed')"),'true');
    assert.equal(JSON.parse(await evaluate("localStorage.getItem('roomUsers')"))[room].raceIds.express,initial.raceIds.express);
    await click('modeRegular'); await waitVisible('resultsView');
    await click('reviewPuzzleBtn'); await waitVisible('raceView');
    await evaluate("document.getElementById('board').scrollIntoView({block:'center'})");
    const boardShot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    writeFileSync(join(dir,`${name}-board.png`),Buffer.from(boardShot.data,'base64'));
    await send('Target.disposeBrowserContext',{browserContextId});
    console.log(`${name}: default Express, immediate Regular, pointer drag, resume, stats/crown, stale-response isolation and legacy storage passed`);
  }
  assert.deepEqual(errors,[]);
  console.log(`Browser checks passed. Screenshots: ${dir}`);
} finally {
  ws?.close();
  for(const p of processes.reverse()) {
    if(p.exitCode===null && p.signalCode===null) { const stopped=new Promise(r=>p.once('exit',r));p.kill();await Promise.race([stopped,pause(2000)]); if(p.exitCode===null && p.signalCode===null) {p.kill('SIGKILL');await stopped;} }
  }
  // Keep screenshots for inspection; remove databases and browser profiles.
  for(const name of ['chrome','db.sqlite3','db.sqlite3-wal','db.sqlite3-shm']) rmSync(join(dir,name),{recursive:true,force:true});
}
