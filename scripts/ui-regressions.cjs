/* UI regressions run by browser-smoke.cjs against its offline ChatGPT fixture. */
'use strict';
const assert = require('node:assert/strict');

module.exports = async function uiRegressions({ cdp, source, worker, waitFor, delay }) {
  const panel = `document.getElementById('tmp-chat-root').shadowRoot`;
  const action = `document.getElementById('tmp-chat-selection-root').shadowRoot.querySelector('button')`;
  const evaluate = expression => cdp.evaluate(expression, source);
  const tabId = await cdp.evaluate(`(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(tab=>tab.url==='https://chatgpt.com/c/source')?.id;})()`, worker);
  assert.ok(Number.isInteger(tabId), 'UI regressions need the fixture source tab');
  const baselineTabs = await cdp.evaluate('(async()=> (await chrome.tabs.query({})).length)()', worker);
  const toggle = () => cdp.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'tmp:toggle'})`, worker);
  const hello = async () => (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:async()=>chrome.runtime.sendMessage({type:'tmp:hello'})})`, worker))[0].result;
  const visible = () => evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display!=='none' && !${panel}.querySelector('.card').hidden`);
  const hidden = () => evaluate(`getComputedStyle(document.getElementById('tmp-chat-root')).display==='none'`);
  const selectionOpeningDiagnostic = async stage => {
    const page = await evaluate(`(()=>{const h=document.getElementById('tmp-chat-root'),s=h.shadowRoot,a=${action},r=a.getBoundingClientRect();return {stage:${JSON.stringify('selection-opening')},hostDisplay:getComputedStyle(h).display,cardHidden:s.querySelector('.card').hidden,dockHidden:s.querySelector('.dock').hidden,actionHidden:a.hidden,actionRect:{left:r.left,top:r.top,width:r.width,height:r.height},questionDisabled:s.querySelector('#question').disabled,errorVisible:!s.querySelector('#error').hidden,activeRoot:document.activeElement?.shadowRoot?'shadow':'document'};})()`);
    const isolated = await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:async()=>{const result=await chrome.runtime.sendMessage({type:'tmp:hello'}),state=result.state;return {worker:{ok:result.ok,hasSession:!!state,status:state?.status||'',stage:state?.stage||'',errorCode:state?.errorCode||'',hasHelper:!!state?.hasHelper,messageCount:state?.messages?.length||0},selection:TmpSelection.describe(getSelection(),document),events:(globalThis.__tmpChatDiagnostics||[]).slice(-20)};}})`, worker);
    return { stage, page, isolated: isolated[0]?.result };
  };
  const geometry = () => evaluate(`(()=>{const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};return {thread:rect(document.getElementById('thread')),composer:rect(document.querySelector('.native-composer')),reserved:!!document.querySelector('.tmp-chat-reserve-space'),width:document.documentElement.scrollWidth,viewport:innerWidth};})()`);
  const baseline = await geometry();
  function restored(actual) {
    assert.equal(actual.reserved, false, 'Minimize/close must release reserved space');
    for (const name of ['thread', 'composer']) for (const key of ['left', 'right', 'width']) {
      assert.ok(Math.abs(actual[name][key] - baseline[name][key]) <= 1, `${name}.${key} not restored: ${JSON.stringify(actual)}`);
    }
    assert.ok(actual.width <= actual.viewport, 'UI must not introduce horizontal scrolling');
  }
  let lastClickMetadata = null;
  async function click(expression) {
    const hit = await evaluate(`(()=>{const el=${expression};if(!el)throw Error('Missing click target');const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;let at=document.elementFromPoint(x,y);for(let n=0;at?.shadowRoot&&n<5;n++){const next=at.shadowRoot.elementFromPoint(x,y);if(!next||next===at)break;at=next;}return {x,y,width:r.width,height:r.height,hit:at===el||el.contains(at),disabled:!!el.disabled};})()`);
    assert.ok(hit.width && hit.height && hit.hit && !hit.disabled, `Click target is not reachable: ${expression} ${JSON.stringify(hit)}`);
    lastClickMetadata = { target: expression, ...hit };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y }, source);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1 }, source);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1 }, source);
  }
  async function key(key, code, virtualKeyCode, modifiers = 0, text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers, ...(text ? { text } : {}) }, source);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers }, source);
  }
  async function closeDraft() {
    await click(`${panel}.querySelector('#discard')`);
    await waitFor(() => evaluate(`!${panel}.querySelector('#confirm').hidden`), 'draft close confirmation');
    await click(`${panel}.querySelector('#cancel-discard')`);
    assert.equal(await visible(), true, 'Cancel should preserve the panel');
    await click(`${panel}.querySelector('#discard')`);
    await click(`${panel}.querySelector('#confirm-discard')`);
    await waitFor(hidden, 'draft panel closing');
    assert.equal((await hello()).state, null);
  }

  await toggle();
  await waitFor(visible, 'manual input panel opening');
  assert.deepEqual(await evaluate(`(()=>{const s=${panel};return {inputDisabled:s.querySelector('#question').disabled,copyDisabled:s.querySelector('#copy').disabled,keepDisabled:s.querySelector('#keep').disabled,closeDisabled:s.querySelector('#discard').disabled,sendDisabled:s.querySelector('.send').disabled};})()`), {
    inputDisabled: false, copyDisabled: true, keepDisabled: true, closeDisabled: false, sendDisabled: true
  });
  await click(`${panel}.querySelector('#question')`);
  await cdp.send('Input.insertText', { text: 'Manual question' }, source);
  await key('Enter', 'Enter', 13, 8, '\r'); // Shift+Enter must insert a line, not submit.
  await cdp.send('Input.insertText', { text: 'A second line' }, source);
  const draft = await evaluate(`${panel}.querySelector('#question').value`);
  assert.equal(draft, 'Manual question\nA second line');
  assert.equal(await evaluate(`${panel}.querySelector('.send').disabled`), false);
  assert.equal((await hello()).state.messages.length, 0, 'Typing must not submit a question into the prepared helper');
  if (await evaluate(`!!${panel}.querySelector('#pasted-context')`)) {
    await click(`${panel}.querySelector('#manual-context summary')`);
    await click(`${panel}.querySelector('#pasted-context')`);
    await cdp.send('Input.insertText', { text: 'Pasted context\nwith a second paragraph.' }, source);
    assert.equal(await evaluate(`${panel}.querySelector('#pasted-context').value`), 'Pasted context\nwith a second paragraph.');
  }
  await click(`${panel}.querySelector('#minimize')`);
  await waitFor(() => evaluate(`${panel}.querySelector('.card').hidden && !${panel}.querySelector('.dock').hidden`), 'manual draft minimizing');
  restored(await geometry());
  const dock = await evaluate(`(()=>{const h=document.getElementById('tmp-chat-root'),d=h.shadowRoot.querySelector('.dock');return {width:h.getBoundingClientRect().width,direction:getComputedStyle(d).flexDirection,label:d.querySelector('span').textContent};})()`);
  assert.equal(dock.width, 152); assert.equal(dock.direction, 'row'); assert.equal(dock.label, 'tmp.chat');
  await click(`${panel}.querySelector('.dock')`);
  await waitFor(visible, 'manual draft restoring');
  assert.equal(await evaluate(`${panel}.querySelector('#question').value`), draft);
  assert.equal(await evaluate(`${panel}.activeElement?.id`), 'question');
  if (await evaluate(`!!${panel}.querySelector('#pasted-context')`)) assert.equal(await evaluate(`${panel}.querySelector('#pasted-context').value`), 'Pasted context\nwith a second paragraph.');
  await closeDraft(); restored(await geometry());
  await toggle(); await waitFor(visible, 'empty panel opening');
  await click(`${panel}.querySelector('#discard')`);
  await waitFor(hidden, 'empty panel closing without confirmation');
  console.log('PASS real pointer/keyboard input, multiline paste, draft minimize/restore, close/cancel, and empty controls');

  // The browser's Range can disappear before a document pointer-up listener or
  // a debounced selectionchange callback runs. Preserve the actual selection
  // at event time, rather than reading it only after the native handler clears.
  await evaluate(`(()=>{const p=document.getElementById('select-me'),r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));window.addEventListener('pointerup',()=>getSelection().removeAllRanges(),{capture:true,once:true});p.dispatchEvent(new PointerEvent('pointerup',{button:0,bubbles:true}));})()`);
  await waitFor(() => evaluate(`!${action}.hidden`), 'selection captured before native window handler clears it', 3000);
  assert.equal(await evaluate('getSelection().isCollapsed'), true);
  await click(action);
  const fastClickMetadata = lastClickMetadata;
  try {
    await waitFor(visible, 'fast-captured selection opening');
  } catch (error) {
    console.error('UI selection opening diagnostic:', JSON.stringify({ fastClickMetadata, afterFastClick: await selectionOpeningDiagnostic('after-fast-click') }));
    throw error;
  }
  assert.match(await evaluate(`${panel}.querySelector('.context-quote').textContent`), /Each token creates/);
  await click(`${panel}.querySelector('#discard')`);
  await waitFor(hidden, 'empty selected tangent cleanup');
  assert.equal((await hello()).state, null);
  console.log('PASS selectionchange snapshot survives immediate native window-capture selection clearing');

  // Reproduce a native selection toolbar whose pointer-up handler collapses
  // selection after the extension has observed it. Its element is deliberately
  // unstyled by the fixture so the extension must coexist with it.
  await evaluate(`(()=>{const show=()=>{const s=getSelection();if(!s?.rangeCount||s.isCollapsed)return;const r=s.getRangeAt(0).getBoundingClientRect();let b=document.getElementById('native-selection-action');if(!b){b=document.createElement('button');b.id='native-selection-action';b.textContent='Ask ChatGPT';document.body.append(b);}b.style.cssText='position:fixed;z-index:99999;box-sizing:border-box;width:136px;height:34px;background:white;border:1px solid #888;border-radius:8px;left:'+Math.max(8,r.right-120)+'px;top:'+(r.bottom+9)+'px';};const clear=()=>{if(document.getElementById('native-selection-action'))getSelection().removeAllRanges();};window.__tmpUiNative={show,clear};document.addEventListener('selectionchange',show);document.addEventListener('pointerup',clear);})()`);
  const drag = await evaluate(`(()=>{const t=document.getElementById('select-me').firstChild;const a=document.createRange(),b=document.createRange();a.setStart(t,0);a.setEnd(t,1);b.setStart(t,24);b.setEnd(t,25);const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();const describe=e=>e?{tag:e.tagName,id:e.id,role:e.getAttribute('data-message-author-role')}:null;return {x1:x.left+1,y1:x.top+x.height/2,x2:y.right-1,y2:y.top+y.height/2,startHit:describe(document.elementFromPoint(x.left+1,x.top+x.height/2)),endHit:describe(document.elementFromPoint(y.right-1,y.top+y.height/2))};})()`);
  const dragDiagnostic = async stage => {
    const page = await evaluate(`(()=>{const s=getSelection(),a=${action},n=document.getElementById('native-selection-action');const describe=node=>{const e=node?.nodeType===1?node:node?.parentElement;return e?{tag:e.tagName,id:e.id,role:e.getAttribute('data-message-author-role'),root:e.getRootNode()===document?'document':'shadow'}:null;};return {rangeCount:s.rangeCount,collapsed:s.isCollapsed,selectedChars:s.toString().length,start:describe(s.rangeCount?s.getRangeAt(0).startContainer:null),end:describe(s.rangeCount?s.getRangeAt(0).endContainer:null),actionHidden:a.hidden,nativeExists:!!n,active:describe(document.activeElement),scroll:{document:scrollY,main:document.querySelector('main').scrollTop},pointerEvents:getComputedStyle(document.getElementById('select-me')).pointerEvents,userSelect:getComputedStyle(document.getElementById('select-me')).userSelect};})()`);
    const isolated = await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{const s=getSelection(),r=TmpSelection.detect(s,document);return {detection:{ok:r.ok,reason:r.reason,strategy:r.strategy,selectedChars:r.context?.selection.length||0},structure:TmpSelection.describe(s,document),events:(globalThis.__tmpChatDiagnostics||[]).slice(-16)};}})`, worker);
    return { stage, drag, page, isolated: isolated[0]?.result };
  };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1, y: drag.y1 }, source);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x1, y: drag.y1, button: 'left', buttons: 1, clickCount: 1 }, source);
  await delay(50);
  for (let n = 1; n <= 6; n++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1 + (drag.x2 - drag.x1) * n / 6, y: drag.y1 + (drag.y2 - drag.y1) * n / 6, button: 'left', buttons: 1 }, source);
    await delay(20);
  }
  await delay(80);
  const beforeRelease = await dragDiagnostic('before-release');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x2, y: drag.y2, button: 'left', buttons: 0, clickCount: 1 }, source);
  try {
    await waitFor(() => evaluate(`!${action}.hidden && !!document.getElementById('native-selection-action')`), 'real drag selection action', 5000);
  } catch (error) {
    console.error('UI drag diagnostic:', JSON.stringify({ beforeRelease, afterRelease: await dragDiagnostic('after-release') }));
    throw error;
  }
  await delay(100);
  assert.equal(await evaluate('getSelection().isCollapsed'), true, 'Fixture native toolbar must collapse the browser selection');
  assert.equal(await evaluate(`(()=>{const a=${action}.getBoundingClientRect(),b=document.getElementById('native-selection-action').getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;})()`), false, 'Selection actions should not cover each other');
  await click(action);
  await waitFor(visible, 'pointer selection opening');
  assert.match(await evaluate(`${panel}.querySelector('.context-quote').textContent`), /Each token creates/);
  assert.equal(await evaluate(`${panel}.querySelector('#question').disabled`), false);
  assert.equal(await evaluate(`${panel}.activeElement?.id`), 'question');
  await cdp.send('Input.insertText', { text: 'A question about the selected passage' }, source);
  assert.equal(await evaluate(`${panel}.querySelector('.send').disabled`), false);
  await closeDraft(); restored(await geometry());
  await evaluate(`(()=>{const n=window.__tmpUiNative;document.removeEventListener('selectionchange',n.show);document.removeEventListener('pointerup',n.clear);delete window.__tmpUiNative;document.getElementById('native-selection-action')?.remove();getSelection().removeAllRanges();})()`);
  console.log('PASS actual mouse selection, native toolbar coexistence, retained pointer-up context, and focused input');

  const originalHTML = await evaluate('document.querySelector("main .text").innerHTML');
  async function select(code) {
    await evaluate(`(()=>{const r=document.createRange();${code};const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
    const result = await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{const r=TmpSelection.detect(getSelection(),document);return {ok:r.ok,reason:r.reason,strategy:r.strategy,context:r.context};}})`, worker);
    return result[0].result;
  }
  try {
    await evaluate(`document.querySelector('main .text').innerHTML='<div data-message-author-role="user">Original fixture question</div><article id="turn-a" data-message-author-role="assistant"><div class="markdown"><p id="first">First neighborhood: <strong>repeated phrase</strong> OLD NEIGHBOR.</p><p id="distance">'+('separator '.repeat(500))+'</p><p id="last">NEW NEIGHBOR: <strong id="nested">repeated <em>phrase</em></strong> correct nearby ending.</p></div></article><article id="turn-b" data-message-author-role="assistant"><div class="markdown"><p>Another response.</p></div></article><article id="turn-user" data-turn="user"><div class="markdown">User prose must not become an assistant.</div></article><div id="test-composer" contenteditable="true">Composer text</div>'`);
    let result = await select(`r.selectNode(document.getElementById('nested'))`);
    assert.equal(result.ok, true); assert.equal(result.context.selection, 'repeated phrase');
    assert.match(result.context.nearby, /NEW NEIGHBOR/); assert.doesNotMatch(result.context.nearby, /OLD NEIGHBOR/);
    assert.equal(result.context.prompt, 'Original fixture question');
    result = await select(`r.selectNode(document.getElementById('turn-a'))`);
    assert.equal(result.ok, true, 'Parent-element Range boundaries should resolve assistant text');
    result = await select(`const u=document.querySelector('[data-message-author-role="user"]').firstChild;r.setStart(u,u.length);r.setEnd(document.querySelector('#first').firstChild,18)`);
    assert.equal(result.ok, true, 'A zero-width start in the preceding user text is not selected user content');
    result = await select(`r.setStart(document.querySelector('#last').firstChild,0);r.setEnd(document.querySelector('#turn-b p').firstChild,0)`);
    assert.equal(result.ok, true, 'A zero-width end in the next assistant is not a cross-message selection');
    await evaluate(`(()=>{const t=document.getElementById('nested').firstChild,s=getSelection();s.removeAllRanges();s.setBaseAndExtent(t,t.length,t,0);})()`);
    const backwards = await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{const r=TmpSelection.detect(getSelection(),document);return {ok:r.ok,selection:r.context?.selection};}})`, worker);
    assert.equal(backwards[0].result.ok, true); assert.equal(backwards[0].result.selection, 'repeated');
    result = await select(`r.setStart(document.querySelector('#first').firstChild,0);r.setEnd(document.querySelector('#turn-b p').firstChild,8)`);
    assert.equal(result.ok, false); assert.equal(result.reason, 'cross-message');
    result = await select(`r.selectNodeContents(document.querySelector('#turn-user .markdown'))`);
    assert.equal(result.ok, false, 'User prose must be rejected');
    result = await select(`r.selectNodeContents(document.getElementById('test-composer'))`);
    assert.equal(result.ok, false, 'Composer text must be rejected');
    await evaluate(`(()=>{const a=document.getElementById('turn-a');a.removeAttribute('data-message-author-role');a.setAttribute('data-turn','assistant');a.setAttribute('data-testid','conversation-turn-2');})()`);
    result = await select(`r.selectNodeContents(document.getElementById('nested'))`);
    assert.equal(result.ok, true); assert.equal(result.strategy, 'turn-marker');
    await evaluate(`document.getElementById('turn-a').removeAttribute('data-turn')`);
    result = await select(`r.selectNodeContents(document.getElementById('nested'))`);
    assert.equal(result.ok, true); assert.equal(result.strategy, 'prose-fallback');
    await evaluate(`document.getElementById('turn-a').insertAdjacentHTML('afterbegin','<h5 class="sr-only">You said:</h5>')`);
    result = await select(`r.selectNodeContents(document.getElementById('nested'))`);
    assert.equal(result.ok, false, 'Role-less user heading must override prose fallback');
    const shadowResult = await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{const t=document.getElementById('tmp-chat-root').shadowRoot.querySelector('.brand').firstChild;const r=document.createRange();r.selectNodeContents(t);const selection={isCollapsed:false,rangeCount:1,getRangeAt:()=>r,toString:()=>t.data};const found=TmpSelection.detect(selection,document);return {ok:found.ok,reason:found.reason};}})`, worker);
    assert.equal(shadowResult[0].result.ok, false); assert.equal(shadowResult[0].result.reason, 'outside-document');

    // This hierarchy follows observed live metadata: a shared native turn holds
    // BOTH speakers. Only the assistant search unit owns the rendered answer;
    // the outer turn cannot safely serve as an assistant-message boundary.
    await evaluate(`document.querySelector('main .text').innerHTML='<div data-talvt-turn-state><div><div id="native-user"><h4 data-conversation-role="user">You said:</h4><div id="native-question">A native rendered question.</div></div><div><div id="native-unit" data-content-search-unit-key data-chatgpt-search-unit-key data-chatgpt-search-message-ids><h4 data-conversation-role="assistant" tabindex="-1">ChatGPT said:</h4><div data-chatgpt-selection-conversation-id data-chatgpt-selection-message-id><div data-selected-text-overlay-target data-markdown-text-style><div id="native-source" data-dil-source-message-id data-chatgpt-copy-reference data-markdown-copy><div data-theme><div data-dil-message-id><p id="native-answer" data-d-text-flow data-d-component>A native rendered answer with <strong id="native-nested">nested response text</strong> and nearby explanation.</p></div></div></div></div></div><button>Copy</button></div></div></div></div>'`);
    result = await select(`r.selectNodeContents(document.getElementById('native-nested'))`);
    assert.equal(result.ok, true); assert.equal(result.strategy, 'native-renderer');
    assert.equal(result.context.selection, 'nested response text');
    assert.match(result.context.nearby, /nearby explanation/);
    assert.match(result.context.prompt, /A native rendered question/);
    assert.doesNotMatch(result.context.nearby, /A native rendered question|ChatGPT said|Copy/);
    let roots = (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>({assistants:TmpSelection.assistantRoots(document).map(node=>node.id),users:TmpSelection.userRoots(document).map(node=>node.id)})})`, worker))[0].result;
    assert.deepEqual(roots, { assistants: ['native-source'], users: ['native-user'] });
    result = await select(`r.selectNodeContents(document.getElementById('native-question'))`);
    assert.equal(result.ok, false, 'The user inside a shared native turn must be rejected');
    result = await select(`r.selectNodeContents(document.querySelector('#native-unit h4'))`);
    assert.equal(result.ok, false, 'Native speaker headings are UI, not response context');
    result = await select(`r.setStart(document.getElementById('native-question').firstChild,0);r.setEnd(document.getElementById('native-answer').firstChild,8)`);
    assert.equal(result.ok, false, 'Selecting across both speakers in one native turn must be rejected');
    await evaluate(`document.querySelector('#native-unit h4').setAttribute('data-conversation-role','user')`);
    result = await select(`r.selectNodeContents(document.getElementById('native-nested'))`);
    assert.equal(result.ok, false, 'Native copy metadata alone cannot establish an assistant');
    await evaluate(`document.querySelector('#native-unit h4').setAttribute('data-conversation-role','assistant');document.getElementById('native-source').removeAttribute('data-chatgpt-copy-reference')`);
    result = await select(`r.selectNodeContents(document.getElementById('native-nested'))`);
    assert.equal(result.ok, false, 'An unknown renderer must not be accepted from a heading alone');
    roots = (await cdp.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>({count:TmpSelection.assistantRoots(document).length})})`, worker))[0].result;
    assert.equal(roots.count, 0);
    console.log('PASS observed native renderer metadata, bounded assistant sources, shared-turn user rejection, and speaker-aware roots');
  } finally {
    await evaluate(`document.querySelector('main .text').innerHTML=${JSON.stringify(originalHTML)};getSelection().removeAllRanges();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  }
  await delay(100);
  assert.equal((await hello()).state, null);
  assert.equal(await hidden(), true);
  restored(await geometry());
  assert.equal(await cdp.evaluate('(async()=> (await chrome.tabs.query({})).length)()', worker), baselineTabs, 'Closing UI-only tangents must clean up prepared helpers');
  console.log('PASS nested/parent-boundary selections, repeated-text context, alternate markers, and user/cross-turn/shadow rejection');
};
