/* Browser tests using only Node's built-in CDP client. No npm install required.
   All ChatGPT requests are intercepted and fulfilled with local fixtures. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fixture = require('../tests/fixture.cjs');
const root = path.resolve(__dirname,'..');
const artifacts = path.join(root,'.test-artifacts');fs.mkdirSync(artifacts,{recursive:true});
const profile = fs.mkdtempSync(path.join(artifacts,'edge-profile-'));
const candidates = [process.env.TMP_CHAT_BROWSER,'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
const executable = candidates.find(p=>fs.existsSync(p));
if(!executable) throw Error('Set TMP_CHAT_BROWSER to a Chromium/Edge executable.');
class CDP {
  constructor(ws) {this.ws=ws;this.id=0;this.pending=new Map();this.listeners=new Set();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(process.argv.includes('--debug'))console.error('CDP recv',m.id||'',m.method||'',m.sessionId||'',m.error?.message||'');if(m.id){const pending=this.pending.get(m.id);if(pending){this.pending.delete(m.id);clearTimeout(pending.timer);m.error?pending.reject(Error(JSON.stringify(m.error))):pending.resolve(m.result);}}else for(const listener of this.listeners)listener(m);});}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timed out: '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async evaluate(expression,sessionId){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100);}throw Error('Timed out: '+label);}
let browser, cdp;
const sessions=new Map();
const errors=[];
const debug=process.argv.includes('--debug');
(async()=>{
  browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-signin','--disable-features=msImplicitSignin,msEdgeSync,msEdgeSidebarV2','--remote-debugging-port=0','--user-data-dir='+profile,'--disable-extensions-except='+root,'--load-extension='+root,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  browser.on('error',error=>errors.push(error.message));browser.stderr.on('data',()=>{});
  const portFile=path.join(profile,'DevToolsActivePort');
  await waitFor(()=>fs.existsSync(portFile),'browser startup');
  const [port,endpoint]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
  const ws=new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});cdp=new CDP(ws);
  cdp.listeners.add(async event=>{
    try {
      if(event.method==='Target.attachedToTarget'){
        const {sessionId,targetInfo}=event.params;
        if(debug)console.error('Attach',targetInfo.type,targetInfo.url,sessionId);
        if(targetInfo.type==='page'){
          await cdp.send('Fetch.enable',{patterns:[{urlPattern:'https://*/*',requestStage:'Request'}]},sessionId);
          if(debug)console.error('Intercepting',targetInfo.type);
        }
        if(targetInfo.type==='page')await cdp.send('Runtime.enable',{},sessionId);
        await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId);
        await cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId);
        if(debug)console.error('Resumed',targetInfo.type);
        sessions.set(targetInfo.targetId,{sessionId,targetInfo});
      }
      if(event.method==='Fetch.requestPaused'){
        const {requestId,request}=event.params;const url=new URL(request.url);
        if(debug)console.error('Intercepted',url.origin+url.pathname+url.search,event.params.resourceType);
        const isDocument=event.params.resourceType==='Document';
        let body=url.hostname==='chatgpt.com'&&isDocument?fixture(url.searchParams.get('temporary-chat')==='true',url.searchParams.get('fixture')||''):'';
        if (process.argv.includes('--startup-only') && body && url.searchParams.get('temporary-chat')==='true') body=body.replace('</body>', '<img src="/tmp-chat-startup-hold" hidden></body>');
        if (url.pathname==='/tmp-chat-startup-hold') await delay(2000);
        await cdp.send('Fetch.fulfillRequest',{requestId,responseCode:body?200:204,responseHeaders:[{name:'Content-Type',value:body?'text/html; charset=utf-8':'text/plain'}],body:Buffer.from(body).toString('base64')},event.sessionId);
      }
      if(event.method==='Runtime.exceptionThrown')errors.push(event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text);
    }catch(error){if(!/closed|not found|No session/.test(error.message)){errors.push(error.message);if(debug)console.error(error.message);}}
  });
  await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const source=await waitFor(()=>sessions.get(targetId)?.sessionId,'source session');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false},source);
  await cdp.send('Page.enable',{},source);await cdp.send('Page.navigate',{url:'https://chatgpt.com/c/source'},source);
  await waitFor(()=>cdp.evaluate('!!document.getElementById("tmp-chat-root")',source),'extension content script');
  const worker=await waitFor(()=>[...sessions.values()].find(s=>s.targetInfo.type==='service_worker'&&s.targetInfo.url.endsWith('/background.js'))?.sessionId,'extension worker');
  assert.equal(await cdp.evaluate('chrome.runtime.getManifest().name',worker),'tmp.chat');
  // Fixture-only hook: make a blank tab first, giving CDP time to install
  // interception before its first network navigation. The production extension
  // still calls the real Tabs API and all its other code runs unchanged.
  await cdp.evaluate(`(()=>{const create=chrome.tabs.create.bind(chrome.tabs);chrome.tabs.create=async props=>{const tab=await create({...props,url:'about:blank'});await new Promise(resolve=>setTimeout(resolve,1000));const url=new URL(props.url);if(globalThis.__tmpFixtureMode)url.searchParams.set('fixture',globalThis.__tmpFixtureMode);return chrome.tabs.update(tab.id,{url:url.href});};return true;})()`,worker);
  if (process.argv.includes('--startup-only')) {
    await require('./startup-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
    assert.deepEqual(errors.filter(e => !e.includes('net::ERR')), []); return;
  }
  if (process.argv.includes('--helper-only')) {
    await require('./helper-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
    assert.deepEqual(errors.filter(e => !e.includes('net::ERR')), []); return;
  }
  if (process.argv.includes('--submission-only')) {
    await require('./submission-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
    assert.deepEqual(errors.filter(e => !e.includes('net::ERR')), []); return;
  }
  await require('./submission-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
  await require('./streaming-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
  if (process.argv.includes('--streaming-only')) { assert.deepEqual(errors.filter(e => !e.includes('net::ERR')), []); return; }
  await require('./ui-regressions.cjs')({ cdp, source, worker, waitFor, delay });
  await require('./layout-regressions.cjs')({ cdp, source, worker, waitFor, delay });
  await require('./helper-regressions.cjs')({ cdp, source, worker, sessions, waitFor, delay });
  console.log('PASS extension loads in Edge with an offline ChatGPT fixture');
  const baselinePages=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length;
  const inspect=()=>cdp.evaluate(`(()=>{const h=document.getElementById('tmp-chat-root');const s=h.shadowRoot;const panel=h.getBoundingClientRect();const text=document.querySelector('[data-message-author-role="assistant"] .markdown').getBoundingClientRect();return {visible:getComputedStyle(h).display!=='none',panelLeft:panel.left,panelRight:panel.right,textRight:text.right,compact:!s.querySelector('.dock').hidden,messages:s.querySelectorAll('.message').length,status:s.querySelector('.status').textContent,error:s.querySelector('#error span').textContent,errorVisible:!s.querySelector('#error').hidden,bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};})()`,source);
  await cdp.evaluate(`(()=>{const p=document.getElementById('select-me');const range=document.createRange();range.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`,source);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-selection-root").shadowRoot.querySelector("button").hidden',source),'selection action');
  assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length,baselinePages,'Highlighting alone must not create a helper');
  await cdp.evaluate('document.getElementById("tmp-chat-selection-root").shadowRoot.querySelector("button").click()',source);
  await waitFor(async()=>{const data=await inspect();return data.visible;},'panel opening');
  let data=await inspect();assert.ok(data.textRight<data.panelLeft-8,JSON.stringify(data));assert.ok(data.bodyWidth<=data.viewport,JSON.stringify(data));
  const targetsBefore=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length;
  assert.ok(targetsBefore>=baselinePages && targetsBefore<=baselinePages+1,'Opening may prepare exactly one helper');
  await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},source).then(r=>fs.writeFileSync(path.join(artifacts,'panel-ready.png'),Buffer.from(r.data,'base64')));
  console.log('PASS highlighting stays lazy; selection action opens a non-overlapping panel with at most one prepared helper');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;const box=s.querySelector('#question');box.value='Explain this simply.';box.dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();s.querySelector('form').requestSubmit();})()`,source);
  await waitFor(async()=>{const d=await inspect();if(d.errorVisible)throw Error(d.error);return d.status==='Temporary · your ChatGPT'&&d.messages===2;},'first streamed answer',35000);
  const helperTarget=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.includes('temporary-chat=true'));
  const helperInfo=await waitFor(()=>sessions.get(helperTarget?.targetId),'helper session');
  const helper=helperInfo.sessionId;
  assert.equal(await cdp.evaluate('window.__sends',helper),1,'Double form submission must send once');
  assert.ok(await cdp.evaluate('window.__prompts[0].includes("Each token creates a query")',helper));
  assert.equal(await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelectorAll("a[href^=javascript]").length',source),0);
  console.log('PASS real extension worker → tab → composer → streamed answer; duplicate send blocked');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#question').value='Give an example.';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`,source);
  await waitFor(async()=>{const d=await inspect();if(d.errorVisible)throw Error(d.error);return d.status==='Temporary · your ChatGPT'&&d.messages===4;},'follow-up answer',35000);
  assert.equal(await cdp.evaluate('window.__sends',helper),2);assert.equal(await cdp.evaluate('window.__prompts[1]',helper),'Give an example.');
  const helpers=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&t.url.includes('temporary-chat=true'));assert.equal(helpers.length,1);
  console.log('PASS follow-up reuses one helper and does not resend source context');
  for(const width of [1440,1280,980,760]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},source);await delay(300);data=await inspect();if(!data.compact)assert.ok(data.textRight<data.panelLeft-8,JSON.stringify({width,...data}));assert.ok(data.bodyWidth<=data.viewport,JSON.stringify(data));if(width<=980)assert.equal(data.compact,true);
  }
  console.log('PASS 1672 / 1440 / 1280 / 980 / 760 px layouts, including compact mode');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:940,deviceScaleFactor:1,mobile:false},source);await delay(200);
  await cdp.evaluate('document.documentElement.classList.add("dark")',source);await delay(100);
  await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},source).then(r=>fs.writeFileSync(path.join(artifacts,'panel-dark.png'),Buffer.from(r.data,'base64')));
  await cdp.evaluate(`document.getElementById('tmp-chat-root').shadowRoot.querySelector('#minimize').click()`,source);
  assert.equal(await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector(".card").hidden',source),true);
  await cdp.evaluate(`document.getElementById('tmp-chat-root').shadowRoot.querySelector('.dock').click()`,source);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-root").shadowRoot.querySelector(".card").hidden',source),'dock restoration');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#discard').click();s.querySelector('#confirm-discard').click();})()`,source);
  await waitFor(async()=>!(await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===helperInfo.targetInfo.targetId),'helper cleanup');
  await waitFor(async()=>!(await inspect()).visible,'panel cleanup after helper closure');
  console.log('PASS dark mode, minimize/restore, discard, and helper-tab cleanup');
  await cdp.evaluate(`globalThis.__tmpFixtureMode='unverified'`,worker);
  await cdp.evaluate(`(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('select-me'));const s=getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`,source);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-selection-root").shadowRoot.querySelector("button").hidden',source),'second selection');
  await cdp.evaluate('document.getElementById("tmp-chat-selection-root").shadowRoot.querySelector("button").click()',source);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-root").shadowRoot.querySelector("#question").disabled',source),'second tangent');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#question').value='Do not send before temporary mode is verified.';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`,source);
  await waitFor(async()=>{const d=await inspect();return d.errorVisible&&d.error.includes('Temporary Chat could not be verified');},'temporary mode protection');
  const guardedInfo=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.includes('fixture=unverified'));
  const guarded=await waitFor(()=>sessions.get(guardedInfo?.targetId)?.sessionId,'guarded helper');
  assert.equal(await cdp.evaluate('window.__sends',guarded),0);assert.equal(await cdp.evaluate('document.getElementById("prompt-textarea").innerText',guarded),'');
  console.log('PASS no context is inserted or sent when Temporary Chat cannot be verified');
  await cdp.evaluate(`(()=>{const h=document.querySelector('h1');h.textContent='Temporary Chat';h.dataset.testid='temporary-chat-header';})()`,guarded);
  await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector("#check").click()',source);
  await waitFor(async()=>{const d=await inspect();return d.status==='ChatGPT is answering…';},'safe pre-send retry');
  await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector("form").requestSubmit()',source);
  await waitFor(async()=>{const d=await inspect();return d.status==='Temporary · your ChatGPT';},'stopping answer');
  assert.equal(await cdp.evaluate('window.__sends',guarded),1);
  console.log('PASS confirmed pre-send setup can resume safely; Stop stops generation');
  // Stub only the isolated fixture clipboard; never overwrite the user's clipboard.
  const sourceTabId = await cdp.evaluate(`(async()=> (await chrome.tabs.query({url:'https://chatgpt.com/c/source'}))[0].id)()`, worker);
  await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${sourceTabId}},func:()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.__tmpFixtureCopied=text;}}});}})`, worker);
  await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector("#copy").click()', source);
  await waitFor(()=>cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector(".toast").textContent==="Conversation copied."',source),'copy control feedback');
  const copied = (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${sourceTabId}},func:()=>globalThis.__tmpFixtureCopied})`, worker))[0].result;
  assert.match(copied, /Do not send before temporary mode is verified/);
  assert.ok(!copied.includes('Each token creates a query'), 'Copy must omit the hidden context prompt');
  console.log('PASS Copy handler, completion feedback, and context-free transcript (fixture clipboard stub)');
  await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector("#keep").click()',source);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-root").shadowRoot.querySelector(".context-label").textContent',source),'handoff cleanup');
  assert.ok((await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===guardedInfo.targetId));
  assert.equal(await cdp.evaluate('document.querySelectorAll("[data-message-author-role=user]").length',source),1);
  assert.equal(await cdp.evaluate('document.querySelectorAll("[data-message-author-role=assistant]").length',source),1);
  console.log('PASS Keep retains the helper and clears session; original conversation remains unchanged');
  await cdp.evaluate(`globalThis.__tmpFixtureMode=''`, worker);
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#pasted-context').value='Manually supplied context passage.';s.querySelector('#question').value='A question without automatic selection.';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();s.querySelector('form').requestSubmit();})()`,source);
  await waitFor(async()=>{const d=await inspect();if(d.errorVisible)throw Error(d.error);return d.status==='Temporary · your ChatGPT'&&d.messages===2;},'manual fallback answer',35000);
  const manualInfo = (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.includes('temporary-chat=true')&&t.targetId!==guardedInfo.targetId);
  const manualHelper = await waitFor(()=>sessions.get(manualInfo?.targetId)?.sessionId,'manual helper');
  assert.equal(await cdp.evaluate('window.__sends',manualHelper),1);
  const manualPrompt = await cdp.evaluate('window.__prompts[0]',manualHelper);
  assert.ok(manualPrompt.includes('Manually supplied context passage.'));
  assert.ok(manualPrompt.includes('A question without automatic selection.'));
  assert.ok(!manualPrompt.includes('Each token creates a query'));

  const secondTarget = await cdp.send('Target.createTarget',{url:'about:blank'});
  const second = await waitFor(()=>sessions.get(secondTarget.targetId)?.sessionId,'second source session');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false},second);
  await cdp.send('Page.navigate',{url:'https://chatgpt.com/c/second'},second);
  await waitFor(()=>cdp.evaluate('!!document.getElementById("tmp-chat-root")',second),'second content script');
  const secondTabId = await cdp.evaluate(`(async()=> (await chrome.tabs.query({url:'https://chatgpt.com/c/second'}))[0].id)()`,worker);
  await cdp.evaluate(`chrome.tabs.sendMessage(${secondTabId},{type:'tmp:toggle'})`,worker);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-root").shadowRoot.querySelector(".card").hidden',second),'occupied panel opening');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#question').value='Preserve this manual draft.';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('#minimize').click();})()`,second);
  assert.equal(await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector(".send").disabled',second),true);
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#discard').click();s.querySelector('#confirm-discard').click();})()`,source);
  await waitFor(async()=>!(await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===manualInfo.targetId),'manual helper cleanup');
  await cdp.evaluate(`chrome.tabs.sendMessage(${secondTabId},{type:'tmp:toggle'})`,worker);
  await waitFor(()=>cdp.evaluate('!document.getElementById("tmp-chat-root").shadowRoot.querySelector(".send").disabled',second),'occupied state refresh');
  assert.equal(await cdp.evaluate('document.getElementById("tmp-chat-root").shadowRoot.querySelector("#question").value',second),'Preserve this manual draft.');
  await cdp.evaluate(`(()=>{const s=document.getElementById('tmp-chat-root').shadowRoot;s.querySelector('#discard').click();s.querySelector('#confirm-discard').click();})()`,second);
  await waitFor(()=>cdp.evaluate('getComputedStyle(document.getElementById("tmp-chat-root")).display==="none"',second),'manual draft close');
  await cdp.send('Target.closeTarget',{targetId:secondTarget.targetId});
  console.log('PASS manual context → helper → answer, duplicate protection, and cross-tab ownership refresh with draft preservation');
  assert.deepEqual(errors.filter(e=>!e.includes('net::ERR')),[]);
  console.log('Browser smoke checks passed. Screenshots: .test-artifacts/panel-ready.png and panel-dark.png');
})().catch(async error=>{
  console.error(error.stack||error);process.exitCode=1;
  if(cdp){
    try{
      const targets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page');
      for(const info of targets){
        const sid=sessions.get(info.targetId)?.sessionId;
        if(!info.url.startsWith('https://chatgpt.com/'))continue;
        console.error('Chat fixture diagnostic: attached:',!!sid);
        if(sid)console.error(await cdp.evaluate('JSON.stringify({ready:document.readyState,composer:!!document.getElementById("prompt-textarea"),html:document.documentElement.outerHTML.slice(0,250)})',sid));
      }
    }catch{}
  }
}).finally(async()=>{
  if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.ws.close();}
  if(browser&&!browser.killed)browser.kill();
  await delay(500);
  // Only remove the isolated test profile we created inside the workspace.
  const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(artifacts)+path.sep)&&path.basename(resolved).startsWith('edge-profile-')){
    try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:300});}catch{}
  }
});
