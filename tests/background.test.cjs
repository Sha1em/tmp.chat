'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname,'..');
function event() { const listeners = new Set(); return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>{for(const fn of listeners) fn(...args);},listeners}; }
function harness(saved = null) {
  const data = saved ? {'tmp.chat.session':structuredClone(saved)} : {};
  const tabs = new Map([[1,{id:1,url:'https://chatgpt.com/c/source',status:'complete'}],[9,{id:9,url:'https://chatgpt.com/c/other',status:'complete'}]]);
  const calls = [], removed = [], updates = [], diagnostics = []; let nextId=2;
  const runtimeMessage=event(), onRemoved=event(), onUpdated=event(), onAlarm=event();
  const chrome = {
    runtime:{id:'test-extension',onMessage:runtimeMessage},
    storage:{session:{get:async key=>({[key]:data[key]}),set:async values=>Object.assign(data,structuredClone(values)),remove:async key=>{delete data[key];}},local:{get:async key=>({[key]:data[key]}),set:async values=>Object.assign(data,structuredClone(values))}},
    tabs:{onRemoved,onUpdated,get:async id=>{if(!tabs.has(id))throw Error('No tab');return {...tabs.get(id)};},create:async props=>{const tab={id:nextId++,status:'complete',...props};tabs.set(tab.id,tab);calls.push({type:'create',...props});return tab;},update:async(id,props)=>{if(!tabs.has(id))throw Error('No tab');Object.assign(tabs.get(id),props);updates.push({id,...props});return tabs.get(id);},remove:async id=>{removed.push(id);tabs.delete(id);onRemoved.emit(id,{});},sendMessage:async(id,message)=>{calls.push({type:'message',id,message:structuredClone(message)});return message.type==='tmp:probe'?{ok:true,ready:true,probe:{documentState:'complete',hasComposer:true}}:{ok:true};}},
    scripting:{executeScript:async props=>{calls.push({type:'inject',...props});return[];}},
    alarms:{create:async()=>{},clear:async()=>true,onAlarm},action:{onClicked:event()}
  };
  const timers=new Set(), timerDetails=new Map();
  const context=vm.createContext({chrome,crypto:webcrypto,URL,console:{...console,debug:(...args)=>diagnostics.push(args)},setTimeout:(fn,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);timerDetails.delete(timer);fn();},delay);timers.add(timer);timerDetails.set(timer,{fn,delay});return timer;},clearTimeout:timer=>{timers.delete(timer);timerDetails.delete(timer);clearTimeout(timer);}});
  context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
  function send(type,payload={},id=1) { return new Promise(resolve=>runtimeMessage.emit({type:`tmp:${type}`,...payload},{id:'test-extension',tab:tabs.get(id)||{id}},resolve)); }
  const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
  const fireTimeout=delay=>{for(const[timer,detail]of[...timerDetails])if(detail.delay===delay){clearTimeout(timer);timers.delete(timer);timerDetails.delete(timer);detail.fn();}};
  return {send,settle,fireTimeout,calls,removed,updates,diagnostics,tabs,data,chrome,close:()=>{for(const timer of timers)clearTimeout(timer);}};
}
test('progress stages do not wait on storage before first text, but submitted remains durable', async t => {
  const h = harness(); t.after(h.close);
  await h.send('ensure'); await h.send('send', { question: 'why' }); await h.settle();
  const run = h.calls.find(call => call.message?.type === 'tmp:run');
  let writes = 0, release;
  const set = h.chrome.storage.session.set;
  h.chrome.storage.session.set = async values => { writes++; await new Promise(resolve => { release = resolve; }); return set(values); };
  const payload = event => ({ sessionId: run.message.sessionId, requestId: run.message.requestId, event });
  await h.send('event', payload({ kind: 'stage', stage: 'response_wait' }), run.id);
  await h.send('event', payload({ kind: 'stream', stage: 'response_stream', sequence: 1, offset: 0, delta: 'First text' }), run.id);
  assert.equal(writes, 0, 'Cosmetic stages and streams coalesce their checkpoints');
  assert.ok(h.calls.some(call => call.message?.type === 'tmp:patch' && call.message.delta === 'First text'));
  const submitted = h.send('event', payload({ kind: 'submitted' }), run.id);
  await h.settle(); assert.equal(writes, 1); release(); await submitted;
});

