/* Helper initialization regressions. All pages are the browser harness's local
   fixtures; these checks do not establish signed-in ChatGPT compatibility. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function helperRegressions({ cdp, source, worker, sessions, waitFor, delay }) {
  const panel = `document.getElementById('tmp-chat-root').shadowRoot`;
  const evaluate = expression => cdp.evaluate(expression, source);
  const tabId = await cdp.evaluate(`(async()=> (await chrome.tabs.query({url:'https://chatgpt.com/c/source'}))[0].id)()`, worker);
  const hello = async () => (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:async()=>chrome.runtime.sendMessage({type:'tmp:hello'})})`, worker))[0].result;
  const state = async () => (await hello()).state;
  const command = type => cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:async()=>chrome.runtime.sendMessage({type:${JSON.stringify(`tmp:${type}`)}})})`, worker);
  const helperFor = async mode => {
    const target = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(info => {
      if (info.type !== 'page' || !info.url.startsWith('https://chatgpt.com/')) return false;
      return new URL(info.url).searchParams.get('fixture') === mode;
    }), `helper fixture ${mode}`);
    const sessionId = await waitFor(() => sessions.get(target.targetId)?.sessionId, `helper session ${mode}`);
    return { targetId: target.targetId, sessionId };
  };
  async function submit(mode, question = 'A manually entered fixture question.') {
    assert.equal(await state(), null, 'Each helper regression starts without a tangent');
    await cdp.evaluate(`globalThis.__tmpFixtureMode=${JSON.stringify(mode)}`, worker);
    await cdp.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'tmp:toggle'})`, worker);
    await waitFor(() => evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display!=='none' && !${panel}.querySelector('.card').hidden`), 'manual helper-test panel');
    await evaluate(`(()=>{const s=${panel};s.querySelector('#pasted-context').value='Offline context for this helper regression.';s.querySelector('#question').value=${JSON.stringify(question)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
    return helperFor(mode);
  }
  async function discard(helper) {
    const result = (await command('discard'))[0].result; assert.equal(result.ok, true);
    await waitFor(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(info => info.targetId === helper.targetId), 'helper regression cleanup');
    assert.equal(await state(), null);
    // Discard through the worker releases the tangent. Close the now-empty UI
    // so the next test opens it using the normal toolbar toggle path.
    await evaluate(`${panel}.querySelector('#discard').click()`);
    await waitFor(() => evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`), 'helper-test panel cleanup');
    await cdp.evaluate(`globalThis.__tmpFixtureMode=''`, worker);
  }

  // Preferences must preserve the draft while deliberate opening prepares
  // at most one helper. They never submit the question or change native speed.
  assert.equal(await state(), null);
  const pagesBeforePreference = (await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').length;
  await cdp.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'tmp:toggle'})`, worker);
  await waitFor(() => evaluate(`!${panel}.querySelector('.card').hidden`), 'speed preference draft panel');
  await evaluate(`(()=>{const s=${panel};s.querySelector('#question').value='Keep this unsent question.';s.querySelector('#pasted-context').value='Keep this optional pasted context.';s.querySelector('#question').dispatchEvent(new Event('input'));})()`);
  for (const speed of ['instant', 'current']) {
    await evaluate(`(()=>{const select=${panel}.querySelector('#speed-preference');select.value=${JSON.stringify(speed)};select.dispatchEvent(new Event('change'));})()`);
    await waitFor(async () => (await hello()).preferences?.speed === speed && await evaluate(`!${panel}.querySelector('#speed-preference').disabled`), `save ${speed} preference without a session`);
    assert.deepEqual(await evaluate(`(()=>{const s=${panel};return {question:s.querySelector('#question').value,context:s.querySelector('#pasted-context').value};})()`), { question: 'Keep this unsent question.', context: 'Keep this optional pasted context.' });
    assert.equal((await state()).messages.length, 0);
  }
  assert.ok((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').length <= pagesBeforePreference + 1);
  await evaluate(`${panel}.querySelector('#discard').click();${panel}.querySelector('#confirm-discard').click()`);
  await waitFor(() => evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`), 'close preference draft panel');
  await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').length === pagesBeforePreference, 'prepared preference helper cleanup');
  console.log('PASS pre-submit speed preferences preserve question/context and reuse the one prepared helper');

  // The document has finished loading, but the SPA has not mounted its editor.
  // The adapter must acknowledge its listener before that editor exists.
  let helper = await submit('loading-manual');
  let snapshot = await waitFor(async () => { const value = await state(); return value?.stage === 'composer_ready' ? value : false; }, 'adapter ready before SPA composer');
  assert.equal(snapshot.status, 'starting'); assert.equal(snapshot.errorCode, '');
  assert.equal(snapshot.probe.composerCount, 0); assert.equal(snapshot.probe.hasComposer, false);
  assert.deepEqual(await cdp.evaluate(`({mounts:window.__fixture.mounts,clicks:window.__fixture.sendButtonClicks,sends:window.__sends})`, helper.sessionId), { mounts: 0, clicks: 0, sends: 0 });
  await cdp.evaluate('window.__mountComposer()', helper.sessionId);
  snapshot = await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`Delayed-composer fixture failed: ${value.errorCode} at ${value.stage}`); return value?.status === 'done' ? value : false; }, 'delayed modern composer answer', 30000);
  assert.ok(snapshot.messages[1].text.length > 20, 'The helper answer must reach the source panel');
  assert.deepEqual(await cdp.evaluate(`({sends:window.__sends,clicks:window.__fixture.sendButtonClicks,hiddenDraft:document.getElementById('prompt-textarea').value,editors:document.querySelectorAll('[data-fixture-editor]').length})`, helper.sessionId), { sends: 1, clicks: 1, hiddenDraft: '', editors: 1 });
  assert.match(await cdp.evaluate(`${panel}.querySelector('.message.assistant').textContent`, source), /Think of a query/);
  console.log('PASS helper listener handshake before delayed SPA composer; hidden textarea ignored; visible ProseMirror sends and streams');
  await discard(helper);

  // Match the live-observed DIL response structure instead of the historical
  // role/article/markdown fixture. Each turn wraps user and assistant together.
  helper = await submit('dil');
  await waitFor(async () => (await state())?.status === 'streaming', 'initial answer before native canonicalization');
  assert.equal(await cdp.evaluate(`(()=>{const header=document.querySelector('main header'),save=document.createElement('button');save.setAttribute('aria-label','Save chat');save.textContent='Save chat';header.replaceChildren(save);history.replaceState(null,'','/c/fixture-canonical-route?fixture=dil&temporary-chat=true#tmp-chat-helper');return !!document.querySelector('button[aria-label="Stop generating"]');})()`, helper.sessionId), true, 'Native URL canonicalizes while the owned first answer is active');
  snapshot = await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`DIL helper fixture failed: ${value.errorCode} at ${value.stage}`); return value?.status === 'done' ? value : false; }, 'DIL first answer reaches the panel', 30000);
  assert.ok(snapshot.messages[1].text.includes('Think of a query'), 'DIL answer detection must mirror actual response text');
  assert.equal(snapshot.messages[1].text.includes('You said:'), false, 'A shared turn must not become the assistant response');
  assert.equal(snapshot.messages[1].text.includes('Offline context for this helper regression.'), false, 'The assistant response must exclude the user bubble');
  assert.deepEqual(await cdp.evaluate(`({legacy:document.querySelectorAll('[data-message-author-role],article,.markdown,.prose,[data-testid]').length,turns:document.querySelectorAll('[data-talvt-turn-state]').length,roles:document.querySelectorAll('h4[data-conversation-role]').length,dil:document.querySelectorAll('[data-dil-message-id]').length,sendLabel:document.getElementById('fixture-send').getAttribute('aria-label'),editorLabel:document.querySelector('[data-fixture-editor]').getAttribute('aria-label'),sends:window.__sends})`, helper.sessionId), { legacy: 0, turns: 1, roles: 2, dil: 1, sendLabel: 'Send', editorLabel: 'Ask ChatGPT', sends: 1 });
  assert.match(await cdp.evaluate('window.__prompts[0]', helper.sessionId), /Offline context for this helper regression\./);
  const followup = 'A follow-up in the existing DIL conversation.';
  await evaluate(`window.__completedBubble=${panel}.querySelector('.message.assistant')`);
  // Native rendering metadata can be enriched after the completed snapshot.
  // Replace both role wrappers and temporarily omit conversation-ID metadata,
  // so a fixed fixture conversation ID cannot mask the changed identity priority.
  assert.deepEqual(await cdp.evaluate(`(()=>{const answer=document.querySelector('h4[data-conversation-role="assistant"]').parentElement;const message=answer.querySelector('[data-chatgpt-selection-message-id]');const previous=answer.getAttribute('data-chatgpt-search-message-ids');answer.setAttribute('data-message-id',message.getAttribute('data-chatgpt-selection-message-id'));for(const node of document.querySelectorAll('[data-chatgpt-selection-conversation-id]'))node.removeAttribute('data-chatgpt-selection-conversation-id');const turn=answer.closest('[data-talvt-turn-state]');turn.replaceWith(turn.cloneNode(true));return {enriched:previous===message.getAttribute('data-chatgpt-selection-message-id'),remounted:!answer.isConnected,conversationMetadata:document.querySelectorAll('[data-chatgpt-selection-conversation-id]').length};})()`, helper.sessionId), { enriched: true, remounted: true, conversationMetadata: 0 });
  // A harmless URL query update must not invalidate the same live conversation.
  await cdp.evaluate(`history.replaceState(null,'','/c/fixture-canonical-route?fixture=dil&model=fixture&temporary-chat=true#tmp-chat-helper')`, helper.sessionId);
  await evaluate(`(()=>{const s=${panel};s.querySelector('#question').value=${JSON.stringify(followup)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
  snapshot = await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`DIL follow-up fixture failed: ${value.errorCode} at ${value.stage}`); return value?.status === 'done' && value.messages.length === 4 ? value : false; }, 'DIL follow-up answer reaches the panel', 30000);
  assert.match(snapshot.messages[3].text, /For example/); assert.equal(snapshot.messages[3].text.includes(followup), false);
  assert.equal(await evaluate(`${panel}.querySelector('.message.assistant')===window.__completedBubble`), true, 'Adding a follow-up preserves completed bubble identity');
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 2); assert.equal(await cdp.evaluate('window.__prompts[1]', helper.sessionId), followup);
  assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page' && info.url.includes('fixture=dil')).length, 1);
  console.log('PASS observed DIL wrappers: metadata enrichment and role remount preserve follow-up streaming through one helper with context sent once');

  // Match the live-observed post-answer header: old Temporary Chat markers
  // disappear, a scoped native Save chat button remains, and the canonical URL
  // explicitly carries temporary-chat=true. Message identity is still required.
  assert.deepEqual(await cdp.evaluate(`(()=>{const main=document.querySelector('main');main.replaceWith(main.cloneNode(true));return {oldMarkers:document.querySelectorAll('[data-testid="temporary-chat-header"],[data-testid="temporary-chat-banner"],button[aria-label="Turn off temporary chat"]').length,saveButtons:document.querySelectorAll('main header button[aria-label="Save chat"]').length,temporaryURL:new URLSearchParams(location.search).get('temporary-chat')==='true'};})()`, helper.sessionId), { oldMarkers: 0, saveButtons: 1, temporaryURL: true });
  const third = 'Continue after canonical URL and DOM remount.';
  await evaluate(`(()=>{const s=${panel};s.querySelector('#question').value=${JSON.stringify(third)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
  snapshot = await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`Canonical continuation failed: ${value.errorCode}`); return value?.status === 'done' && value.messages.length === 6 ? value : false; }, 'canonical conversation follow-up', 30000);
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 3);
  assert.equal(await cdp.evaluate('window.__prompts[2]', helper.sessionId), third);

  // A known native message ID changing in place is a contradiction even when
  // renderer unit keys and conversation-ID metadata still match. Check must
  // also refuse a foreign route while the original transcript remains visible.
  await cdp.evaluate(`(()=>{const answer=[...document.querySelectorAll('h4[data-conversation-role="assistant"]')].at(-1).parentElement;window.__conflictingAnswer=answer;window.__originalMessageIds=answer.getAttribute('data-chatgpt-search-message-ids');answer.setAttribute('data-chatgpt-search-message-ids','different-native-message');})()`, helper.sessionId);
  const retryQuestion = 'Retry only in the original temporary conversation.';
  const inputsBefore = await cdp.evaluate('window.__fixture.draftInputs', helper.sessionId);
  await evaluate(`(()=>{const s=${panel};s.querySelector('#question').value=${JSON.stringify(retryQuestion)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
  snapshot = await waitFor(async () => { const value = await state(); return value?.errorCode === 'CONVERSATION_CHANGED' ? value : false; }, 'contradictory native message refused');
  assert.equal(snapshot.stage, 'temporary_setup'); assert.equal(snapshot.uncertain, false);
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 3);
  assert.equal(await cdp.evaluate('window.__fixture.draftInputs', helper.sessionId), inputsBefore, 'No draft is inserted into an unverified conversation');
  await cdp.evaluate(`window.__conflictingAnswer.setAttribute('data-chatgpt-search-message-ids',window.__originalMessageIds);history.replaceState(null,'','/c/different-conversation?fixture=dil&temporary-chat=true#tmp-chat-helper')`, helper.sessionId);
  const beforeCheck = snapshot.revision;
  await evaluate(`${panel}.querySelector('#check').click()`);
  await waitFor(async () => { const value = await state(); return value?.errorCode === 'CONVERSATION_CHANGED' && value.revision > beforeCheck + 1; }, 'Check still refuses the different conversation');
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 3);
  await cdp.evaluate(`history.replaceState(null,'','/c/fixture-canonical-route?fixture=dil&model=fixture&temporary-chat=true#tmp-chat-helper')`, helper.sessionId);
  await evaluate(`${panel}.querySelector('#check').click()`);
  snapshot = await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`Restored continuation failed: ${value.errorCode}`); return value?.status === 'done' && value.messages.length === 8 ? value : false; }, 'Check retries only the unsent follow-up after restoration', 30000);
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 4);
  assert.equal(await cdp.evaluate('window.__prompts[3]', helper.sessionId), retryQuestion);
  assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page' && info.url.includes('fixture=dil')).length, 1);
  console.log('PASS query normalization, canonical remount, native identity conflict, foreign-route refusal, and safe Check recovery in one existing helper');
  await discard(helper);

  // A single native answer can contain several response-source containers.
  // Plain prose before/after code and widgets must be mirrored in DOM order.
  helper = await submit('rich', 'Explain the specific instance briefly, with a small Python example.');
  await waitFor(() => cdp.evaluate('!!window.__fixture.richReady', helper.sessionId), 'multi-part native response fixture');
  snapshot = await waitFor(async () => {
    const value = await state();
    if (value?.status === 'error') throw Error(`Rich answer fixture failed: ${value.errorCode} at ${value.stage}`);
    return value?.status === 'streaming' && value.messages[1]?.text.includes('Final explanation after every code block and visual.') ? value : false;
  }, 'all rich answer parts arrive while generation is active');
  const expectedCode = await cdp.evaluate('window.__fixture.expectedCode', helper.sessionId);
  const streamedText = snapshot.messages[1].text;
  assert.ok(streamedText.includes(expectedCode), 'Streamed code preserves Python indentation and blank lines');
  assert.equal(streamedText.includes('You said:'), false);
  assert.equal(streamedText.includes('Offline context for this helper regression.'), false);
  const fragments = ['A class is a blueprint', 'class BankAccount:', 'Two separate accounts', 'Text before the visual.', 'Text after the visual must remain', 'Final explanation after every code block and visual.'];
  let prior = -1;
  for (const fragment of fragments) { const index = streamedText.indexOf(fragment); assert.ok(index > prior, `Rich answer preserves order: ${fragment}`); prior = index; }
  // Reconcile a format-only native DOM change once generation ends. Text-only
  // signatures must not leave the panel on the preceding unformatted stream.
  await cdp.evaluate('window.__finishRich()', helper.sessionId);
  snapshot = await waitFor(async () => { const value = await state(); return value?.status === 'done' ? value : false; }, 'rich answer final reconciliation', 30000);
  assert.equal(snapshot.messages[1].text, streamedText, 'Formatting reconciliation preserves the full streamed answer');
  assert.ok(snapshot.messages[1].notices?.includes('unsupported'), 'Unsupported visuals have an explicit fallback');
  const rendered = await evaluate(`(()=>{const b=${panel}.querySelector('.message.assistant');return {code:b.querySelector('pre code')?.textContent,em:b.querySelector('em')?.textContent,heads:[...b.querySelectorAll('h3')].map(e=>e.textContent),rows:b.querySelectorAll('table tr').length,items:b.querySelectorAll('li').length,unsafe:b.querySelectorAll('script,svg,canvas,iframe').length,text:b.textContent,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  assert.equal(rendered.code, expectedCode, 'The panel renders one code block without its native language/Copy/Run controls');
  assert.equal(rendered.em, 'Final explanation after every code block and visual.');
  assert.deepEqual(rendered.heads, ['Two separate accounts']); assert.equal(rendered.rows, 2); assert.equal(rendered.items, 2);
  assert.equal(rendered.unsafe, 0); assert.equal(rendered.overflow, false);
  assert.ok(rendered.text.includes('Text after the visual must remain in the answer.'));
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 1, 'Final reconciliation never resends a prompt');
  await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, source).then(result => fs.writeFileSync(path.resolve(__dirname, '../.test-artifacts/rich-answer-bottom.png'), Buffer.from(result.data, 'base64')));
  await evaluate(`${panel}.querySelector('.messages').scrollTop=0`);
  await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, source).then(result => fs.writeFileSync(path.resolve(__dirname, '../.test-artifacts/rich-answer.png'), Buffer.from(result.data, 'base64')));
  const sessionBeforeOpen = snapshot.id;
  const helperTabsBefore = (await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').length;
  await evaluate(`(()=>{const b=${panel}.querySelector('.message.assistant');const open=[...b.querySelectorAll('button')].find(e=>/View.*ChatGPT|Open.*ChatGPT/i.test(e.textContent));if(!open)throw Error('Missing rich-content View in ChatGPT action');open.click();})()`);
  await waitFor(async () => (await cdp.evaluate(`chrome.tabs.query({active:true}).then(t=>t.some(v=>v.url?.includes('fixture=rich')))`, worker)), 'rich-content action focuses the existing helper');
  snapshot = await state(); assert.equal(snapshot.id, sessionBeforeOpen); assert.equal(snapshot.hasHelper, true);
  assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').length, helperTabsBefore, 'Viewing rich content must not create a second helper');
  console.log('PASS multi-part native answers; exact div-based code; prose after widgets; final format reconciliation; safe existing-helper fallback');
  await discard(helper);

  helper = await submit('personalization');
  snapshot = await waitFor(async () => { const value = await state(); return value?.errorCode === 'TEMPORARY_CHOICE_REQUIRED' ? value : false; }, 'Temporary Chat personalization choice');
  assert.equal(snapshot.stage, 'temporary_setup'); assert.equal(snapshot.uncertain, false);
  assert.equal(snapshot.probe.temporaryChoice, true);
  assert.deepEqual(await cdp.evaluate(`({choices:window.__fixture.personalizationClicks,inputs:window.__fixture.draftInputs,clicks:window.__fixture.sendButtonClicks,sends:window.__sends,draft:document.querySelector('[data-fixture-editor]').innerText})`, helper.sessionId), { choices: 0, inputs: 0, clicks: 0, sends: 0, draft: '' });
  // Simulate the user making their own native preference choice. The extension
  // itself must leave both options untouched and wait for an explicit Check.
  await cdp.evaluate('document.getElementById("fixture-not-now").click()', helper.sessionId);
  await delay(200); assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 0);
  await evaluate(`${panel}.querySelector('#check').click()`);
  await waitFor(async () => { const value = await state(); if (value?.status === 'error') throw Error(`Personalization resume fixture failed: ${value.errorCode} at ${value.stage}`); return value?.status === 'done'; }, 'explicit personalization setup resume', 30000);
  assert.equal(await cdp.evaluate('window.__fixture.personalizationClicks', helper.sessionId), 1);
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 1);
  assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page' && info.url.includes('fixture=personalization')).length, 1);
  console.log('PASS Temporary Chat personalization blocks all context insertion; explicit user choice and Check resume one helper');
  await discard(helper);

  helper = await submit('no-ack');
  snapshot = await waitFor(async () => { const value = await state(); return value?.errorCode === 'SEND_UNCONFIRMED' ? value : false; }, 'ambiguous native send confirmation', 25000);
  assert.equal(snapshot.stage, 'send_confirm'); assert.equal(snapshot.uncertain, true);
  assert.equal(await cdp.evaluate('window.__fixture.sendButtonClicks', helper.sessionId), 1);
  await evaluate(`${panel}.querySelector('#check').click()`);
  await waitFor(async () => (await state())?.status === 'sending', 'observation-only Check');
  await delay(300);
  assert.equal(await cdp.evaluate('window.__fixture.sendButtonClicks', helper.sessionId), 1, 'Check must not click Send again when submission is ambiguous');
  assert.equal(await cdp.evaluate('window.__sends', helper.sessionId), 0);
  assert.equal((await state()).messages.length, 2);
  console.log('PASS ambiguous send confirmation reports its exact phase; Check observes without replaying the question');
  await discard(helper);
};
