'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/core.js');
const answerAdapter = require('../lib/answer.js');

function harness(options = {}) {
  const state = { composer: true, temporary: true, nativeSaveChat: false, nativeSaveChatScope: 'main-header', sendEnabled: true, stop: false, userCount: 0, clicks: 0, stops: 0, editor: 'textarea', hiddenFallback: false, temporaryChoice: false, temporaryClicks: 0, dialog: false, choiceClicks: 0, acknowledgeSend: true, startStreaming: true, auth: false, alert: '', ...options };
  const events = [], stages = [], diagnostics = [], observers = new Set(), timers = new Map(); let listener, nextTimer = 1, activeElement = null, now = 100000;
  class Element {
    constructor(tagName = 'DIV', attributes = {}, text = '') { this.nodeType = 1; this.tagName = tagName; this.attributes = attributes; this.hidden = false; this.draft = text; this.childNodes = []; this.parentElement = null; this.isConnected = true; }
    get innerText() { return this.draft; }
    set innerText(value) { this.draft = value; }
    get textContent() { return this.draft; }
    set textContent(value) { this.draft = value; }
    get id() { return this.attributes.id || ''; }
    get isContentEditable() { return this.attributes.contenteditable === 'true'; }
    getClientRects() { return this.hidden ? [] : [{ width: 100, height: 40 }]; }
    getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 40 }; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    hasAttribute(name) { return name in this.attributes; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.childNodes.push(node); } }
    contains(node) { return node === this || this.childNodes.some(child => child.contains?.(node)); }
    closest(selector) {
      if (/^\[data-/.test(selector)) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
      return selector.startsWith('form,') && state.effortControl ? effortScope : selector.includes('dialog') && state.dialog ? dialog : null;
    }
    matches(selector) {
      if (/^\[data-/.test(selector)) return selector.split(',').some(part => {
        const attributes = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
        return attributes.length && attributes.every(([, name, value]) => this.hasAttribute(name) && (value === undefined || this.getAttribute(name) === value));
      });
      return selector.includes('textarea') ? this.tagName === 'TEXTAREA' : selector.includes('contenteditable') ? this.isContentEditable : false;
    }
    querySelectorAll(selector) {
      // Native identity metadata belongs to this message, not the whole fake
      // page. Other selectors retain the existing stage/composer fixture model.
      if (/^\[data-/.test(selector)) return this.childNodes.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
      return this === dialog ? choices : select(selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    dispatchEvent() {}
    focus() { activeElement = this; }
    click() {}
  }
  class TextArea extends Element {
    constructor(attributes = {}) { super('TEXTAREA', attributes); }
    get value() { return this.draft; }
    set value(value) { this.draft = value; }
  }
  const makeBox = () => state.editor === 'contenteditable' ? new Element('DIV', { contenteditable: 'true', role: 'textbox', class: 'ProseMirror' }) : new TextArea({ id: 'prompt-textarea' });
  let box = makeBox(); const initialBox = box;
  const fallback = new TextArea({ id: 'prompt-textarea', 'aria-hidden': 'true' }); fallback.hidden = true;
  const main = new Element('MAIN');
  const answer = new Element('DIV', { 'data-message-author-role': 'assistant' });
  Object.defineProperty(answer, 'innerText', { get: () => state.answerText || '' });
  const marker = new Element('H1', { 'data-testid': 'temporary-chat-header' }, 'Temporary Chat');
  const saveChatButton = new Element('BUTTON', { 'aria-label': 'Save chat' }, 'Save chat');
  const sendButton = new Element('BUTTON', state.simpleSendLabel ? { 'aria-label': 'Send' } : { 'data-testid': 'send-button', 'aria-label': 'Send prompt' }, 'Send');
  Object.defineProperty(sendButton, 'disabled', { get: () => !state.sendEnabled });
  sendButton.click = () => { state.clicks++; state.sentDraft = box.draft; if (state.acknowledgeSend) { state.userCount++; state.stop = state.startStreaming; box.draft = ''; } };
  const stopButton = new Element('BUTTON', { 'data-testid': 'stop-button', 'aria-label': 'Stop generating' });
  stopButton.click = () => { state.stops++; state.stop = false; };
  const temporaryButton = new Element('BUTTON', { 'data-testid': 'temporary-chat-button' }, 'Temporary');
  temporaryButton.getAttribute = name => name === 'aria-label' ? state.temporary ? 'Turn off temporary chat' : 'Turn on temporary chat' : name === 'aria-pressed' ? String(state.temporary) : temporaryButton.attributes[name] ?? null;
  temporaryButton.click = () => { state.temporaryClicks++; state.temporary = true; if (state.remountOnTemporary) { box.isConnected = false; box = makeBox(); } };
  const dialog = new Element('DIV', { role: 'dialog', 'aria-modal': 'true' }, 'Start a Temporary Chat. Choose Personalized or Unpersonalized.');
  const choices = ['Personalized', 'Unpersonalized'].map(text => { const choice = new Element('BUTTON', {}, text); choice.click = () => { state.choiceClicks++; state.dialog = false; }; return choice; });
  const login = new Element('BUTTON', {}, 'Log in');
  const effortScope = new Element('FORM');
  const effortButton = new Element('BUTTON', { 'aria-haspopup': 'menu' });
  Object.defineProperty(effortButton, 'textContent', { get: () => state.effort || 'High' });
  effortButton.getAttribute = name => name === 'aria-expanded' ? String(!!state.effortMenu) : effortButton.attributes[name] ?? null;
  effortButton.click = () => { state.effortClicks = (state.effortClicks || 0) + 1; state.effortMenu = !state.effortMenu; };
  effortScope.querySelectorAll = () => [effortButton];
  const effortMenu = new Element('DIV', { role: 'menu' });
  const instantOption = new Element('DIV', { role: 'menuitemradio' }, 'Instant');
  instantOption.click = () => { state.instantClicks = (state.instantClicks || 0) + 1; state.effortMenu = false; if (state.verifyInstant !== false) state.effort = 'Instant'; };
  effortMenu.querySelectorAll = () => state.instantAvailable === false ? [] : [instantOption];
  const userNodes = [];
  function nativeUsers() {
    if (state.deferredUserDOM && state.answerText === undefined) return [];
    if (state.userRoots) return state.userRoots;
    if (state.remountUserAtAnswer && state.answerText !== undefined && !state.userDOMRemounts) {
      for (const node of userNodes) node.isConnected = false;
      userNodes.length = 0; state.userDOMRemounts = 1;
    }
    while (userNodes.length < state.userCount) userNodes.push(new Element('DIV', state.nativeConversationId ? { 'data-chatgpt-selection-conversation-id': state.nativeConversationId } : {}));
    userNodes.length = state.userCount;
    return userNodes;
  }
  function select(selector) {
    if (selector.includes('[role="menu"]')) return state.effortMenu && state.menuMounted !== false ? [effortMenu] : [];
    if (selector.includes('data-message-author-role="user"')) return state.sharedRoots ? [] : nativeUsers();
    if (selector.includes('data-message-author-role="assistant"')) return state.answerRoots || (state.sharedRoots || state.answerText === undefined ? [] : [answer]);
    if (selector.includes('role="alert"') || selector.includes('error-message')) return state.alert ? [new Element('DIV', { role: 'alert' }, state.alert)] : [];
    if (selector.includes('role="dialog"') || selector.includes('aria-modal')) return state.dialog ? [dialog] : [];
    if (selector.includes('button[aria-label="Save chat"]')) {
      const matchesScope = selector.split(',').some(part => {
        part = part.trim();
        if (part === 'button[aria-label="Save chat"]') return true;
        if (part === 'main header button[aria-label="Save chat"]') return state.nativeSaveChatScope === 'main-header';
        if (part === 'header button[aria-label="Save chat"]') return ['main-header', 'outside-header'].includes(state.nativeSaveChatScope);
        if (part === '[role="banner"] button[aria-label="Save chat"]' || part === 'main [role="banner"] button[aria-label="Save chat"]') return state.nativeSaveChatScope === 'banner';
        return false;
      });
      return state.nativeSaveChat && matchesScope ? [saveChatButton] : [];
    }
    if (selector.includes('temporary-chat-header') || selector.includes('temporary-chat-banner') || selector.includes('Turn off temporary chat')) return state.temporary ? [marker] : [];
    if (selector.includes('temporary-chat-button') || selector.includes('Turn on temporary chat')) return state.temporaryChoice ? [temporaryButton] : [];
    if (state.simpleSendLabel ? selector.includes('button[aria-label="Send"]') : selector.includes('send-button') || selector.includes('Send prompt') || selector.includes('Send message')) return [sendButton];
    if (selector.includes('stop-button') || selector.includes('Stop generating') || selector.includes('Stop streaming')) return state.stop ? [stopButton] : [];
    if (selector.includes('prompt-textarea') || selector.includes('contenteditable') || selector.includes('ProseMirror') || selector.includes('textarea')) return state.composer ? [...(state.hiddenFallback ? [fallback] : []), box] : [];
    if (selector.includes(' h1') || selector.includes(' h2') || selector.includes('role="heading"')) return state.temporary ? [marker] : [];
    if (selector === 'main') return [main];
    if (selector === 'button' || selector.includes('button,') || selector.includes('button[') || selector === 'button,a') return [sendButton, ...(state.stop ? [stopButton] : []), ...(state.temporaryChoice ? [temporaryButton] : []), ...(state.dialog ? choices : []), ...(state.auth ? [login] : [])];
    return [];
  }
  const document = {
    documentElement: new Element('HTML'), body: main, readyState: 'complete',
    querySelectorAll: select, querySelector: selector => select(selector)[0] || null,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command, ui, value) { if (!activeElement) return false; activeElement.draft = command === 'delete' ? '' : value; return true; }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { this.target = target; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const setTimer = (callback, delay, interval = false) => { const id = nextTimer++; timers.set(id, { callback, delay, due: now + delay, interval }); return id; };
  const chrome = { runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) { if (!message.event) return { ok: true }; (message.event.kind === 'stage' ? stages : events).push(structuredClone(message.event)); if (message.event.kind === 'submitted' && state.acknowledge) await state.acknowledge; return { ok: true }; } } };
  const context = vm.createContext({ TmpCore: core, URLSearchParams, Date: class extends Date { static now() { return now; } }, performance: { now: () => now }, chrome, document, MutationObserver, HTMLElement: Element, HTMLTextAreaElement: TextArea, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, Event: class Event {}, InputEvent: class InputEvent {}, getSelection: () => ({ removeAllRanges() {}, addRange() {} }), getComputedStyle: element => ({ visibility: 'visible', display: element?.hidden ? 'none' : 'block' }), location: { pathname: '/', search: '?temporary-chat=true', hash: '#tmp-chat-helper' }, history: { replaceState() {} }, console: { debug: (...args) => diagnostics.push(args) }, setTimeout: (fn, delay) => setTimer(fn, delay), clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: id => timers.delete(id) });
  if (state.identities || state.realIdentities) context.TmpAnswer = { roots: () => state.answerRoots || [], identity: state.realIdentities ? answerAdapter.identity : node => node.getAttribute('data-message-id') || '', snapshot: node => ({ text: node.innerText, tree: [] }) };
  if (state.sharedRoots) context.TmpSelection = { assistantRoots: () => state.answerText === undefined ? [] : [answer], userRoots: nativeUsers };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../agent.js'), 'utf8'), context);
  const send = (type, payload = {}) => new Promise(resolve => listener({ type: `tmp:${type}`, ...payload }, { id: chrome.runtime.id }, resolve));
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const mutate = () => { for (const observer of [...observers]) observer.callback(); };
  const fire = delay => { for (const [id, timer] of [...timers]) if (timer.delay <= delay && timers.has(id)) { if (!timer.interval) timers.delete(id); timer.callback(); } };
  const advance = (elapsed, fireTimers = true) => {
    const end = now + elapsed;
    if (fireTimers) for (let count = 0; count < 10000; count++) {
      const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next; now = Math.max(now, timer.due);
      if (timer.interval) timer.due = now + timer.delay; else timers.delete(id);
      timer.callback();
      if (count === 9999) throw Error('Fake clock runaway');
    }
    now = end;
  };
  const run = (requestId = 'request-1', continuation = false, speed = 'current') => send('run', { sessionId: 'session', requestId, prompt: 'PRIVATE CONTEXT AND QUESTION', continuation, speed });
  return { state, events, stages, diagnostics, get box() { return box; }, initialBox, fallback, document, location: context.location, send, settle, mutate, fire, advance, run, timers, observers, answer, Element, chrome };
}

async function finishFirstAnswer(h) {
  await h.run(); await h.settle();
  h.state.answerText = 'Earlier answer'; h.mutate(); await h.settle();
  h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
}

async function finishNativeIdentityAnswer(h, attributes = {}, remountUser = true) {
  await h.run(); await h.settle();
  const node = new h.Element('DIV', { 'data-content-search-unit-key': 'retained-render-unit', ...attributes }, 'Earlier answer');
  const message = new h.Element('DIV', { 'data-chatgpt-selection-message-id': 'retained-native-message' });
  node.append(message); h.state.answerRoots = [node]; h.mutate(); await h.settle();
  h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
  // The unkeyed user wrapper can be replaced by React independently of the
  // accepted assistant message. It must not accidentally mask an identity bug.
  if (remountUser) h.state.userRoots = [new h.Element('DIV')];
  return { node, message };
}

for (const remount of [false, true]) for (const metadata of ['data-chatgpt-search-message-ids', 'data-message-id']) {
  test(`follow-up preserves native message identity after additive ${metadata} enrichment${remount ? ' and wrapper remount' : ''}`, async () => {
    const h = harness({ realIdentities: true });
    const { node } = await finishNativeIdentityAnswer(h);
    const originalIdentity = answerAdapter.identity(node);
    let live = node;
    if (remount) {
      node.isConnected = false;
      live = new h.Element('DIV', { ...node.attributes }, node.innerText);
      live.append(new h.Element('DIV', { 'data-chatgpt-selection-message-id': 'retained-native-message' }));
      h.state.answerRoots = [live];
    }
    live.setAttribute(metadata, 'retained-native-message');
    assert.notEqual(answerAdapter.identity(live), originalIdentity, 'Real adapter priority changes despite retained native message metadata');
    await h.run('request-2', true); await h.settle();
    assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
    assert.equal(h.state.clicks, 2, 'One follow-up is sent into the retained logical conversation');
    assert.equal(JSON.stringify(h.diagnostics).includes('retained-native-message'), false);
  });
}

for (const namespace of ['data-message-id', 'data-chatgpt-selection-message-id']) {
  test(`a contradictory ${namespace} blocks continuation despite a retained rendering unit`, async () => {
    const h = harness({ realIdentities: true });
    const { node, message } = await finishNativeIdentityAnswer(h, namespace === 'data-message-id' ? { 'data-message-id': 'retained-native-message' } : {});
    (namespace === 'data-message-id' ? node : message).setAttribute(namespace, 'different-native-message');
    await h.run('request-2', true); await h.settle();
    const error = h.events.at(-1);
    assert.equal(error.code, 'CONVERSATION_CHANGED'); assert.equal(error.attempted, false);
    assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '', 'Identity rejection happens before native draft insertion');
    assert.equal(JSON.stringify(h.diagnostics).includes('different-native-message'), false);
  });
}

for (const remount of [false, true]) test(`a surviving user anchor cannot mask a contradictory assistant message${remount ? ' after wrapper remount' : ''}`, async () => {
  const h = harness({ realIdentities: true });
  const { node, message } = await finishNativeIdentityAnswer(h, {}, false);
  let liveMessage = message;
  if (remount) {
    node.isConnected = false;
    const replacement = new h.Element('DIV', { ...node.attributes }, node.innerText);
    liveMessage = new h.Element('DIV', { ...message.attributes });
    replacement.append(liveMessage); h.state.answerRoots = [replacement];
  }
  liveMessage.setAttribute('data-chatgpt-selection-message-id', 'different-native-message');
  await h.run('request-2', true); await h.settle();
  const error = h.events.at(-1);
  assert.equal(error.code, 'CONVERSATION_CHANGED'); assert.equal(error.attempted, false);
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '', 'A matching user pointer does not authorize a contradictory assistant');
});