test('stream gaps request a snapshot; duplicates and stale rewrites cannot corrupt output', async t => {
  const h = harness(); t.after(h.close);
  await h.send('ensure'); await h.send('send', { question: 'why' }); await h.settle();
  const run = h.calls.find(call => call.message?.type === 'tmp:run');
  const stream = event => h.send('event', { sessionId: run.message.sessionId, requestId: run.message.requestId, event: { kind: 'stream', ...event } }, run.id);
  await stream({ sequence: 1, offset: 0, delta: 'A' });
  const revision = (await h.send('hello')).state.revision;
  await stream({ sequence: 1, offset: 0, delta: 'A' });
  assert.equal((await h.send('hello')).state.revision, revision);
  assert.equal((await stream({ sequence: 3, offset: 2, delta: 'C' })).resync, true);
  assert.equal((await h.send('hello')).state.messages[1].text, 'A');
  await stream({ sequence: 3, text: 'ABC' });
  await stream({ sequence: 2, text: 'STALE' });
  const snapshot = (await h.send('hello')).state;
  assert.equal(snapshot.messages[1].text, 'ABC'); assert.equal(snapshot.messages[1].sequence, 3);
  assert.equal(h.calls.filter(call => call.message?.type === 'tmp:run').length, 1);
  const patch = h.calls.filter(call => call.message?.type === 'tmp:patch').at(-1).message;
  assert.equal(patch.sequence, 3); assert.equal(patch.revision, snapshot.revision);
});

test('worker restart repairs an uncheckpointed stream gap from existing output without redispatch', async t => {
  const h = harness(); t.after(h.close);
  await h.send('ensure'); await h.send('send', { question: 'why' }); await h.settle();
  const run = h.calls.find(call => call.message?.type === 'tmp:run');
  const payload = event => ({ sessionId: run.message.sessionId, requestId: run.message.requestId, event: { kind: 'stream', ...event } });
  await h.send('event', payload({ sequence: 1, offset: 0, delta: 'A' }), run.id);
  const restarted = harness(h.data['tmp.chat.session']); t.after(restarted.close);
  assert.equal((await restarted.send('event', payload({ sequence: 2, offset: 1, delta: 'B' }), run.id)).resync, true);
  await restarted.send('event', payload({ sequence: 2, text: 'AB' }), run.id);
  const state = (await restarted.send('hello')).state;
  assert.equal(state.messages[1].text, 'AB'); assert.equal(state.messages[1].sequence, 2);
  assert.equal(restarted.calls.some(call => call.message?.type === 'tmp:run' || call.type === 'create'), false);
});

test('lazy startup, one helper, incremental answers, and bounded follow-ups', async t=>{
  const h=harness();t.after(h.close);
  let result=await h.send('context',{context:{selection:'a passage',nearby:'some context'}});assert.equal(result.ok,true);assert.equal(h.calls.filter(c=>c.type==='create').length,0);
  result=await h.send('send',{question:'Explain'});assert.equal(result.ok,true);await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');assert.ok(run);assert.equal(h.calls.filter(c=>c.type==='create').length,1);assert.equal(h.calls.find(c=>c.type==='create').active,false);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'submitted'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'An explanation.',tree:[{tag:'p',children:[{text:'An explanation.'}]}]}},run.id);
  const snapshot=await h.send('hello');assert.equal(snapshot.state.messages[1].text,'An explanation.');assert.equal(snapshot.state.helperTabId,undefined);
  await h.send('send',{question:'An example?'});await h.settle();
  const runs=h.calls.filter(c=>c.message?.type==='tmp:run');assert.equal(runs.length,2);assert.equal(runs[1].message.prompt,'An example?');assert.equal(runs[1].message.continuation,true);assert.equal(h.calls.filter(c=>c.type==='create').length,1);
});

