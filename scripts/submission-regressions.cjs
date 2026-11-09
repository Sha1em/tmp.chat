/* Offline native-submission regressions. The helper stays inactive and hidden.
   These debugger-attached fixtures do not prove live ChatGPT scheduling. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function submissionRegressions({ cdp, source, worker, sessions, waitFor }) {
  const panel = `document.getElementById('tmp-chat-root').shadowRoot`;
  const ui = expression => cdp.evaluate(expression, source);
  // Unlike the shared convenience evaluator, helper reads/transitions never
  // manufacture a user gesture. Runtime.evaluate does not activate the tab.
  const hidden = async (expression, sessionId) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const sourceTab = await cdp.evaluate(`chrome.tabs.query({url:'https://chatgpt.com/c/source'}).then(tabs=>tabs[0].id)`, worker);
  const command = type => cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${sourceTab}},func:async()=>chrome.runtime.sendMessage({type:${JSON.stringify('tmp:' + type)}})}).then(results=>results[0].result)`, worker);
  const snapshot = async () => (await command('hello')).state;
  const measurements = { scope: 'Offline headless Edge; debugger attached; helper remains hidden. Not live ChatGPT startup latency.', cases: [] };
  await cdp.evaluate(`chrome.tabs.update(${sourceTab},{active:true});globalThis.__tmpSubmissionActivations=[];globalThis.__tmpSubmissionActivationListener=info=>globalThis.__tmpSubmissionActivations.push(info.tabId);chrome.tabs.onActivated.addListener(globalThis.__tmpSubmissionActivationListener)`, worker);

  async function begin(mode, question) {
    assert.equal(await snapshot(), null, 'Submission regression starts without a tangent');
    await cdp.evaluate(`globalThis.__tmpFixtureMode=${JSON.stringify(mode)};globalThis.__tmpSubmissionActivations.length=0;chrome.tabs.sendMessage(${sourceTab},{type:'tmp:toggle'})`, worker);
    await waitFor(() => ui(`!${panel}.querySelector('.card').hidden`), 'submission panel opens');
    await ui(`(()=>{const s=${panel};s.querySelector('#pasted-context').value='Offline submission context.';s.querySelector('#question').value=${JSON.stringify(question)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
    const target = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(info => info.type === 'page' && info.url.startsWith('https://chatgpt.com/') && new URL(info.url).searchParams.get('fixture') === mode), 'submission helper fixture');
    const sessionId = await waitFor(() => sessions.get(target.targetId)?.sessionId, 'submission helper attachment');
    const tabId = await cdp.evaluate(`chrome.tabs.query({url:'https://chatgpt.com/*'}).then(tabs=>tabs.find(tab=>new URL(tab.url).searchParams.get('fixture')===${JSON.stringify(mode)}).id)`, worker);
    assert.equal(await hidden('document.visibilityState', sessionId), 'hidden');
    assert.equal(await cdp.evaluate(`chrome.tabs.get(${tabId}).then(tab=>tab.active)`, worker), false);
    return { targetId: target.targetId, sessionId, tabId, mode };
  }
  async function waitStage(stage) {
    return waitFor(async () => {
      const state = await snapshot();
      if (state?.status === 'error') throw Error(`Submission fixture failed: ${state.errorCode} at ${state.stage}`);
      return state?.stage === stage ? state : false;
    }, 'submission stage ' + stage, 7000);
  }
  async function completed(helper, sends) {
    await waitFor(async () => {
      const state = await snapshot();
      if (state?.status === 'error') throw Error(`Submission fixture failed: ${state.errorCode} at ${state.stage}`);
      return state?.status === 'done' && state.messages.filter(message => message.role === 'assistant').length === sends;
    }, 'submission answer completes', 30000);
    assert.equal(await hidden('window.__sends', helper.sessionId), sends);
    assert.equal(await hidden('window.__fixture.sendButtonClicks', helper.sessionId), sends, 'One native Send click per question');
    assert.equal(await hidden('window.__fixture.detachedSendClicks||0', helper.sessionId), 0, 'Never click a detached native Send button');
    assert.equal(await hidden('document.visibilityState', helper.sessionId), 'hidden');
    assert.equal(await cdp.evaluate(`chrome.tabs.get(${helper.tabId}).then(tab=>tab.active)`, worker), false);
    assert.equal(await cdp.evaluate(`globalThis.__tmpSubmissionActivations.includes(${helper.tabId})`, worker), false, 'Preparing and sending never activates the helper');
    assert.equal(await ui(`${panel}.querySelectorAll('.message.assistant strong').length`), sends, 'Final safe formatting is retained');
  }
  async function discard(helper) {
    assert.equal((await command('discard')).ok, true);
    await waitFor(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(info => info.targetId === helper.targetId), 'submission helper cleanup');
    await ui(`${panel}.querySelector('#discard').click()`);
    await waitFor(() => ui(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`), 'submission panel cleanup');
    await cdp.evaluate(`globalThis.__tmpFixtureMode=''`, worker);
  }

  try {
    // Each native readiness change modifies an existing node. No child-list or
    // unrelated mutation is available to accidentally wake the readiness wait.
    let helper = await begin('submission-ready', 'First hidden submission.\nPreserve this second line.');
    await waitStage('composer_ready');
    assert.equal(await hidden('window.__fixture.draftInputs', helper.sessionId), 0);
    await hidden(`document.querySelector('[data-fixture-editor]').setAttribute('aria-label','Ask ChatGPT')`, helper.sessionId);
    await waitFor(() => hidden('window.__fixture.temporaryClicks===1', helper.sessionId), 'temporary setup requested', 7000);
    assert.equal(await hidden('window.__fixture.draftInputs', helper.sessionId), 0, 'Context waits for positive Temporary Chat verification');
    await hidden(`document.getElementById('fixture-temporary-heading').firstChild.data='Temporary Chat'`, helper.sessionId);
    await waitStage('send_ready');
    assert.ok(await hidden('window.__fixture.draftInputs>0', helper.sessionId), 'The native editor accepted input after Temporary Chat verification');
    assert.equal(await hidden('window.__fixture.sendButtonClicks', helper.sessionId), 0);
    const labelReadyAt = await hidden(`(()=>{const at=Date.now();document.getElementById('fixture-send').setAttribute('aria-label','Send');return at;})()`, helper.sessionId);
    await completed(helper, 1);
    const nativeSentAt = await hidden('window.__fixture.nativeSentAt', helper.sessionId);
    const readiness = { name: 'hidden-existing-node-readiness', sendLabelToNativeSubmissionMs: nativeSentAt - labelReadyAt, nativeClicks: 1, helperActivations: 0 };
    measurements.cases.push(readiness);
    assert.match(await hidden('window.__prompts[0]', helper.sessionId), /First hidden submission\.\nPreserve this second line\./);
    // Complete the fixture's toggle reconciliation after isolating the heading
    // text mutation. Follow-ups must never authorize an explicit off control.
    await hidden(`(()=>{const toggle=document.querySelector('[data-testid="temporary-chat-button"]');toggle.setAttribute('aria-pressed','true');toggle.setAttribute('aria-label','Turn off temporary chat');})()`, helper.sessionId);
    const followup = 'Follow-up in the same inactive helper.';
    await ui(`(()=>{const s=${panel};s.querySelector('#question').value=${JSON.stringify(followup)};s.querySelector('#question').dispatchEvent(new Event('input'));s.querySelector('form').requestSubmit();})()`);
    await completed(helper, 2);
    assert.equal(await hidden('window.__prompts[1]', helper.sessionId), followup);
    assert.equal(await cdp.evaluate(`chrome.tabs.query({url:'https://chatgpt.com/*'}).then(tabs=>tabs.filter(tab=>new URL(tab.url).searchParams.get('fixture')==='submission-ready').length)`, worker), 1);
    await discard(helper);
    console.log('PASS hidden helper observes composer/Send label and Temporary Chat text-node readiness changes; formatting and follow-ups remain intact', JSON.stringify(readiness));

    // Simulate a SPA replacing both editor and Send after durable attempt
    // recording, before the click. Preserve the exact owned draft, not a copy
    // of the old editor's event handlers. The live controls must be re-resolved.
    helper = await begin('loading-manual', 'Keep the exact owned draft across a native remount.');
    await waitStage('composer_ready');
    await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${helper.tabId}},func:()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);let paused=false;chrome.runtime.sendMessage=async message=>{const reply=await send(message);if(!paused&&message.type==='tmp:event'&&message.event?.kind==='submitted'){paused=true;globalThis.__tmpSubmissionAckWaiting=true;await new Promise(resolve=>globalThis.__tmpReleaseSubmissionAck=resolve);}return reply;};}})`, worker);
    await hidden('window.__mountComposer()', helper.sessionId);
    await waitFor(async () => (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${helper.tabId}},func:()=>!!globalThis.__tmpSubmissionAckWaiting}).then(results=>results[0].result)`, worker)), 'durable pre-send ACK pause', 7000);
    assert.equal(await hidden('window.__sends', helper.sessionId), 0);
    await hidden('window.__remountSubmission()', helper.sessionId);
    await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${helper.tabId}},func:()=>globalThis.__tmpReleaseSubmissionAck()})`, worker);
    await completed(helper, 1);
    assert.equal(await hidden('window.__fixture.submissionRemounts', helper.sessionId), 1);
    assert.match(await hidden('window.__prompts[0]', helper.sessionId), /Keep the exact owned draft across a native remount\./);
    await discard(helper);
    measurements.cases.push({ name: 'hidden-remount-after-durable-ack', nativeClicks: 1, detachedClicks: 0, helperActivations: 0 });
    console.log('PASS exact owned draft and fresh Send survive a native editor/button remount during pre-send acknowledgement; one hidden submission');
  } finally {
    await cdp.evaluate(`if(globalThis.__tmpSubmissionActivationListener)chrome.tabs.onActivated.removeListener(globalThis.__tmpSubmissionActivationListener);delete globalThis.__tmpSubmissionActivationListener;globalThis.__tmpFixtureMode=''`, worker);
  }
  const version = await cdp.evaluate('chrome.runtime.getManifest().version', worker);
  fs.writeFileSync(path.join(__dirname, '..', '.test-artifacts', `submission-${version}.json`), JSON.stringify(measurements, null, 2));
};