test('a native identity conflict while awaiting Send readiness fails closed before recording an attempt', async () => {
  const h = harness({ realIdentities: true });
  const { node } = await finishNativeIdentityAnswer(h, { 'data-message-id': 'retained-native-message' });
  h.state.sendEnabled = false;
  const submissions = h.events.filter(event => event.kind === 'submitted').length;
  await h.run('request-2', true); await h.settle();
  assert.equal(h.box.value, 'PRIVATE CONTEXT AND QUESTION');
  assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false, 'The original proof was accepted before waiting');
  node.setAttribute('data-message-id', 'different-native-message');
  h.state.sendEnabled = true; h.mutate(); await h.settle();
  const error = h.events.at(-1);
  assert.equal(error.code, 'CONVERSATION_CHANGED'); assert.equal(error.attempted, false);
  assert.equal(h.events.filter(event => event.kind === 'submitted').length, submissions);
  assert.equal(h.state.clicks, 1, 'Only the first question was submitted');
});

test('native continuity rejection diagnostics and probes contain only structural metadata', async () => {
  const h = harness({ realIdentities: true });
  const { node } = await finishNativeIdentityAnswer(h, { 'data-message-id': 'retained-native-message' });
  node.setAttribute('data-message-id', 'different-native-message');
  await h.run('request-2', true); await h.settle();
  const rejected = h.diagnostics.filter(entry => entry[1] === 'conversation:rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0][2].reason, /^[a-z-]+$/, 'The reason is a fixed diagnostic category');
  const probe = await h.send('probe');
  const observed = JSON.stringify({ diagnostics: h.diagnostics, probe, events: h.events.filter(event => event.kind === 'error') });
  for (const privateValue of ['retained-render-unit', 'retained-native-message', 'different-native-message', 'Earlier answer', 'PRIVATE CONTEXT AND QUESTION']) assert.equal(observed.includes(privateValue), false);
});

test('follow-up survives query normalization after the first submission was recorded', async () => {
  const h = harness(); await finishFirstAnswer(h);
  h.location.search = '?model=fixture';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.state.clicks, 2);
  assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
});