test('dispatch waits for navigation, script injection, and a listener-ready handshake', async t=>{
  const h=harness();t.after(h.close);const create=h.chrome.tabs.create;let helper;
  h.chrome.tabs.create=async props=>{helper=await create(props);Object.assign(helper,{url:'about:blank',pendingUrl:props.url,status:'complete'});return helper;};
  let acknowledge;const waiting=new Promise(resolve=>{acknowledge=resolve;});const sendMessage=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:probe'?waiting:result;};
  await h.send('ensure');await h.send('send',{question:'private question'});await h.settle();
  assert.equal(h.calls.filter(c=>c.type==='inject').length,0);assert.equal((await h.send('hello')).state.stage,'helper_loading');
  helper.url=helper.pendingUrl;delete helper.pendingUrl;h.chrome.tabs.onUpdated.emit(helper.id,{url:helper.url,status:'complete'});await h.settle();
  const injection=h.calls.find(c=>c.type==='inject');assert.deepEqual(Array.from(injection.files),['lib/core.js','lib/selection.js','lib/answer.js','agent.js']);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,0);assert.equal(h.data['tmp.chat.session'].dispatched,false);
  acknowledge({ok:true,ready:true,probe:{documentState:'complete',composerCount:0,temporary:false,authGate:false,privateText:'private question'}});await h.settle();
  assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1,'listener readiness must not require the SPA composer yet');assert.equal((await h.send('hello')).state.stage,'dispatch');
  const logs=JSON.stringify(h.diagnostics);assert.equal(logs.includes('private question'),false);assert.equal(logs.includes('privateText'),false);
});

test('failed helper handshake is a retryable pre-dispatch failure and reuses one helper', async t=>{
  const h=harness();t.after(h.close);const sendMessage=h.chrome.tabs.sendMessage;let failProbe=true;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:probe'&&failProbe?{ok:true,ready:false}:result;};
  await h.send('ensure');await h.send('send',{question:'why'});await h.settle();let snapshot=await h.send('hello');
  assert.equal(snapshot.state.errorCode,'HELPER_HANDSHAKE');assert.equal(snapshot.state.stage,'agent_ready');assert.equal(snapshot.state.uncertain,false);assert.equal(h.data['tmp.chat.session'].dispatched,false);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,0);
  failProbe=false;assert.equal((await h.send('check')).ok,true);await h.settle();snapshot=await h.send('hello');
  assert.equal(snapshot.state.status,'sending');assert.equal(snapshot.state.errorCode,'');assert.equal(h.calls.filter(c=>c.type==='create').length,1);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);
});

test('helper load and handshake deadlines report distinct pre-send failure codes', async t=>{
  const loading=harness();t.after(loading.close);const create=loading.chrome.tabs.create;
  loading.chrome.tabs.create=async props=>{const tab=await create(props);tab.status='loading';return tab;};
  await loading.send('ensure');await loading.send('send',{question:'why'});await loading.settle();loading.fireTimeout(25000);await loading.settle();
  let snapshot=await loading.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_LOAD_TIMEOUT');assert.equal(snapshot.state.uncertain,false);assert.equal(loading.calls.filter(c=>c.type==='inject').length,0);
  const connecting=harness();t.after(connecting.close);const sendMessage=connecting.chrome.tabs.sendMessage;
  connecting.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:probe'?new Promise(()=>{}):result;};
  await connecting.send('ensure');await connecting.send('send',{question:'why'});await connecting.settle();connecting.fireTimeout(5000);await connecting.settle();
  snapshot=await connecting.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_HANDSHAKE_TIMEOUT');assert.equal(snapshot.state.uncertain,false);assert.equal(connecting.calls.filter(c=>c.message?.type==='tmp:run').length,0);
});

test('stalled script injection has a retryable deadline without dispatching the question', async t=>{
  const h=harness();t.after(h.close);let finishInjection;
  h.chrome.scripting.executeScript=()=>new Promise(resolve=>{finishInjection=resolve;});
  await h.send('ensure');await h.send('send',{question:'private question'});await h.settle();h.fireTimeout(15000);await h.settle();
  const snapshot=await h.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_INJECTION_TIMEOUT');assert.equal(snapshot.state.stage,'agent_injecting');assert.equal(snapshot.state.uncertain,false);assert.equal(h.data['tmp.chat.session'].dispatched,false);
  finishInjection([]);await h.settle();assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,0,'late injection completion must not send after its deadline');
});

