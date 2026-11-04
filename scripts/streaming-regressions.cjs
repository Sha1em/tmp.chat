/* Real extension/DOM regressions against offline fixtures, never a signed-in
   profile. A partial answer must arrive while native generation is held open. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function streamingRegressions({ cdp, source, worker, sessions, waitFor, delay }) {
  const panel = `document.getElementById('tmp-chat-root').shadowRoot`;
  const ui = expression => cdp.evaluate(expression, source);
  const tabId = await cdp.evaluate(`chrome.tabs.query({url:'https://chatgpt.com/c/source'}).then(tabs=>tabs[0].id)`, worker);
  const command = (type, extra = {}) => cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:async()=>chrome.runtime.sendMessage(${JSON.stringify({ type: `tmp:${type}`, ...extra })})}).then(results=>results[0].result)`, worker);
  const snapshot = async () => (await command('hello')).state;
  const sourceHtml = await ui(`document.querySelector('[data-message-author-role="assistant"]').innerHTML`);
  const timings = { scope: 'Offline headless Edge; debugger attached; source visible, helper hidden. DOM commit, not physical paint.', browser: await cdp.send('Browser.getVersion'), cases: [] };
  async function begin(question = 'Streaming regression') {
    await cdp.evaluate(`globalThis.__tmpFixtureMode='streaming';chrome.tabs.sendMessage(${tabId},{type:'tmp:toggle'})`, worker);
    await waitFor(() => ui(`!${panel}.querySelector('.card').hidden`), 'stream panel open');
    await ui(`(()=>{const s=${panel};s.querySelector('#question').value=${JSON.stringify(question)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
    const info = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url.includes('fixture=streaming')), 'stream helper');
    const helper = await waitFor(() => sessions.get(info.targetId)?.sessionId, 'stream helper attachment');
    await waitFor(() => cdp.evaluate('!!window.__fixture?.streamReady', helper), 'native stream ready');
    // Headless visibility is asserted instead of assuming every target is visible.
    await cdp.send('Target.activateTarget', { targetId: [...sessions].find(([, value]) => value.sessionId === source)[0] });
    assert.equal(await ui('document.visibilityState'), 'visible');
    assert.equal(await cdp.evaluate('document.visibilityState', helper), 'hidden');
    return { helper, targetId: info.targetId };
  }
  const text = () => ui(`${panel}.querySelector('.message.assistant')?.textContent||''`);
  async function expectText(expected, helper) {
    await waitFor(async () => (await text()) === expected, 'partial response ' + expected.length, 7000);
    assert.equal(await cdp.evaluate('window.__fixture.streamFinished', helper), false, 'Partial text must precede native completion');
    assert.equal((await snapshot()).status, 'streaming');
  }
  async function write(helper, value, kind = 'replace') {
    const start = await cdp.evaluate(`(()=>{const at=performance.timeOrigin+performance.now(),body=document.getElementById('stream-body-'+window.__sends);${kind === 'append' ? `body.firstChild.appendData(${JSON.stringify(value)});` : `body.textContent=${JSON.stringify(value)};`}return at;})()`, helper);
    return start;
  }
  async function finish(test, expected, expectedCode) {
    await cdp.evaluate('window.__finishStream()', test.helper);
    await waitFor(async () => (await snapshot())?.status === 'done', 'stream final reconciliation', 30000);
    assert.equal(await text(), expected);
    if (expectedCode) assert.equal(await ui(`${panel}.querySelector('pre code')?.textContent`), expectedCode);
    assert.equal(await cdp.evaluate('window.__sends', test.helper), 1);
    assert.equal(await ui(`document.querySelector('[data-message-author-role="assistant"]').innerHTML`), sourceHtml);
    await command('discard');
    await waitFor(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === test.targetId), 'stream helper cleanup');
    await ui(`${panel}.querySelector('#discard').click()`);
    await waitFor(() => ui(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`), 'stream panel close');
  }

  // Repeat first text with no search/copy metadata. Deliberately hold generation
  // open so a final snapshot cannot accidentally satisfy this assertion.
  for (let trial = 0; trial < 3; trial++) {
    const test = await begin();
    await cdp.send('Performance.enable', {}, test.helper); await cdp.send('Performance.enable', {}, source);
    const before = await Promise.all([cdp.send('Performance.getMetrics', {}, test.helper), cdp.send('Performance.getMetrics', {}, source)]);
    if (trial === 0) await delay(1000); // A slow native producer; no extension polling needed.
    const at = await write(test.helper, 'First available text.');
    await expectText('First available text.', test.helper);
    const marks = (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>globalThis.__tmpChatDiagnostics.filter(entry=>entry.event==='stream:first-commit').at(-1)})`, worker))[0].result;
    timings.cases.push({ name: 'no-copy-metadata', trial, firstCommitMs: marks.time - at });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-markdown-copy],[data-content-search-unit-key]').length`, test.helper), 0);
    // Plain characterData updates must also stream, and retain the same text
    // node while avoiding composer/icon/history writes on subsequent patches.
    await ui(`(()=>{const s=${panel},bubble=s.querySelector('.message.assistant');window.__streamTextNode=bubble.firstChild;window.__streamChanges={composer:0,icon:0,history:0};window.__streamObservers=[];for(const [key,node,options]of [['composer',s.querySelector('#question'),{attributes:true,attributeFilter:['style']}],['icon',s.querySelector('.send'),{childList:true}],['history',s.querySelector('.message.user'),{childList:true,characterData:true,subtree:true}]]){const observer=new MutationObserver(records=>window.__streamChanges[key]+=records.length);observer.observe(node,options);window.__streamObservers.push(observer);}})()`);
    await write(test.helper, ' More explanation.', 'append');
    await expectText('First available text. More explanation.', test.helper);
    await delay(160);
    await write(test.helper, ' Still generating.', 'append');
    await expectText('First available text. More explanation. Still generating.', test.helper);
    assert.equal(await ui(`${panel}.querySelector('.message.assistant').firstChild===window.__streamTextNode`), true);
    assert.deepEqual(await ui('window.__streamChanges'), { composer: 0, icon: 0, history: 0 });
    await ui('window.__streamObservers.forEach(observer=>observer.disconnect())');
    const after = await Promise.all([cdp.send('Performance.getMetrics', {}, test.helper), cdp.send('Performance.getMetrics', {}, source)]);
    const sumMetric = (samples, key) => samples.reduce((sum, sample) => sum + (sample.metrics.find(metric => metric.name === key)?.value || 0), 0);
    Object.assign(timings.cases.at(-1), { scriptMs: (sumMetric(after, 'ScriptDuration') - sumMetric(before, 'ScriptDuration')) * 1000, taskMs: (sumMetric(after, 'TaskDuration') - sumMetric(before, 'TaskDuration')) * 1000 });
    await finish(test, 'First available text. More explanation. Still generating.');
  }
  console.log('PASS hidden helper: first and character-data partials before native completion, no copy/search metadata, same text node, no composer/history rewrites');

  let test = await begin();
  await cdp.evaluate(`document.getElementById('stream-answer-1').querySelector('h4').setAttribute('data-conversation-role','pending')`, test.helper);
  await write(test.helper, 'Text exists before its role.'); await delay(200);
  assert.equal((await snapshot()).messages[1].text, '');
  await cdp.evaluate(`document.getElementById('stream-answer-1').querySelector('h4').setAttribute('data-conversation-role','assistant')`, test.helper);
  await expectText('Text exists before its role.', test.helper);
  await cdp.evaluate(`document.getElementById('stream-answer-1').setAttribute('data-chatgpt-search-unit-key','late-enrichment')`, test.helper);
  await write(test.helper, ' Enriched.', 'append');
  await expectText('Text exists before its role. Enriched.', test.helper);
  await finish(test, 'Text exists before its role. Enriched.');
  console.log('PASS attribute-only role discovery and late search enrichment');

  test = await begin();
  await write(test.helper, 'Original beginning.'); await expectText('Original beginning.', test.helper);
  await delay(140);
  await cdp.evaluate(`(()=>{const old=document.getElementById('stream-answer-1'),next=old.cloneNode(true);next.querySelector('p').textContent='Rewritten beginning.';old.replaceWith(next);})()`, test.helper);
  await expectText('Rewritten beginning.', test.helper);
  await delay(140);
  await cdp.evaluate(`(()=>{const old=document.querySelector('main'),next=old.cloneNode(true);next.querySelector('#stream-body-1').textContent='After main replacement.';old.replaceWith(next);})()`, test.helper);
  await expectText('After main replacement.', test.helper);
  await write(test.helper, ' Complete.', 'append');
  await expectText('After main replacement. Complete.', test.helper);
  await ui(`${panel}.querySelector('#minimize').click()`);
  await write(test.helper, ' Minimized update.', 'append');
  await expectText('After main replacement. Complete. Minimized update.', test.helper);
  await ui(`${panel}.querySelector('.dock').click()`);
  await waitFor(() => ui(`!${panel}.querySelector('.card').hidden`), 'stream restored after minimize');
  await expectText('After main replacement. Complete. Minimized update.', test.helper);
  await finish(test, 'After main replacement. Complete. Minimized update.');
  console.log('PASS active answer and whole-main replacement rebind immediately; rewritten text replaces rather than duplicates');

  test = await begin();
  const code = 'def example():\n    total = 1\n\n    return total';
  await cdp.evaluate(`(()=>{const body=document.getElementById('stream-body-1'),editor=document.createElement('div');editor.id='stream-code';for(const text of ${JSON.stringify(code.split('\n'))}){const line=document.createElement('div');line.className='cm-line';if(text)line.textContent=text;else line.append(document.createElement('br'));editor.append(line);}body.replaceWith(editor);})()`, test.helper);
  await waitFor(async () => (await snapshot()).messages[1].text.length > 0, 'text before code-editor class');
  await cdp.evaluate(`document.getElementById('stream-code').className='cm-editor'`, test.helper);
  await expectText(code, test.helper);
  await finish(test, code, code);
  console.log('PASS code indentation, empty lines and exact final reconciliation');

  // A duplicated/missing worker-to-panel patch repairs from the existing worker
  // snapshot. The helper still receives one and only one native question.
  test = await begin();
  await write(test.helper, 'A'); await expectText('A', test.helper);
  const older = await snapshot();
  await delay(140);
  await cdp.evaluate(`(()=>{const send=chrome.tabs.sendMessage.bind(chrome.tabs);globalThis.__streamRestoreSend=send;globalThis.__streamDropOnce=true;chrome.tabs.sendMessage=(id,message)=>{if(message.type==='tmp:patch'&&globalThis.__streamDropOnce){globalThis.__streamDropOnce=false;return Promise.resolve({ok:true});}return send(id,message);};})()`, worker);
  await write(test.helper, 'AB');
  await waitFor(async () => (await snapshot()).messages[1].text === 'AB', 'worker receives dropped patch');
  await delay(150); assert.equal(await text(), 'A');
  await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);globalThis.__streamRestoreRuntime=send;let once=true;chrome.runtime.sendMessage=async message=>{const result=await send(message);if(once&&message.type==='tmp:hello'){once=false;await new Promise(resolve=>{globalThis.__streamReleaseHello=resolve;});}return result;};}})`, worker);
  await write(test.helper, 'ABC');
  await waitFor(async () => (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>typeof globalThis.__streamReleaseHello==='function'})`, worker))[0].result, 'older output snapshot held in flight');
  await delay(150); await write(test.helper, 'ABCD');
  await waitFor(async () => (await snapshot()).messages[1].text === 'ABCD', 'another delta during snapshot recovery');
  await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{globalThis.__streamReleaseHello();delete globalThis.__streamReleaseHello;}})`, worker);
  await expectText('ABCD', test.helper);
  await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{chrome.runtime.sendMessage=globalThis.__streamRestoreRuntime;delete globalThis.__streamRestoreRuntime;}})`, worker);
  await cdp.evaluate('chrome.tabs.sendMessage=globalThis.__streamRestoreSend;delete globalThis.__streamRestoreSend', worker);
  await cdp.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'tmp:state',state:${JSON.stringify(older)}})`, worker);
  await delay(100); assert.equal(await text(), 'ABCD', 'A delayed older full snapshot cannot roll back newer text');
  await finish(test, 'ABCD');
  console.log('PASS missing panel delta resynchronizes existing output without repeating a native submission');

  test = await begin();
  await write(test.helper, 'Before freezing.'); await expectText('Before freezing.', test.helper);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, test.helper);
  await delay(200); assert.equal(await text(), 'Before freezing.');
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }, test.helper);
  await write(test.helper, ' After resuming.', 'append'); await expectText('Before freezing. After resuming.', test.helper);
  await finish(test, 'Before freezing. After resuming.');
  console.log('PASS helper freeze/resume reconciles without synthetic keepalive activity');
  await cdp.evaluate(`globalThis.__tmpFixtureMode=''`, worker);
  fs.writeFileSync(path.resolve(__dirname, '../.test-artifacts/streaming-timings.json'), JSON.stringify(timings, null, 2) + '\n');
};