test('follow-up adopts a canonical conversation route only with matching native identity', async () => {
  const h = harness(); h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'native-conversation');
  await finishFirstAnswer(h);
  h.location.pathname = '/c/native-conversation'; h.location.search = '';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.state.clicks, 2);
  assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
  assert.equal(JSON.stringify(h.diagnostics).includes('native-conversation'), false);
});

for (const scope of ['main-header', 'banner']) test(`canonical temporary continuation recognizes native Save chat in ${scope}`, async () => {
  const h = harness(); h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'native-conversation');
  await finishFirstAnswer(h);
  h.state.temporary = false; h.state.nativeSaveChat = true; h.state.nativeSaveChatScope = scope;
  h.location.pathname = '/c/native-conversation'; h.location.search = '?temporary-chat=true';
  const probe = await h.send('probe'); assert.equal(probe.probe.temporary, true);
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
  assert.equal(h.state.clicks, 2);
});

for (const [description, scope, pathname, search] of [
  ['inside a message', 'message', '/c/native-conversation', '?temporary-chat=true'],
  ['inside the composer', 'composer', '/c/native-conversation', '?temporary-chat=true'],
  ['inside an unrelated header', 'outside-header', '/c/native-conversation', '?temporary-chat=true'],
  ['without the temporary URL flag', 'main-header', '/c/native-conversation', ''],
  ['with an explicit false temporary flag', 'main-header', '/c/native-conversation', '?temporary-chat=false'],
  ['with a non-true temporary flag', 'main-header', '/c/native-conversation', '?temporary-chat=1'],
  ['without a canonical conversation route', 'main-header', '/', '?temporary-chat=true']
]) test(`Save chat ${description} does not prove Temporary Chat`, async () => {
  const h = harness(); h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'native-conversation');
  await finishFirstAnswer(h);
  h.state.temporary = false; h.state.nativeSaveChat = true; h.state.nativeSaveChatScope = scope;
  h.location.pathname = pathname; h.location.search = search;
  const probe = await h.send('probe'); assert.equal(probe.probe.temporary, false);
  if (pathname !== '/') {
    await h.run('request-2', true); await h.settle();
    assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED');
    assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
  }
});