test('a missing dispatch acknowledgement is ambiguous and Check again only observes it', async t=>{
  const h=harness();t.after(h.close);let acknowledge;const waiting=new Promise(resolve=>{acknowledge=resolve;});const sendMessage=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:run'?waiting:result;};
  await h.send('ensure');await h.send('send',{question:'private question'});await h.settle();h.fireTimeout(5000);await h.settle();
  let snapshot=await h.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_DISPATCH_TIMEOUT');assert.equal(snapshot.state.stage,'dispatch');assert.equal(snapshot.state.uncertain,true);assert.equal(h.data['tmp.chat.session'].dispatched,true);
  assert.equal((await h.send('check')).ok,true);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:check').length,1);
  acknowledge({ok:true});await h.settle();snapshot=await h.send('hello');assert.equal(snapshot.state.status,'sending');assert.equal(h.calls.filter(c=>c.type==='create').length,1);
});

test('navigation and injection failures never dispatch and expose content-free stage codes', async t=>{
  const moved=harness();t.after(moved.close);const create=moved.chrome.tabs.create;
  moved.chrome.tabs.create=async props=>{const tab=await create(props);tab.url='https://example.org/auth';return tab;};
  await moved.send('ensure');await moved.send('send',{question:'why'});await moved.settle();let snapshot=await moved.send('hello');
  assert.equal(snapshot.state.errorCode,'HELPER_NAVIGATION');assert.equal(snapshot.state.uncertain,false);assert.equal(moved.calls.filter(c=>c.type==='inject').length,0);
  const injection=harness();t.after(injection.close);injection.chrome.scripting.executeScript=async()=>{throw new Error('PRIVATE PLATFORM DETAIL');};
  await injection.send('ensure');await injection.send('send',{question:'why'});await injection.settle();snapshot=await injection.send('hello');
  assert.equal(snapshot.state.errorCode,'HELPER_INJECTION');assert.equal(snapshot.state.stage,'agent_injecting');assert.equal(snapshot.state.uncertain,false);assert.equal(injection.calls.filter(c=>c.message?.type==='tmp:run').length,0);assert.equal(JSON.stringify(injection.diagnostics).includes('PRIVATE PLATFORM DETAIL'),false);
});

test('agent phase errors retain exact stage and code with sanitized probe metadata', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'stage',stage:'temporary_setup',probe:{documentState:'interactive',composerCount:1,temporary:false,privateText:'PRIVATE CONTEXT'}}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'error',stage:'temporary_setup',code:'TEMPORARY_NOT_VERIFIED',text:'Turn on Temporary Chat in the helper.',attempted:false}},run.id);
  const snapshot=await h.send('hello');assert.equal(snapshot.state.stage,'temporary_setup');assert.equal(snapshot.state.errorCode,'TEMPORARY_NOT_VERIFIED');assert.equal(snapshot.state.uncertain,false);assert.equal(snapshot.state.probe.composerCount,1);assert.equal(snapshot.state.probe.privateText,undefined);assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE CONTEXT'),false);
});

test('continuation diagnostics retain only fixed reasons without native identities or conversation content', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  const event=probe=>h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'stage',stage:'temporary_setup',probe}},run.id);
  await event({continuationReason:'anchor',nativeId:'PRIVATE ID',privateText:'PRIVATE CONTEXT'});
  let snapshot=await h.send('hello');assert.deepEqual(JSON.parse(JSON.stringify(snapshot.state.probe)),{continuationReason:'anchor'});
  await event({continuationReason:'PRIVATE CONTEXT'});snapshot=await h.send('hello');assert.equal(snapshot.state.probe.continuationReason,undefined);
  assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE CONTEXT'),false);assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE ID'),false);
});

test('failed observation reconnect never resends an ambiguous request', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'error',code:'SEND_CONFIRM_TIMEOUT',stage:'send_confirm',text:'Confirmation not seen',attempted:true}},run.id);
  const sendMessage=h.chrome.tabs.sendMessage;h.chrome.tabs.sendMessage=async(id,message)=>{if(message.type==='tmp:check')throw new Error('No receiving end');return sendMessage(id,message);};
  assert.equal((await h.send('check')).ok,false);const snapshot=await h.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_CHECK_CONNECTION');assert.equal(snapshot.state.uncertain,true);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);
});

