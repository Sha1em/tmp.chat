/* Controlled cold-start measurements. All native output is a local fixture. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ cdp, source, worker, sessions, waitFor, delay }) => {
  const panel = `document.getElementById('tmp-chat-root').shadowRoot`;
  const sourceTab = await cdp.evaluate(`(async()=>(await chrome.tabs.query({url:'https://chatgpt.com/c/source'}))[0].id)()`, worker);
  const command = (type, extra = {}) => cdp.evaluate(`(async()=> (await chrome.scripting.executeScript({target:{tabId:${sourceTab}},func:async message=>chrome.runtime.sendMessage(message),args:[${JSON.stringify({type:'tmp:'+type,...extra})}]}))[0].result)()`, worker);
  const trials = [], marks = [];
  const version=await cdp.evaluate('chrome.runtime.getManifest().version',worker);
  const listener = event => {
    if (event.method!=='Runtime.consoleAPICalled') return;
    const args=event.params.args.map(arg=>arg.value);
    if (args[0]==='[tmp.chat worker]' || args[0]==='[tmp.chat agent]') marks.push({at:event.params.timestamp,event:args[1],details:args[2]});
  };
  cdp.listeners.add(listener);
  try {
    await cdp.evaluate(`globalThis.__tmpFixtureMode='streaming'`,worker);
    for (const typingMs of [0, 0, 2500, 2500]) {
      const pagesBefore=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').map(t=>t.targetId);
      const openAt=Date.now();
      await cdp.evaluate(`chrome.tabs.sendMessage(${sourceTab},{type:'tmp:toggle'})`,worker);
      await waitFor(()=>cdp.evaluate(`!${panel}.querySelector('.card').hidden`,source),'startup panel');
      await delay(typingMs);
      // Preloading must not insert any prompt or question before Send.
      let helperTarget=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!pagesBefore.includes(t.targetId)&&t.url.includes('temporary-chat=true'));
      if (helperTarget) {
        const helper=await waitFor(()=>sessions.get(helperTarget.targetId)?.sessionId,'prepared helper');
        assert.equal(await cdp.evaluate(`window.__sends||0`,helper),0);
        assert.equal(await cdp.evaluate(`document.querySelector('[data-fixture-editor]')?.textContent||''`,helper),'');
      }
      const sendAt=Date.now();
      await cdp.evaluate(`(()=>{const s=${panel};s.querySelector('#question').value='Startup measurement';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`,source);
      helperTarget=await waitFor(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!pagesBefore.includes(t.targetId)&&t.url.includes('temporary-chat=true')),'measurement helper');
      const helper=await waitFor(()=>sessions.get(helperTarget.targetId)?.sessionId,'measurement session');
      await waitFor(()=>cdp.evaluate(`window.__fixture?.streamReady`,helper),'native submission');
      const submittedAt=await cdp.evaluate('window.__fixture.nativeSentAt',helper);
      await delay(100);
      const text='First text\n\n    code preserves whitespace';
      const firstTextAt=await cdp.evaluate(`(()=>{window.__fixture.firstTextAt=Date.now();const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=${JSON.stringify(text)};pre.append(code);document.getElementById('stream-body-1').replaceChildren(pre);return window.__fixture.firstTextAt;})()`,helper);
      await waitFor(()=>cdp.evaluate(`${panel}.querySelector('.message.assistant')?.textContent.includes('First text')`,source),'first panel text');
      const commit=await cdp.evaluate(`(async()=>(await chrome.scripting.executeScript({target:{tabId:${sourceTab}},func:()=>globalThis.__tmpChatDiagnostics.findLast(x=>x.event==='stream:first-commit')}))[0].result)()`,worker);
      const documentState=await cdp.evaluate('document.readyState',helper);
      await cdp.evaluate('window.__finishStream()',helper);
      await waitFor(async()=> (await command('hello')).state?.status==='done','startup completion');
      assert.equal(await cdp.evaluate('window.__sends',helper),1);
      assert.equal((await command('hello')).state.messages[1].text,text);
      trials.push({typingMs,openToSubmitMs:submittedAt-openAt,sendToSubmitMs:submittedAt-sendAt,submitToFirstTextMs:firstTextAt-submittedAt,textToPanelMs:commit.time-firstTextAt,sendToPanelMs:commit.time-sendAt,documentStateAtFirstText:documentState});
      await cdp.evaluate(`(()=>{const s=${panel};s.querySelector('#discard').click();s.querySelector('#confirm-discard').click();})()`,source);
      await waitFor(()=>cdp.evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`,source),'measurement cleanup');
    }
    if (version !== '0.1.6') {
      const previousTargets=(await cdp.send('Target.getTargets')).targetInfos.map(t=>t.targetId);
      await cdp.evaluate(`chrome.tabs.sendMessage(${sourceTab},{type:'tmp:toggle'})`,worker);
      await waitFor(async()=> (await command('hello')).state?.hasHelper,'unused prepared helper');
      const helperTarget=await waitFor(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!previousTargets.includes(t.targetId)&&t.url.includes('temporary-chat=true')),'expiry helper');
      const helper=await waitFor(()=>sessions.get(helperTarget.targetId)?.sessionId,'expiry attachment');
      await waitFor(()=>cdp.evaluate(`(async()=> (await chrome.scripting.executeScript({target:{tabId:session.helperTabId},func:()=>!globalThis.__tmpChatAgentDiagnostics?.length?false:globalThis.__tmpChatAgentDiagnostics.some(x=>x.event==='startup:native-ready')}))[0].result)()`,worker),'native empty readiness');
      await cdp.evaluate(`(()=>{const s=${panel};s.querySelector('#question').value='Preserve this local question';s.querySelector('#pasted-context').value='Preserve this local context';s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('#minimize').click();})()`,source);
      await cdp.evaluate(`session.warmExpiresAt=Date.now()-1;chrome.alarms.create('tmp:prewarm',{when:Date.now()+100})`,worker);
      await waitFor(async()=> !(await command('hello')).state?.hasHelper,'empty helper expiry');
      assert.equal(await cdp.evaluate(`${panel}.querySelector('#question').value`,source),'Preserve this local question');
      assert.equal(await cdp.evaluate(`${panel}.querySelector('#pasted-context').value`,source),'Preserve this local context');
      assert.equal(await cdp.evaluate(`${panel}.querySelector('.card').hidden`,source),true);
      await waitFor(async()=> !(await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===helperTarget.targetId),'expired tab removed');
      await cdp.evaluate(`${panel}.querySelector('.dock').click()`,source);
      await waitFor(()=>cdp.evaluate(`!${panel}.querySelector('.card').hidden`,source),'expiry draft restore');
      assert.equal(await cdp.evaluate(`${panel}.querySelector('#question').value`,source),'Preserve this local question');
      await cdp.evaluate(`(()=>{const s=${panel};s.querySelector('#discard').click();s.querySelector('#confirm-discard').click();})()`,source);
      await waitFor(async()=> !(await command('hello')).state,'expiry draft cleanup');
      console.log('PASS real one-shot expiry preserves local question/context and minimized pill; restoring and immediate discard clean up');
    }
  } finally { cdp.listeners.delete(listener); }
  const output=path.join(__dirname,'..','.test-artifacts',`startup-${version}.json`);
  fs.writeFileSync(output,JSON.stringify({version,scope:'Offline headless Edge with debugger; 2s held image, 1s fixture interception setup, 100ms synthetic response wait; not live ChatGPT latency',trials,marks},null,2));
  console.log('PASS startup preparation, exact first text and single native submission', JSON.stringify(trials));
};