for (const missing of ['native-identity', 'previous-messages', 'matching-native-route']) test(`native Save chat cannot authorize canonical continuation without ${missing}`, async () => {
  const h = harness();
  if (missing !== 'native-identity') h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'native-conversation');
  await finishFirstAnswer(h);
  h.state.temporary = false; h.state.nativeSaveChat = true;
  h.location.pathname = missing === 'matching-native-route' ? '/c/different-conversation' : '/c/native-conversation';
  h.location.search = '?temporary-chat=true';
  if (missing === 'previous-messages') { h.state.answerText = undefined; h.state.userCount = 0; }
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, false);
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

async function finishWithOpaqueCanonicalIdentity(h, condition = 'verified') {
  if (condition !== 'missing-native-id') h.state.nativeConversationId = 'opaque-conversation-identity';
  await h.run(); await h.settle();
  if (h.state.deferredUserDOM) {
    assert.equal(h.state.userCount, 1, 'Native submission was acknowledged');
    assert.equal(h.state.stop, true, 'The native Stop control appears before message roots');
    assert.equal(h.document.querySelectorAll('[data-message-author-role="user"]').length, 0, 'Acknowledgement does not imply a mounted native user message');
  }
  h.answer.setAttribute('data-message-id', 'retained-native-message');
  if (condition !== 'missing-native-id') h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'opaque-conversation-identity');
  h.state.answerText = 'Earlier answer'; h.mutate(); await h.settle();
  assert.equal(h.state.stop, true, 'Canonicalization occurs while our initial native answer is still active');
  h.location.pathname = '/c/canonical-route-id'; h.location.search = '?temporary-chat=true';
  h.state.temporary = false; h.state.nativeSaveChat = condition !== 'missing-save-chat';
  if (condition === 'changed-native-id') h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'different-opaque-conversation-identity');
  h.mutate(); h.advance(120); await h.settle();
  h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
}

test('the initial active native answer can seal its canonical route using an unchanged opaque conversation identity', async () => {
  const h = harness(); await finishWithOpaqueCanonicalIdentity(h);
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
  assert.equal(h.state.clicks, 2);
  const observed = JSON.stringify({ diagnostics: h.diagnostics, probe: await h.send('probe') });
  assert.equal(observed.includes('opaque-conversation-identity'), false);
  assert.equal(observed.includes('canonical-route-id'), false);
});

for (const options of [{ deferredUserDOM: true }, { remountUserAtAnswer: true }, { deferredUserDOM: true, remountUserAtAnswer: true }]) {
  test(`initial continuation survives ${Object.keys(options).join(' and ')} before its first assistant root`, async () => {
    const h = harness(options); await finishWithOpaqueCanonicalIdentity(h);
    if (options.remountUserAtAnswer) assert.equal(h.state.userDOMRemounts, 1);
    await h.run('request-2', true); await h.settle();
    assert.equal(h.events.some(event => event.code === 'CONVERSATION_CHANGED'), false);
    assert.equal(h.state.clicks, 2, 'The first follow-up uses the sealed original temporary conversation');
  });
}

test('a later concrete route change is refused after sealing an opaque native conversation identity', async () => {
  const h = harness(); await finishWithOpaqueCanonicalIdentity(h);
  await h.run('request-2', true); await h.settle();
  assert.equal(h.state.clicks, 2, 'The sealed original route authorizes a real follow-up first');
  const answer = new h.Element('DIV', { 'data-message-author-role': 'assistant', 'data-chatgpt-selection-conversation-id': 'opaque-conversation-identity' }, 'Second answer');
  h.state.answerRoots = [h.answer, answer]; h.mutate(); await h.settle();
  h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  assert.equal(h.events.filter(event => event.kind === 'done').length, 2);
  h.location.pathname = '/c/different-canonical-route';
  await h.run('request-3', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, false);
  assert.equal(h.state.clicks, 2); assert.equal(h.box.value, '');
});

test('opaque native identity cannot bind an arbitrary canonical route first seen after completion', async () => {
  const h = harness(); h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'opaque-conversation-identity');
  await finishFirstAnswer(h);
  h.location.pathname = '/c/canonical-route-id'; h.location.search = '?temporary-chat=true';
  h.state.temporary = false; h.state.nativeSaveChat = true;
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, false);
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