test('Check refreshes read-only adapters before observing an existing request without replay', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'error',code:'SEND_UNCONFIRMED',stage:'send_confirm',text:'The response wrappers could not be identified.',attempted:true}},run.id);
  const before=h.calls.length;assert.equal((await h.send('check')).ok,true);
  const observation=h.calls.slice(before),injection=observation.findIndex(call=>call.type==='inject'),check=observation.findIndex(call=>call.message?.type==='tmp:check');
  assert.ok(injection>=0&&check>injection,'Refresh the shared DOM adapters before observation');assert.deepEqual(Array.from(observation[injection].files),['lib/core.js','lib/selection.js','lib/answer.js','agent.js']);
  assert.equal(observation[check].message.requestId,run.message.requestId);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);assert.equal(h.calls.filter(c=>c.type==='create').length,1);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'The existing answer is now detected.'}},run.id);
  let snapshot=await h.send('hello');assert.equal(snapshot.state.status,'done');assert.equal(snapshot.state.messages[1].text,'The existing answer is now detected.');
  await h.send('send',{question:'follow-up'});await h.settle();const next=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  await h.send('event',{sessionId:next.message.sessionId,requestId:next.message.requestId,event:{kind:'error',code:'SEND_UNCONFIRMED',stage:'send_confirm',text:'The agent document was replaced.',attempted:true}},next.id);
  const sendMessage=h.chrome.tabs.sendMessage;h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:check'?{ok:false}:result;};
  assert.equal((await h.send('check')).ok,false);snapshot=await h.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_CHECK_UNKNOWN');assert.equal(snapshot.state.uncertain,true);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,2,'A replacement agent with no remembered request must never receive a replay');
});
test('double sends, cross-tab control, and stale helper updates are rejected', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});
  const results=await Promise.all([h.send('send',{question:'one'}),h.send('send',{question:'two'})]);assert.equal(results.filter(r=>r.ok).length,1);await h.settle();
  assert.equal((await h.send('discard',{},9)).ok,false);assert.equal((await h.send('hello',{},9)).occupied,true);
  const run=h.calls.find(c=>c.message?.type==='tmp:run');
  assert.equal((await h.send('event',{sessionId:'wrong',requestId:run.message.requestId,event:{kind:'done',text:'wrong'}},run.id)).ok,false);
  assert.equal((await h.send('hello')).state.status,'sending');
});
test('ambiguous failure can be checked, but never resubmitted', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});await h.send('send',{question:'why'});await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'error',text:'stalled',attempted:true}},run.id);
  assert.equal((await h.send('send',{question:'why'})).ok,false);
  await h.send('check');assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:check').length,1);
});
test('discard closes only its helper; handoff retains it and clears local state', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});await h.send('send',{question:'why'});await h.settle();
  let run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('discard');assert.deepEqual(h.removed,[run.id]);assert.equal((await h.send('hello')).state,null);
  await h.send('context',{context:{selection:'next'}});await h.send('send',{question:'next?'});await h.settle();run=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'answer'}},run.id);
  assert.equal((await h.send('keep')).handedOff,true);assert.ok(h.tabs.has(run.id));assert.equal(h.removed.length,1);assert.equal((await h.send('hello')).state,null);
});
test('closing the source cleans up its temporary helper', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});await h.send('send',{question:'why'});await h.settle();
  h.chrome.tabs.onRemoved.emit(1,{});await h.settle();assert.equal(h.removed.length,1);assert.equal((await h.send('hello')).state,null);
});
test('worker restart restores the existing session instead of creating a new conversation', async t=>{
  const h=harness({id:'restored',ownerTabId:1,helperTabId:4,context:{selection:'old'},messages:[{id:'u',role:'user',text:'why'}],status:'done',retained:false});t.after(h.close);
  const result=await h.send('hello');assert.equal(result.state.id,'restored');assert.equal(result.state.messages[0].text,'why');assert.equal(h.calls.length,0);
});