test('saving a bound temporary conversation removes permission for automated follow-ups', async () => {
  const h = harness(); await finishWithOpaqueCanonicalIdentity(h);
  h.state.nativeSaveChat = false; h.location.search = '';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED');
  assert.equal(h.events.at(-1).probe.continuationReason, 'temporary-off');
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

for (const condition of ['missing-save-chat', 'missing-native-id', 'changed-native-id']) test(`initial canonical route is not sealed with ${condition}`, async () => {
  const h = harness(); await finishWithOpaqueCanonicalIdentity(h, condition);
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, false);
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

test('a different conversation route is refused even while the old DOM is still visible', async () => {
  const h = harness(); h.location.pathname = '/c/original';
  await finishFirstAnswer(h);
  h.location.pathname = '/c/different';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED');
  assert.equal(h.events.at(-1).attempted, false); assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

test('Check retries an unsent follow-up after the original conversation is restored', async () => {
  const h = harness(); h.location.pathname = '/c/original';
  await finishFirstAnswer(h);
  h.location.pathname = '/c/different'; await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.state.clicks, 1);
  h.location.pathname = '/c/original'; h.location.search = '?model=fixture';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.state.clicks, 2, 'The same positively unsent follow-up can be retried once');
  await h.run('request-2', true); await h.settle(); assert.equal(h.state.clicks, 2);
});

test('new temporary chat at the same URL cannot reuse a missing conversation anchor', async () => {
  const h = harness(); await finishFirstAnswer(h);
  h.state.answerText = undefined; h.state.userCount = 0;
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED');
  assert.equal(h.state.clicks, 1); assert.equal(h.box.value, '');
});

test('canonical route without corroborating native identity is not adopted', async () => {
  const h = harness(); await finishFirstAnswer(h);
  h.location.pathname = '/c/unproven'; h.location.search = '';
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.state.clicks, 1);
});

test('changed native conversation identity is refused even with the same route and message node', async () => {
  const h = harness(); h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'original-native-id');
  await finishFirstAnswer(h);
  h.answer.setAttribute('data-chatgpt-selection-conversation-id', 'different-native-id');
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.state.clicks, 1);
  assert.equal(JSON.stringify(h.diagnostics).includes('original-native-id'), false);
  assert.equal(JSON.stringify(h.diagnostics).includes('different-native-id'), false);
});

test('navigation during effort setup is rechecked before inserting a follow-up draft', async () => {
  const h = harness({ effortControl: true }); await finishFirstAnswer(h);
  h.state.menuMounted = false;
  await h.run('request-2', true, 'instant'); await h.settle(); assert.equal(h.state.effortMenu, true);
  h.location.pathname = '/c/different'; h.state.menuMounted = true; h.mutate(); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.box.value, ''); assert.equal(h.state.clicks, 1);
});

test('navigation while awaiting Send readiness is rechecked before recording or clicking an attempt', async () => {
  const h = harness(); await finishFirstAnswer(h);
  h.state.sendEnabled = false; await h.run('request-2', true); await h.settle();
  const submissions = h.events.filter(event => event.kind === 'submitted').length;
  h.location.pathname = '/c/different'; h.state.sendEnabled = true; h.mutate(); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, false);
  assert.equal(h.events.filter(event => event.kind === 'submitted').length, submissions); assert.equal(h.state.clicks, 1);
});

test('a freshly loaded adapter cannot infer continuation from a Temporary Chat marker alone', async () => {
  const h = harness(); const response = await h.run('request-2', true); await h.settle();
  assert.equal(response.ok, false); assert.equal(h.state.clicks, 0);
});

test('an explicit temporary-off URL is refused with previous messages still present', async () => {
  const h = harness(); await finishFirstAnswer(h);
  h.location.search = '?temporary-chat=false'; await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.state.clicks, 1);
});

test('a reused message element with a different stable key does not establish continuity', async () => {
  const h = harness({ identities: true }); await h.run(); await h.settle();
  const node = new h.Element('DIV', { 'data-message-id': 'old-message' }, 'Earlier answer');
  h.state.answerRoots = [node]; h.mutate(); h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  node.setAttribute('data-message-id', 'new-message'); h.state.userCount = 0;
  await h.run('request-2', true); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.state.clicks, 1);
});

test('navigation during submitted acknowledgement never clicks Send or automatically retries', async () => {
  const h = harness(); await finishFirstAnswer(h);
  let acknowledge; h.state.acknowledge = new Promise(resolve => { acknowledge = resolve; });
  await h.run('request-2', true); await h.settle(); assert.equal(h.state.clicks, 1);
  h.location.pathname = '/c/different'; acknowledge(); await h.settle();
  assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED'); assert.equal(h.events.at(-1).attempted, true);
  await h.run('request-2', true); await h.settle(); assert.equal(h.state.clicks, 1);
});

for (const same of [true, false]) test(`virtualized message anchors ${same ? 'continue with' : 'refuse'} corroborating native conversation identity`, async () => {
  const h = harness({ identities: true }); await h.run(); await h.settle();
  h.state.answerRoots = [new h.Element('DIV', { 'data-message-id': 'old-message', 'data-chatgpt-selection-conversation-id': 'known-conversation' }, 'Earlier answer')];
  h.mutate(); h.state.stop = false; h.mutate(); h.advance(120); h.advance(1100); await h.settle();
  h.state.answerRoots = [new h.Element('DIV', { 'data-message-id': 'another-message', 'data-chatgpt-selection-conversation-id': same ? 'known-conversation' : 'different-conversation' }, 'Another rendered turn')];
  h.state.userCount = 0;
  await h.run('request-2', true); await h.settle();
  assert.equal(h.state.clicks, same ? 2 : 1);
  if (!same) assert.equal(h.events.at(-1).code, 'CONVERSATION_CHANGED');
});

test('first response text after a slow native wait streams without running a coalescing timer', async () => {
  const h = harness(); await h.run(); await h.settle(); h.advance(5000);
  h.state.answerText = 'First available text.'; h.mutate(); await h.settle();
  const stream = h.events.find(event => event.kind === 'stream');
  assert.equal(stream?.delta, h.state.answerText); assert.equal(stream.sequence, 1); assert.equal(stream.offset, 0);
  assert.equal(h.state.stop, true, 'The native answer is still generating');
  assert.equal(h.stages.some(event => event.stage === 'response_stream'), false, 'First text carries its own stage without a separate persistence barrier');
});

test('bursts coalesce once and an overdue hidden timer cannot block a natural mutation', async () => {
  const h = harness(); await h.run(); await h.settle();
  h.state.answerText = 'A'; h.mutate(); await h.settle();
  h.state.answerText = 'AB'; h.mutate(); h.state.answerText = 'ABC'; h.mutate();
  assert.equal(h.events.filter(event => event.kind === 'stream').length, 1);
  h.advance(120); await h.settle();
  assert.deepEqual(h.events.filter(event => event.kind === 'stream').map(event => event.delta), ['A', 'BC']);
  h.state.answerText = 'ABCD'; h.mutate();
  h.advance(1000, false); // Model a browser which has withheld the trailing timer.
  h.state.answerText = 'ABCDE'; h.mutate(); await h.settle();
  assert.deepEqual(h.events.filter(event => event.kind === 'stream').map(event => event.delta), ['A', 'BC', 'DE']);
  h.advance(120); await h.settle();
  assert.equal(h.events.filter(event => event.kind === 'stream').length, 3, 'The cancelled timer cannot duplicate output');
});

test('rewrites and whitespace-only suffixes preserve canonical order and offsets', async () => {
  const h = harness(); await h.run(); await h.settle();
  for (const text of ['Original', 'Rewrite', 'Rewrite\n', 'Rewrite\n    code']) {
    h.state.answerText = text; h.mutate(); h.advance(120); await h.settle();
  }
  let text = '', sequence = 0;
  for (const event of h.events.filter(event => event.kind === 'stream')) {
    assert.equal(core.streamCheck(text, sequence, event), 'apply');
    text = core.streamText(text, event); sequence = event.sequence;
  }
  assert.equal(text, 'Rewrite\n    code'); assert.equal(sequence, 4);
  assert.equal(h.events.filter(event => event.kind === 'stream')[1].text, 'Rewrite');
});

test('Check after a pending-update timeout resets timer handles and resumes without replay', async () => {
  const h = harness(); await h.run(); await h.settle();
  h.state.answerText = 'First'; h.mutate(); h.state.answerText = 'First pending'; h.mutate();
  h.advance(240000, false);
  const timeout = [...h.timers.values()].find(timer => timer.delay === 240000); timeout.callback(); await h.settle();
  await h.send('check', { requestId: 'request-1' }); await h.settle();
  h.state.answerText = 'First pending resumed'; h.mutate(); h.advance(120); await h.settle();
  let text = ''; for (const event of h.events.filter(event => event.kind === 'stream')) text = core.streamText(text, event);
  assert.equal(text, h.state.answerText); assert.equal(h.state.clicks, 1);
});

test('old answer remount is rejected and a reused element with a new identity is accepted', async () => {
  const h = harness({ identities: true });
  const old = new h.Element('DIV', { 'data-message-id': 'old' }, 'Old answer');
  h.state.answerRoots = [old]; await h.run(); await h.settle();
  const remount = new h.Element('DIV', { 'data-message-id': 'old' }, 'Old answer');
  h.state.answerRoots = [remount]; h.mutate(); await h.settle();
  assert.equal(h.events.some(event => event.kind === 'stream'), false);
  old.setAttribute('data-message-id', 'new'); old.innerText = 'New response';
  h.state.answerRoots = [old]; h.mutate(); await h.settle();
  assert.equal(h.events.find(event => event.kind === 'stream')?.delta, 'New response');
});

test('a rejected delta is repaired by an output snapshot without another native send', async () => {
  const h = harness(); const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = async message => {
    const reply = await original(message);
    return message.event?.kind === 'stream' && typeof message.event.delta === 'string' ? { ok: false, resync: true } : reply;
  };
  await h.run(); await h.settle(); h.state.answerText = 'Recovered output'; h.mutate(); await h.settle();
  const streams = h.events.filter(event => event.kind === 'stream');
  assert.equal(streams.length, 2); assert.equal(streams[1].text, 'Recovered output'); assert.equal(streams[1].sequence, streams[0].sequence);
  assert.equal(h.state.clicks, 1);
  assert.equal(JSON.stringify(h.diagnostics).includes('Recovered output'), false);
});

test('stop during composer setup completes once and prevents later submission or timeout errors', async () => {
  const h = harness({ composer: false }); await h.run(); await h.settle();
  assert.equal((await h.send('stop', { requestId: 'request-1' })).ok, true); await h.settle();
  assert.equal(h.events.length, 1); assert.equal(h.events[0].kind, 'done'); assert.equal(h.events[0].cancelledBeforeSend, true); assert.equal(h.events[0].continuation, false);
  h.state.composer = true; h.mutate(); h.fire(300000); await h.settle();
  assert.equal(h.state.clicks, 0); assert.equal(h.events.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.observers.size, 0);
  await h.run(); await h.settle(); assert.equal(h.state.clicks, 0, 'duplicate delivery must not restart a cancelled request');
});

test('default speed leaves native effort controls untouched', async () => {
  const h = harness({ effortControl: true }); await h.run(); await h.settle();
  assert.equal(h.state.clicks, 1); assert.equal(h.state.effortClicks || 0, 0);
  assert.ok(h.stages.some(event => event.speedStatus === 'current'));
});