test('worker restart preserves cancellation while helper submission and streaming arrive', async t=>{
  const h=harness({id:'restored',ownerTabId:1,helperTabId:4,requestId:'running',context:{selection:'old'},messages:[{id:'running',role:'assistant',text:''}],status:'stopping',stopRequested:true,dispatched:true,retained:false});t.after(h.close);
  await h.send('event',{sessionId:'restored',requestId:'running',event:{kind:'submitted'}},4);
  await h.send('event',{sessionId:'restored',requestId:'running',event:{kind:'stream',delta:'partial'}},4);
  const result=await h.send('hello');assert.equal(result.state.status,'stopping');assert.equal(result.state.stopRequested,true);assert.equal(result.state.messages[0].text,'partial');
});
test('invalid context does not allocate a session', async t=>{
  const h=harness();t.after(h.close);assert.equal((await h.send('context',{context:{selection:'  '}})).ok,false);assert.equal((await h.send('hello')).state,null);
});

test('manual fallback creates an empty lazy session and sends without selection', async t=>{
  const h=harness();t.after(h.close);
  const result=await h.send('ensure');assert.equal(result.ok,true);assert.equal(result.state.context.selection,'');assert.equal(result.state.status,'idle');assert.equal(h.calls.filter(c=>c.type==='create').length,0);
  assert.equal((await h.send('send',{question:'Explain a question I pasted manually.'})).ok,true);await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');assert.ok(run);assert.match(run.message.prompt,/Explain a question I pasted manually\./);
  const logs=JSON.stringify(h.diagnostics);assert.match(logs,/tmp:ensure/);assert.equal(logs.includes('Explain a question I pasted manually.'),false);
});

test('ensure bounds initial pasted context, is idempotent, and preserves ownership', async t=>{
  const h=harness();t.after(h.close);
  const first=await h.send('ensure',{context:{selection:'x'.repeat(9000),nearby:'n'.repeat(9000),prompt:'p'.repeat(9000)}});
  assert.equal(first.state.context.selection.length,2400);assert.equal(first.state.context.nearby.length,4200);assert.equal(first.state.context.prompt.length,1600);
  const again=await h.send('ensure',{context:{selection:'replacement'}});assert.equal(again.state.id,first.state.id);assert.equal(again.state.context.selection,first.state.context.selection);
  assert.equal((await h.send('ensure',{},9)).ok,false);assert.equal((await h.send('hello',{},9)).occupied,true);
  await h.send('send',{question:'why'});await h.settle();
  const busy=await h.send('ensure');assert.equal(busy.state.id,first.state.id);assert.equal(busy.state.messages.length,2);assert.equal(busy.state.context.selection,first.state.context.selection);
});

test('idle manual session controls give errors without allocating a helper', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');
  assert.equal((await h.send('focus')).ok,false);assert.equal((await h.send('keep')).ok,false);assert.equal((await h.send('stop')).ok,true);
  assert.equal(h.calls.filter(c=>c.type==='create').length,0);assert.equal((await h.send('discard')).ok,true);assert.equal((await h.send('hello')).state,null);
});

test('failed keep handoff does not mark the helper retained or prevent discard cleanup', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'answer'}},run.id);
  h.chrome.tabs.update=async()=>{throw new Error('Tab activation failed');};
  const kept=await h.send('keep');assert.equal(kept.ok,false);assert.equal((await h.send('hello')).state.retained,false);
  await h.send('discard');assert.deepEqual(h.removed,[run.id]);
});

test('platform errors are not copied into worker diagnostics', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'why'});await h.settle();
  h.chrome.tabs.update=async()=>{throw new Error('PRIVATE PLATFORM URL OR TOKEN');};
  assert.equal((await h.send('focus')).ok,false);assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE PLATFORM URL OR TOKEN'),false);assert.match(JSON.stringify(h.diagnostics),/COMMAND_FAILED/);
});

test('closed helper diagnostics preserve whether a send could have happened', async t=>{
  const waiting=harness();t.after(waiting.close);const create=waiting.chrome.tabs.create;
  waiting.chrome.tabs.create=async props=>{const tab=await create(props);tab.status='loading';return tab;};
  await waiting.send('ensure');await waiting.send('send',{question:'why'});await waiting.settle();const helper=waiting.calls.find(c=>c.type==='create');
  assert.ok(helper);waiting.chrome.tabs.onRemoved.emit(2,{});await waiting.settle();let snapshot=await waiting.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_CLOSED');assert.equal(snapshot.state.uncertain,false);assert.equal(waiting.calls.filter(c=>c.message?.type==='tmp:run').length,0);
  const dispatched=harness();t.after(dispatched.close);await dispatched.send('ensure');await dispatched.send('send',{question:'why'});await dispatched.settle();const run=dispatched.calls.find(c=>c.message?.type==='tmp:run');
  dispatched.chrome.tabs.onRemoved.emit(run.id,{});await dispatched.settle();snapshot=await dispatched.send('hello');assert.equal(snapshot.state.errorCode,'HELPER_CLOSED');assert.equal(snapshot.state.stage,'helper_closed');assert.equal(snapshot.state.uncertain,true);
});

test('watchdog distinguishes helper setup from an unanswered dispatched request', async t=>{
  for(const dispatched of [false,true]){
    const h=harness({id:'restored',ownerTabId:1,helperTabId:4,requestId:'running',context:{},messages:[],pendingPrompt:'private',stage:dispatched?'response_wait':'agent_ready',status:'starting',dispatched,updatedAt:Date.now()-100000});t.after(h.close);
    h.chrome.alarms.onAlarm.emit({name:'tmp:watchdog'});await h.settle();const snapshot=await h.send('hello');
    assert.equal(snapshot.state.errorCode,dispatched?'REQUEST_HEARTBEAT_TIMEOUT':'HELPER_START_TIMEOUT');assert.equal(snapshot.state.stage,dispatched?'response_wait':'agent_ready');assert.equal(snapshot.state.uncertain,dispatched);assert.equal(JSON.stringify(h.diagnostics).includes('private'),false);
  }
});

test('stop during run delivery cancels after acknowledgement without replaying the question', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');
  let acknowledge;const waiting=new Promise(resolve=>{acknowledge=resolve;});const sendMessage=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);if(message.type==='tmp:run')await waiting;return result;};
  await h.send('send',{question:'why'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');assert.ok(run);
  assert.equal((await h.send('stop')).ok,true);assert.equal((await h.send('hello')).state.status,'stopping');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'submitted'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'stream',delta:'A partial answer'}},run.id);
  assert.equal((await h.send('hello')).state.status,'stopping');assert.equal(h.data['tmp.chat.session'].stopRequested,true);
  acknowledge();await h.settle();
  assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);assert.equal(h.calls.filter(c=>c.message?.type==='tmp:stop').length,2);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:''}},run.id);assert.equal((await h.send('hello')).state.status,'done');
  await h.send('send',{question:'next'});await h.settle();assert.equal((await h.send('hello')).state.stopRequested,false);assert.equal(h.data['tmp.chat.session'].stopRequested,false);
});

test('late run delivery failure cannot fail the next question in the same tangent', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');
  let rejectRun;const waiting=new Promise((resolve,reject)=>{rejectRun=reject;});const sendMessage=h.chrome.tabs.sendMessage;let first=true;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);if(message.type==='tmp:run'&&first){first=false;return waiting;}return result;};
  await h.send('send',{question:'first'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'submitted'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'finished'}},run.id);
  await h.send('send',{question:'second'});await h.settle();const next=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  assert.notEqual(next.message.requestId,run.message.requestId);rejectRun(new Error('Late old transport failure'));await h.settle();
  const snapshot=await h.send('hello');assert.equal(snapshot.state.requestId,next.message.requestId);assert.equal(snapshot.state.status,'sending');assert.equal(snapshot.state.error,'');
});

test('late stop delivery failure cannot overwrite a completed or newer question', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'first'});await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');let rejectStop;const waiting=new Promise((resolve,reject)=>{rejectStop=reject;});const sendMessage=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{const result=await sendMessage(id,message);return message.type==='tmp:stop'?waiting:result;};
  await h.send('stop');await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'stopped'}},run.id);
  await h.send('send',{question:'second'});await h.settle();const next=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  rejectStop(new Error('Late stop transport failure'));await h.settle();
  const snapshot=await h.send('hello');assert.equal(snapshot.state.requestId,next.message.requestId);assert.equal(snapshot.state.status,'sending');assert.equal(snapshot.state.error,'');
});

test('checking a stopped request with a confirmed pre-send failure does not resubmit', async t=>{
  const h=harness();t.after(h.close);await h.send('ensure');await h.send('send',{question:'cancelled'});await h.settle();const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('stop');await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'error',text:'Setup failed before click',attempted:false}},run.id);
  assert.equal((await h.send('check')).ok,true);await h.settle();assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').length,1);
  const snapshot=await h.send('hello');assert.equal(snapshot.state.status,'done');assert.equal(snapshot.state.pendingPrompt,'');
});