test('opt-in Instant selects only the composer effort option and verifies before sending', async () => {
  const h = harness({ effortControl: true }); await h.run('request-1', false, 'instant'); await h.settle();
  assert.equal(h.state.instantClicks, 1); assert.equal(h.state.clicks, 1);
  assert.ok(h.stages.some(event => event.speedStatus === 'instant'));
  assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('missing Instant option keeps the current setting and closes the owned menu', async () => {
  const h = harness({ effortControl: true, instantAvailable: false }); await h.run('request-1', false, 'instant'); await h.settle();
  assert.equal(h.state.instantClicks || 0, 0); assert.equal(h.state.effortMenu, false); assert.equal(h.state.clicks, 1);
  assert.ok(h.stages.some(event => event.speedStatus === 'unavailable'));
});

test('cancelling while the speed menu mounts closes only the opened menu and never sends', async () => {
  const h = harness({ effortControl: true, menuMounted: false }); await h.run('request-1', false, 'instant'); await h.settle();
  assert.equal(h.state.effortMenu, true);
  await h.send('stop', { requestId: 'request-1' }); await h.settle();
  h.state.menuMounted = true; h.mutate(); h.fire(1500); await h.settle();
  assert.equal(h.state.effortMenu, false); assert.equal(h.state.clicks, 0); assert.equal(h.state.instantClicks || 0, 0);
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
  assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('unverified speed after a native click blocks sending and can retry with current setting', async () => {
  const h = harness({ effortControl: true, verifyInstant: false }); await h.run('request-1', false, 'instant'); await h.settle();
  h.fire(1500); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error?.code, 'SPEED_UNVERIFIED'); assert.equal(error.attempted, false);
  assert.equal(h.state.clicks, 0); assert.equal(h.box.value, '');
  assert.ok(h.stages.some(event => event.speedStatus === 'unverified'));
  await h.run('request-1', false, 'current'); await h.settle(); assert.equal(h.state.clicks, 1);
});

test('stop while waiting for enabled send aborts draft setup without later submission', async () => {
  const h = harness({ sendEnabled: false }); await h.run(); await h.settle(); assert.equal(h.box.value, 'PRIVATE CONTEXT AND QUESTION');
  await h.send('stop', { requestId: 'request-1' }); await h.settle(); h.state.sendEnabled = true; h.mutate(); h.fire(300000); await h.settle();
  assert.equal(h.state.clicks, 0); assert.equal(h.box.value, ''); assert.deepEqual(h.events.map(event => event.kind), ['done']); assert.equal(h.events[0].cancelledBeforeSend, true);
  await h.run('request-2'); await h.settle(); assert.equal(h.state.clicks, 1, 'an owned cancelled draft must not block the next request');
});

test('stop during submitted acknowledgement never clicks and reports the pre-send cancellation', async () => {
  let acknowledge; const pending = new Promise(resolve => { acknowledge = resolve; });
  const h = harness({ acknowledge: pending }); await h.run(); await h.settle(); assert.equal(h.events[0].kind, 'submitted'); assert.equal(h.state.clicks, 0);
  await h.send('stop', { requestId: 'request-1' }); acknowledge(); await h.settle(); h.fire(300000); await h.settle();
  assert.equal(h.state.clicks, 0); assert.deepEqual(h.events.map(event => event.kind), ['submitted', 'done']); assert.equal(h.events[1].cancelledBeforeSend, true);
});

test('stop after send completes with an empty answer and preserves verified continuation', async () => {
  const h = harness(); await h.run(); await h.settle(); assert.equal(h.state.clicks, 1); assert.equal(h.state.stop, true);
  await h.send('stop', { requestId: 'request-1' }); await h.settle();
  const done = h.events.find(event => event.kind === 'done'); assert.ok(done); assert.equal(done.text, ''); assert.equal(done.cancelledBeforeSend, undefined); assert.equal(h.state.stops, 1); assert.equal(h.timers.size, 0);
  await h.run(); await h.settle(); assert.equal(h.state.clicks, 1, 'duplicate delivery must never replay an attempted send');
  await h.run('request-2', true); await h.settle(); assert.equal(h.state.clicks, 2, 'a confirmed sent request supports a follow-up after stopping');
});

test('cancelled setup leaves a user-replaced native draft untouched', async () => {
  const h = harness({ sendEnabled: false }); await h.run(); await h.settle(); h.box.value = 'A user changed this draft';
  await h.send('stop', { requestId: 'request-1' }); await h.settle(); assert.equal(h.box.value, 'A user changed this draft'); assert.equal(h.state.clicks, 0);
});

test('temporary verification remains required and diagnostics never contain chat text', async () => {
  const h = harness({ temporary: false }); await h.run(); await h.settle();
  assert.equal(h.state.clicks, 0); assert.equal(h.box.value, ''); assert.equal(h.events[0].kind, 'error'); assert.equal(h.events[0].attempted, false);
  assert.match(h.events[0].text, /Temporary Chat could not be verified/); assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE CONTEXT AND QUESTION'), false);
});

test('ready probe is independent of SPA composer mounting and contains no conversation text', async () => {
  const h = harness({ composer: false });
  const pending = await h.send('probe');
  assert.equal(pending.ok, true); assert.equal(pending.ready, true); assert.equal(pending.probe.composerCount, 0);
  assert.equal(pending.probe.documentState, 'complete'); assert.equal(pending.probe.hasMain, true);
  h.state.composer = true;
  const mounted = await h.send('probe'); assert.equal(mounted.probe.composerCount, 1);
  assert.equal(h.events.length, 0); assert.equal(h.state.clicks, 0);
  assert.equal(JSON.stringify(mounted).includes('PRIVATE CONTEXT AND QUESTION'), false);
});

test('composer can mount after the listener is ready without an early load error', async () => {
  const h = harness({ composer: false }); await h.run(); await h.settle();
  assert.equal(h.events.some(event => event.kind === 'error'), false);
  assert.ok(h.stages.some(event => event.stage === 'composer_ready'));
  h.state.composer = true; h.mutate(); await h.settle();
  assert.equal(h.state.clicks, 1); assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('a missing composer reports its own pre-send stage instead of a generic page-load error', async () => {
  const h = harness({ composer: false }); await h.run(); await h.settle(); h.fire(30000); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.ok(error); assert.equal(error.code, 'COMPOSER_NOT_FOUND'); assert.equal(error.stage, 'composer_ready');
  assert.equal(error.attempted, false); assert.equal(h.state.clicks, 0);
});

test('visible ProseMirror is used while a hidden legacy textarea remains untouched', async () => {
  const h = harness({ editor: 'contenteditable', hiddenFallback: true }); await h.run(); await h.settle();
  assert.equal(h.state.clicks, 1); assert.equal(h.fallback.value, '');
  assert.equal(h.events.some(event => event.kind === 'error'), false);
  const probe = await h.send('probe'); assert.equal(probe.probe.hiddenComposerCount, 1);
});

test('the native Send label is supported when legacy test IDs and Send prompt labels are absent', async () => {
  const h = harness({ simpleSendLabel: true }); await h.run(); await h.settle();
  assert.equal(h.state.clicks, 1); assert.equal(h.state.sentDraft, 'PRIVATE CONTEXT AND QUESTION');
  assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('explicit Temporary Chat activation happens once before inserting the prompt', async () => {
  const h = harness({ temporary: false, temporaryChoice: true }); await h.run(); await h.settle();
  assert.equal(h.state.temporaryClicks, 1); assert.equal(h.state.clicks, 1);
  await h.run(); await h.settle(); assert.equal(h.state.temporaryClicks, 1); assert.equal(h.state.clicks, 1);
  assert.ok(h.stages.some(event => event.stage === 'temporary_setup'));
});

test('Temporary Chat setup that replaces the editor inserts only into the new live composer', async () => {
  const h = harness({ temporary: false, temporaryChoice: true, remountOnTemporary: true, editor: 'contenteditable' });
  await h.run(); await h.settle();
  assert.equal(h.initialBox.isConnected, false); assert.equal(h.initialBox.innerText, '');
  assert.notEqual(h.box, h.initialBox); assert.equal(h.state.sentDraft, 'PRIVATE CONTEXT AND QUESTION');
  assert.equal(h.state.clicks, 1); assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('Temporary Chat personalization choices require user action and can resume without replay', async () => {
  const h = harness({ dialog: true }); await h.run(); await h.settle();
  const error = h.events.find(event => event.kind === 'error'); assert.ok(error);
  assert.ok(['SETUP_DIALOG_REQUIRED', 'TEMPORARY_CHOICE_REQUIRED'].includes(error.code)); assert.equal(error.stage, 'temporary_setup');
  assert.equal(error.attempted, false); assert.equal(h.state.choiceClicks, 0); assert.equal(h.state.clicks, 0); assert.equal(h.box.value, '');
  h.state.dialog = false; h.mutate(); await h.run(); await h.settle(); assert.equal(h.state.clicks, 1);
});

test('a native draft is preserved and identified separately from connection failures', async () => {
  const h = harness(); h.box.value = 'An existing native draft.'; await h.run(); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'DRAFT_PRESENT'); assert.equal(error.stage, 'draft_insert'); assert.equal(error.attempted, false);
  assert.equal(h.box.value, 'An existing native draft.'); assert.equal(h.state.clicks, 0);
});

test('send readiness failure is pre-send and a deliberate retry sends the same owned draft once', async () => {
  const h = harness({ sendEnabled: false }); await h.run(); await h.settle(); h.fire(8000); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'SEND_NOT_READY'); assert.equal(error.stage, 'send_ready'); assert.equal(error.attempted, false);
  assert.equal(h.box.value, 'PRIVATE CONTEXT AND QUESTION'); assert.equal(h.state.clicks, 0);
  h.state.sendEnabled = true; await h.run(); await h.settle(); assert.equal(h.state.clicks, 1);
});

test('an unconfirmed native click has its own stage and cannot be replayed by duplicate delivery or check', async () => {
  const h = harness({ acknowledgeSend: false }); await h.run(); await h.settle(); h.fire(15000); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'SEND_UNCONFIRMED'); assert.equal(error.stage, 'send_confirm'); assert.equal(error.attempted, true);
  await h.run(); await h.send('check', { requestId: 'request-1' }); await h.settle(); assert.equal(h.state.clicks, 1);
});

test('a confirmed submission with no assistant response reports the response stage', async () => {
  const h = harness({ startStreaming: false }); await h.run(); await h.settle(); h.fire(300000); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.ok(error); assert.ok(['RESPONSE_NOT_FOUND', 'RESPONSE_TIMEOUT'].includes(error.code)); assert.equal(error.stage, 'response_wait');
  assert.equal(error.attempted, true); assert.equal(h.state.clicks, 1);
});

test('a recognized assistant response streams and completes without another send', async () => {
  const h = harness(); await h.run(); await h.settle();
  h.mutate(); h.fire(120); await h.settle();
  h.state.answerText = 'The answer has reached the helper.'; h.state.stop = false;
  h.mutate(); h.fire(120); await h.settle(); h.fire(1100); await h.settle();
  const stream = h.events.find(event => event.kind === 'stream'); const done = h.events.find(event => event.kind === 'done');
  assert.ok(stream); assert.equal(stream.stage, 'response_stream'); assert.equal(stream.delta, h.state.answerText);
  assert.ok(done); assert.equal(done.text, h.state.answerText); assert.equal(h.state.clicks, 1);
  assert.equal(h.events.some(event => event.kind === 'error'), false); assert.equal(h.timers.size, 0);
});

test('shared native-renderer roots confirm and mirror messages even without legacy role attributes', async () => {
  const h = harness({ sharedRoots: true }); await h.run(); await h.settle();
  assert.ok(h.stages.some(event => event.stage === 'response_wait'));
  h.mutate(); h.fire(120); await h.settle();
  h.state.answerText = 'A response resolved through the shared native-renderer adapter.'; h.state.stop = false;
  h.mutate(); h.fire(120); await h.settle(); h.fire(1100); await h.settle();
  const ready = await h.send('probe'); assert.equal(ready.probe.userCount, 1); assert.equal(ready.probe.assistantCount, 1);
  assert.equal(h.events.find(event => event.kind === 'done')?.text, h.state.answerText);
  assert.equal(h.state.clicks, 1); assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('native page errors are classified without copying account or conversation text into diagnostics', async () => {
  const h = harness({ alert: 'Something went wrong: PRIVATE ACCOUNT AND CONVERSATION DETAILS' });
  await h.run(); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'NATIVE_PAGE_ERROR'); assert.equal(error.stage, 'composer_ready'); assert.equal(error.attempted, false);
  assert.equal(JSON.stringify(h.events).includes('PRIVATE ACCOUNT AND CONVERSATION DETAILS'), false);
  assert.equal(JSON.stringify(h.diagnostics).includes('PRIVATE ACCOUNT AND CONVERSATION DETAILS'), false);
  assert.equal(h.state.clicks, 0); assert.equal(h.box.value, '');
});

test('sign-in is distinguished from an editor selector failure', async () => {
  const h = harness({ composer: false, auth: true }); await h.run(); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'SIGN_IN_REQUIRED'); assert.equal(error.stage, 'composer_ready');
  assert.equal(error.attempted, false); assert.equal(h.state.clicks, 0);
  const ready = await h.send('probe'); assert.equal(ready.probe.authGate, true); assert.equal(ready.probe.hasComposer, false);
});

test('a setup dialog after a send does not falsely report that nothing was sent', async () => {
  const h = harness(); await h.run(); await h.settle(); assert.equal(h.state.clicks, 1);
  h.state.dialog = true; h.mutate(); h.fire(120); await h.settle();
  const error = h.events.find(event => event.kind === 'error');
  assert.equal(error.code, 'TEMPORARY_CHOICE_REQUIRED'); assert.equal(error.attempted, true);
  assert.doesNotMatch(error.text, /Nothing was sent/); assert.match(error.text, /not be resent/);
});