test('pre-click cancellation restores the prior submission state for the next question', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'original passage'}});await h.send('send',{question:'cancel this'});await h.settle();
  let run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'submitted'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'',cancelledBeforeSend:true,continuation:false}},run.id);
  assert.equal((await h.send('hello')).state.hasSubmitted,false);
  await h.send('send',{question:'send this instead'});await h.settle();run=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  assert.equal(run.message.continuation,false);assert.match(run.message.prompt,/original passage/);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'submitted'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'answer'}},run.id);
  await h.send('send',{question:'cancel a follow-up'});await h.settle();run=h.calls.filter(c=>c.message?.type==='tmp:run').at(-1);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'done',text:'',cancelledBeforeSend:true,continuation:true}},run.id);
  assert.equal((await h.send('hello')).state.hasSubmitted,true);
  await h.send('send',{question:'another follow-up'});await h.settle();assert.equal(h.calls.filter(c=>c.message?.type==='tmp:run').at(-1).message.continuation,true);
});
test('stream events relay compact patches instead of the complete transcript', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});await h.send('send',{question:'why'});await h.settle();
  const run=h.calls.find(c=>c.message?.type==='tmp:run');
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'stream',delta:'Hello'}},run.id);
  await h.send('event',{sessionId:run.message.sessionId,requestId:run.message.requestId,event:{kind:'stream',delta:' world'}},run.id);
  const patches=h.calls.filter(c=>c.message?.type==='tmp:patch');assert.equal(patches.length,2);assert.equal(patches[1].message.delta,' world');assert.equal(patches[1].message.state,undefined);assert.equal((await h.send('hello')).state.messages[1].text,'Hello world');
});
test('preferences are content-free, remembered locally, and dispatched only to the helper', async t => {
  const h = harness(); t.after(h.close);
  assert.equal((await h.send('hello')).preferences.speed, 'current');
  assert.equal((await h.send('preference', { speed: 'invented-model' })).ok, false);
  const preference = await h.send('preference', { speed: 'instant' });
  assert.equal(preference.ok, true); assert.equal(preference.state, null);
  assert.deepEqual(h.data['tmp.chat.preferences'], { speed: 'instant' });
  assert.equal(h.calls.filter(call => call.type === 'create').length, 0);
  await h.send('ensure');
  assert.equal((await h.send('preference', { speed: 'current' }, 9)).ok, false);
  await h.send('send', { question: 'A short question' }); await h.settle();
  assert.equal(h.calls.find(call => call.message?.type === 'tmp:run').message.speed, 'instant');
  assert.equal((await h.send('preference', { speed: 'current' })).ok, false);
});

test('completed answer notices are sanitized and focus preserves the owned helper', async t => {
  const h = harness(); t.after(h.close);
  await h.send('ensure'); await h.send('send', { question: 'Explain' }); await h.settle();
  const run = h.calls.find(call => call.message?.type === 'tmp:run');
  await h.send('event', { sessionId: run.message.sessionId, requestId: run.message.requestId, event: { kind: 'done', text: '  code\n', notices: ['unsupported', 'truncated', 'unsafe', 'unsupported'] } }, run.id);
  const before = (await h.send('hello')).state;
  assert.deepEqual(Array.from(before.messages.at(-1).notices), ['unsupported', 'truncated']);
  assert.equal(before.messages.at(-1).text, '  code\n');
  await h.send('focus');
  const after = (await h.send('hello')).state;
  assert.equal(after.id, before.id); assert.equal(after.retained, false);
  assert.equal(h.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(h.calls.some(call => call.message?.type === 'tmp:release'), false);
});

test('navigation away from ChatGPT clears session and closes its helper', async t=>{
  const h=harness();t.after(h.close);await h.send('context',{context:{selection:'passage'}});await h.send('send',{question:'why'});await h.settle();
  h.chrome.tabs.onUpdated.emit(1,{url:'https://example.org/'},{});await h.settle();assert.equal(h.removed.length,1);assert.equal((await h.send('hello')).state,null);
});

