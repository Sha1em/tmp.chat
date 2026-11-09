'use strict';
importScripts('lib/core.js');
const C = TmpCore;
const KEY = 'tmp.chat.session';
const PREFERENCES_KEY = 'tmp.chat.preferences';
const HELPER = 'https://chatgpt.com/?temporary-chat=true#tmp-chat-helper';
let session = null;
let preferences = { speed: 'current' };
const ready = Promise.all([
  chrome.storage.session.get(KEY).then(result => { session = result[KEY] || null; }),
  chrome.storage.local.get(PREFERENCES_KEY).then(result => { preferences = { speed: result[PREFERENCES_KEY]?.speed === 'instant' ? 'instant' : 'current' }; })
]);
let queue = Promise.resolve(), saveTimer = null, firstPatchRequest = null, firstEventRequest = null;
let preparationJob = null;
const PREWARM_MS = 180000;
function serial(fn) { const task = queue.then(() => ready).then(fn); queue = task.catch(() => {}); return task; }
// Diagnostics deliberately contain only command/state metadata, never chat content.
function diagnostic(event, details = {}) { console.debug('[tmp.chat worker]', event, details); }
const stageCode = value => /^[A-Z][A-Z0-9_]{0,63}$/.test(value || '') ? value : '';
const stageName = value => /^[a-z][a-z0-9_-]{0,47}$/.test(value || '') ? value : '';
function helperError(code, stage, text) { return Object.assign(new Error(text), { code, stage }); }
const HELPER_FAILURES = Object.freeze({
  helper_creating: ['HELPER_CREATE', 'tmp.chat could not open the dedicated ChatGPT tab. Choose Check again to retry.'],
  helper_loading: ['HELPER_LOAD', 'The ChatGPT helper page could not finish loading. Open ChatGPT to inspect it, then choose Check again. Nothing was sent.'],
  helper_navigation: ['HELPER_NAVIGATION', 'The ChatGPT helper could not be reached. Open ChatGPT to inspect it, then choose Check again. Nothing was sent.'],
  agent_injecting: ['HELPER_INJECTION', 'tmp.chat could not attach to the ChatGPT helper page. Open ChatGPT, let it finish loading, then choose Check again. Nothing was sent.'],
  agent_ready: ['HELPER_HANDSHAKE', 'The ChatGPT helper loaded, but its tmp.chat adapter did not answer. Open ChatGPT, let it finish loading, then choose Check again. Nothing was sent.'],
  dispatch: ['HELPER_DISPATCH', 'The ChatGPT adapter connection was interrupted while starting your question. Open ChatGPT to inspect whether it was sent, then choose Check again. It will not be sent again automatically.']
});
function safeProbe(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  if (['loading', 'interactive', 'complete'].includes(value.documentState)) result.documentState = value.documentState;
  for (const key of ['hasMain', 'hasComposer', 'temporary', 'temporaryChoice', 'authGate', 'sendPresent', 'sendEnabled']) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['composerCount', 'hiddenComposerCount', 'dialogCount', 'assistantCount', 'userCount']) if (Number.isInteger(value[key]) && value[key] >= 0) result[key] = Math.min(10000, value[key]);
  if (['document', 'route', 'anchor', 'message-identity', 'native-identity', 'canonical-route', 'temporary-off'].includes(value.continuationReason)) result.continuationReason = value.continuationReason;
  return result;
}
function withTimeout(promise, timeout, error) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error), timeout);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, failure => { clearTimeout(timer); reject(failure); });
  });
}
function newSession(tabId, context) {
  return { id: crypto.randomUUID(), ownerTabId: tabId, helperTabId: null, context: C.context(context), messages: [], status: 'idle', stage: 'idle', error: '', errorCode: '', uncertain: false, dispatched: false, stopRequested: false, retained: false, updatedAt: Date.now() };
}
function publicState() {
  if (!session) return null;
  const { ownerTabId, helperTabId, helperDocumentId, warmExpiresAt, dispatched, ...state } = session;
  return { ...state, preferences: { ...preferences }, hasHelper: Number.isInteger(helperTabId) };
}
async function persist() {
  clearTimeout(saveTimer); saveTimer = null;
  if (session) await chrome.storage.session.set({ [KEY]: session });
  else await chrome.storage.session.remove(KEY);
}
async function publish(flush = true, patch = null) {
  if (session) session.revision = (session.revision || 0) + 1;
  if (flush) await persist();
  else if (!saveTimer) saveTimer = setTimeout(() => { serial(persist).catch(() => {}); }, 1200);
  if (session) {
    const first = patch && firstPatchRequest !== session.requestId;
    if (patch) firstPatchRequest = session.requestId;
    if (first) diagnostic('stream:first-forward', { at: Date.now() });
    chrome.tabs.sendMessage(session.ownerTabId, patch ? { type: 'tmp:patch', sessionId: session.id, requestId: session.requestId, revision: session.revision, ...patch } : { type: 'tmp:state', state: publicState() }).catch(() => { diagnostic('source:delivery-failed', { patch: !!patch }); });
  }
}
function requireOwner(tabId) { if (!session || session.ownerTabId !== tabId) throw new Error('This tangent is open in another tab. Return to that tab to continue it.'); }
function snapshot(tabId) { return session && session.ownerTabId !== tabId ? { occupied: true } : { state: publicState(), preferences: { ...preferences } }; }
async function closeHelper(state) {
  if (!state || state.retained || !Number.isInteger(state.helperTabId)) return;
  try {
    const tab = await chrome.tabs.get(state.helperTabId);
    // Never close an unrelated tab if the user navigated the helper elsewhere.
    const pendingOwned = (!tab.url || tab.url === 'about:blank') && tab.pendingUrl && tab.pendingUrl.startsWith('https://chatgpt.com/') && new URL(tab.pendingUrl).hash === '#tmp-chat-helper';
    if ((tab.url || '').startsWith('https://chatgpt.com/') || pendingOwned) await chrome.tabs.remove(tab.id);
  } catch {}
}
async function clearSession() {
  const previous = session;
  session = null;
  await persist();
  if (previous) chrome.tabs.sendMessage(previous.ownerTabId, { type: 'tmp:state', state: null }).catch(() => {});
  await chrome.alarms.clear('tmp:watchdog');
  await chrome.alarms.clear('tmp:prewarm');
  await closeHelper(previous);
}
async function fail(id, requestId, text, uncertain = false, code = '', stage = '') {
  return serial(async () => {
    if (!session || session.id !== id || session.requestId !== requestId || (!C.busy(session.status) && session.status !== 'error')) return;
    session.status = 'error'; session.error = text; session.uncertain = uncertain || session.dispatched;
    session.errorCode = stageCode(code); session.stage = stageName(stage) || session.stage;
    diagnostic('helper:failed', { stage: session.stage, code: session.errorCode, dispatched: !!session.dispatched, uncertain: !!session.uncertain });
    await chrome.alarms.clear('tmp:watchdog');
    await publish();
  });
}
async function helperStage(id, requestId, stage) {
  return serial(async () => {
    if (!session || session.id !== id || session.requestId !== requestId || !C.busy(session.status)) return false;
    session.stage = stage; session.errorCode = ''; session.updatedAt = Date.now();
    diagnostic('helper:stage', { stage }); await publish(); return true;
  });
}
async function waitForDocument(tabId, timeout = 25000) {
  const tab = await chrome.tabs.get(tabId);
  const settled = value => (value.url || '').startsWith('https://chatgpt.com/') && (!value.pendingUrl || value.pendingUrl === value.url);
  const foreign = value => value.status === 'complete' && value.url && !/^(?:about:blank|https:\/\/chatgpt\.com\/)/.test(value.url) && !value.pendingUrl;
  if (foreign(tab)) throw helperError('HELPER_NAVIGATION', 'helper_navigation', HELPER_FAILURES.helper_navigation[1]);
  if (settled(tab)) return;
  await new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => done(helperError('HELPER_LOAD_TIMEOUT', 'helper_loading', 'The ChatGPT helper page did not finish loading. Open ChatGPT to inspect it, then choose Check again. Nothing was sent.')), timeout);
    function inspect() { chrome.tabs.get(tabId).then(value => { if (foreign(value)) done(helperError('HELPER_NAVIGATION', 'helper_navigation', HELPER_FAILURES.helper_navigation[1])); else if (settled(value)) done(); }).catch(done); }
    function onUpdated(id) { if (id === tabId) inspect(); }
    function onRemoved(id) { if (id === tabId) done(helperError('HELPER_CLOSED', 'helper_loading', 'The tmp.chat background tab was closed.')); }
    function done(error) { if (finished) return; finished = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onRemoved.removeListener(onRemoved); error ? reject(error) : resolve(); }
    chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.onRemoved.addListener(onRemoved);
    // Close the gap between the first read and registering the listener.
    inspect();
  });
}
function prepareHelper(id) {
  if (preparationJob?.id === id) return preparationJob.promise;
  const job = { id };
  preparationJob = job;
  job.promise = (async () => {
    let tabId, stage = 'helper_creating', documentId;
    const startedAt = Date.now();
    const owned = () => session?.id === id && session.helperTabId === tabId;
    const phase = async value => {
      stage = value;
      diagnostic('startup:phase', { phase: value, at: Date.now(), elapsedMs: Date.now() - startedAt });
      if (session?.id === id && C.busy(session.status)) await helperStage(id, session.requestId, value);
    };
    try {
      await serial(async () => {
        if (session?.id !== id) return;
        tabId = session.helperTabId;
        if (!Number.isInteger(tabId)) {
          const tab = await chrome.tabs.create({ url: HELPER, active: false });
          tabId = tab.id; session.helperTabId = tabId; delete session.helperDocumentId;
          await chrome.tabs.update(tabId, { autoDiscardable: false });
          await publish();
        }
        documentId = session.helperDocumentId;
      });
      if (!Number.isInteger(tabId) || !owned()) return null;
      await phase('helper_loading'); await waitForDocument(tabId);
      if (!owned()) return null;
      await phase('helper_navigation');
      let connection;
      // A warm adapter retains the continuity proof. Do not reinject routinely.
      if (documentId) {
        try { connection = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'tmp:probe' }, { documentId }), 5000, helperError('HELPER_HANDSHAKE_TIMEOUT', 'agent_ready', HELPER_FAILURES.agent_ready[1])); } catch {}
      }
      if (!connection?.ok || connection.protocol !== 2 || connection.ready !== true) {
        await phase('agent_injecting');
        const injection = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, files: ['lib/core.js', 'lib/selection.js', 'lib/answer.js', 'agent.js'] }), 15000,
          helperError('HELPER_INJECTION_TIMEOUT', stage, HELPER_FAILURES.agent_injecting[1]));
        documentId = injection?.[0]?.documentId;
        await phase('agent_ready');
        connection = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'tmp:probe' }, documentId ? { documentId } : undefined), 5000,
          helperError('HELPER_HANDSHAKE_TIMEOUT', stage, HELPER_FAILURES.agent_ready[1]));
      }
      if (!connection?.ok || connection.ready !== true || connection.protocol !== 2) throw helperError('HELPER_HANDSHAKE', 'agent_ready', HELPER_FAILURES.agent_ready[1]);
      if (!owned()) return null;
      await serial(async () => { if (owned()) { session.helperDocumentId = documentId; session.probe = safeProbe(connection.probe); await persist(); } });
      await phase('composer_ready');
      const prepared = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'tmp:prepare' }, documentId ? { documentId } : undefined), 35000,
        helperError('HELPER_PREPARE_TIMEOUT', 'composer_ready', 'The ChatGPT helper did not become ready. Open ChatGPT to inspect it, then choose Check again. Nothing was sent.'));
      if (!prepared?.ok) throw helperError(stageCode(prepared?.code) || 'HELPER_PREPARE', stageName(prepared?.stage) || 'composer_ready', C.clip(prepared?.error, 500) || 'The ChatGPT helper could not be prepared. Open ChatGPT to inspect it. Nothing was sent.');
      if (!owned()) return null;
      diagnostic('startup:prepared', { at: Date.now(), elapsedMs: Date.now() - startedAt, probe: safeProbe(prepared.probe) });
      return { tabId, documentId, probe: safeProbe(prepared.probe) };
    } catch (error) {
      if (!error.stage) {
        const [code, text] = HELPER_FAILURES[stage] || ['HELPER_PREPARE', 'The ChatGPT helper could not be prepared. Open ChatGPT to inspect it. Nothing was sent.'];
        throw helperError(code, stage, text);
      }
      throw error;
    }
  })().finally(() => { if (preparationJob === job) preparationJob = null; });
  return job.promise;
}
function beginPreparation(id) {
  // Never hold the command queue while waiting for a page or native UI.
  setTimeout(() => {
    if (session?.id !== id || session.messages.length || session.retained) return;
    prepareHelper(id).catch(error => diagnostic('startup:prepare-failed', { code: stageCode(error.code), stage: stageName(error.stage) }));
  }, 0);
}
async function runRequest(id, requestId) {
  let stage = 'helper_creating';
  try {
    if (session?.id !== id || session.requestId !== requestId || !C.busy(session.status)) return;
    const prepared = await prepareHelper(id);
    if (!prepared) return;
    const { tabId, documentId, probe } = prepared;
    stage = 'dispatch';
    let payload;
    await serial(async () => {
      if (!session || session.id !== id || session.requestId !== requestId || !C.busy(session.status)) return;
      session.stage = stage; session.probe = probe; diagnostic('helper:stage', { stage });
      session.dispatched = true; session.status = session.stopRequested ? 'stopping' : 'sending'; session.updatedAt = Date.now();
      payload = { type: 'tmp:run', sessionId: id, requestId, prompt: session.pendingPrompt, continuation: !!session.hasSubmitted, speed: preferences.speed };
      await publish();
    });
    if (payload) {
      const response = await withTimeout(chrome.tabs.sendMessage(tabId, payload, documentId ? { documentId } : undefined), 5000,
        helperError('HELPER_DISPATCH_TIMEOUT', stage, 'The ChatGPT adapter did not acknowledge your question. Open ChatGPT to inspect whether it was sent, then choose Check again. It will not be sent again automatically.'));
      if (!response?.ok) throw helperError(stageCode(response?.code) || 'HELPER_DISPATCH', stage, response?.error || 'The ChatGPT adapter connection was interrupted while starting your question. Open ChatGPT to inspect whether it was sent, then choose Check again. It will not be sent again automatically.');
      // Stop can arrive after dispatch was recorded but before the agent received run.
      // Repeat the cancellation only, never the prompt submission.
      let stoppedBeforeRun = false;
      await serial(() => { stoppedBeforeRun = session?.id === id && session.requestId === requestId && session.stopRequested && C.busy(session.status); });
      if (stoppedBeforeRun) await chrome.tabs.sendMessage(tabId, { type: 'tmp:stop', requestId });
    }
  } catch (error) {
    const [fallbackCode, fallbackText] = HELPER_FAILURES[stage];
    const code = stageCode(error.code) || fallbackCode;
    const text = error.stage ? error.message : fallbackText;
    await fail(id, requestId, text, false, code, error.stage || stage);
  }
}
async function handle(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.id !== chrome.runtime.id) throw new Error('This command must come from a tmp.chat tab.');
  if (message.type === 'tmp:event') {
    if (!session || session.helperTabId !== tabId || session.id !== message.sessionId || session.requestId !== message.requestId) return { ok: false };
    if (!C.busy(session.status) && session.status !== 'error') return { ok: true };
    const event = message.event || {};
    session.updatedAt = Date.now();
    if (event.kind === 'heartbeat') return { ok: true };
    if (['instant', 'current', 'unavailable', 'unverified', 'checking'].includes(event.speedStatus)) session.speedStatus = event.speedStatus;
    if (stageName(event.stage)) session.stage = event.stage;
    if (event.probe) session.probe = safeProbe(event.probe);
    if (event.kind === 'stage') { diagnostic('agent:stage', { stage: session.stage, probe: session.probe }); await publish(false); return { ok: true }; }
    const answer = session.messages.find(m => m.id === session.requestId);
    if (event.kind === 'stream' && answer) {
      const check = C.streamCheck(answer.text, answer.sequence, event);
      if (check !== 'apply') return check === 'ignore' ? { ok: true } : { ok: false, resync: true };
      if (!answer.text) diagnostic('stream:first-handle', { at: Date.now() });
    }
    if (event.kind === 'submitted') { session.stage = stageName(event.stage) || 'submitted'; session.status = session.stopRequested ? 'stopping' : 'sending'; session.submitted = true; session.hasSubmitted = true; }
    if (event.kind === 'stream' || event.kind === 'done') {
      if (answer) {
        answer.text = C.streamText(answer.text, event); answer.tree = event.kind === 'done' ? C.cleanTree(event.tree) : null;
        if (Number.isSafeInteger(event.sequence) && event.sequence >= 0) answer.sequence = event.sequence;
        if (event.kind === 'done') answer.notices = Array.isArray(event.notices) ? [...new Set(event.notices.filter(value => ['unsupported', 'truncated'].includes(value)))] : [];
      }
      session.stage = stageName(event.stage) || (event.kind === 'done' ? 'complete' : 'response_stream'); session.errorCode = '';
      session.status = event.kind === 'done' ? 'done' : session.stopRequested ? 'stopping' : 'streaming'; session.error = ''; session.uncertain = false;
      if (event.kind === 'done') {
        if (event.cancelledBeforeSend) { session.hasSubmitted = !!event.continuation; session.submitted = false; }
        session.pendingPrompt = ''; await chrome.alarms.clear('tmp:watchdog');
      }
    }
    if (event.kind === 'error') {
      // The adapter can positively report a failure before its only native
      // click, including a remount during the durable attempt checkpoint.
      if (event.attempted === false && event.cancelledBeforeSend === true) {
        session.hasSubmitted = !!event.continuation; session.submitted = false;
      }
      session.status = 'error'; session.error = C.clip(event.text, 500); session.uncertain = event.attempted !== false;
      session.errorCode = stageCode(event.code) || 'AGENT_ERROR';
      diagnostic('agent:failed', { code: session.errorCode, stage: session.stage, attempted: event.attempted !== false });
      // A positively confirmed pre-submission failure can be checked again safely.
      if (event.attempted === false) session.dispatched = false;
      await chrome.alarms.clear('tmp:watchdog');
    }
    await publish(event.kind !== 'stream', event.kind === 'stream' ? { status: session.status, sequence: answer?.sequence, ...(typeof event.delta === 'string' ? { delta: event.delta, offset: event.offset } : { text: answer?.text || '' }) } : null);
    return { ok: true };
  }
  if (session?.helperTabId === tabId) {
    if (message.type === 'tmp:hello') return { ok: true, helper: true };
    throw new Error('The background tab cannot start a side conversation.');
  }
  if (message.type === 'tmp:hello') return { ok: true, ...snapshot(tabId) };
  if (message.type === 'tmp:preference') {
    if (session) { requireOwner(tabId); if (C.busy(session.status)) throw new Error('Wait for this answer to finish before changing answer speed.'); }
    if (!['current', 'instant'].includes(message.speed)) throw new Error('Choose an available answer speed preference.');
    preferences = { speed: message.speed };
    await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
    if (session) { session.speedStatus = preferences.speed === 'current' ? 'current' : ''; await publish(); }
    return { ok: true, preferences: { ...preferences }, state: publicState() };
  }
  if (message.type === 'tmp:ensure') {
    if (session) {
      requireOwner(tabId);
      if (message.context && !session.messages.length && !session.context.selection) { session.context = C.context(message.context); await publish(); }
    }
    else { session = newSession(tabId, message.context); await publish(); }
    return { ok: true, state: publicState() };
  }
  if (message.type === 'tmp:prepare') {
    if (session) requireOwner(tabId);
    else session = newSession(tabId);
    if (!session.messages.length && !session.retained) {
      session.warmExpiresAt = Date.now() + PREWARM_MS;
      await chrome.alarms.create('tmp:prewarm', { when: session.warmExpiresAt });
      await publish(); beginPreparation(session.id);
    }
    return { ok: true, state: publicState() };
  }
  if (message.type === 'tmp:context') {
    const context = C.context(message.context);
    if (!context.selection) throw new Error('Select a passage in a ChatGPT answer first.');
    if (session) {
      requireOwner(tabId);
      if (session.messages.length) throw new Error('Keep or discard this tangent before starting one from a new selection.');
      session.context = context;
    } else {
      session = newSession(tabId, context);
    }
    await publish(); return { ok: true, state: publicState() };
  }
  requireOwner(tabId);
  if (message.type === 'tmp:discard') { await clearSession(); return { ok: true }; }
  if (message.type === 'tmp:focus') {
    if (!Number.isInteger(session.helperTabId)) throw new Error('The ChatGPT tab is still being prepared.');
    await chrome.tabs.update(session.helperTabId, { active: true });
    return { ok: true };
  }
  if (message.type === 'tmp:keep') {
    if (C.busy(session.status)) throw new Error('Wait for this answer to finish before keeping the conversation.');
    if (!session.messages.length || !Number.isInteger(session.helperTabId)) throw new Error('Send a question first.');
    // Hand off ownership. This tab must never be closed by later extension cleanup.
    await chrome.tabs.update(session.helperTabId, { autoDiscardable: true, active: true });
    session.retained = true; await persist();
    await chrome.tabs.sendMessage(session.helperTabId, { type: 'tmp:release' }).catch(() => {});
    await clearSession();
    return { ok: true, handedOff: true };
  }
  if (message.type === 'tmp:stop') {
    if (!C.busy(session.status)) return { ok: true };
    session.stopRequested = true; session.status = 'stopping'; await publish();
    if (Number.isInteger(session.helperTabId) && session.dispatched) {
      const id = session.id, requestId = session.requestId;
      chrome.tabs.sendMessage(session.helperTabId, { type: 'tmp:stop', requestId }).catch(() => fail(id, requestId, 'Open ChatGPT to stop the answer.', false, 'HELPER_STOP_CONNECTION', 'request_stop'));
    } else {
      session.status = 'done'; session.pendingPrompt = ''; await chrome.alarms.clear('tmp:watchdog'); await publish();
    }
    return { ok: true };
  }
  if (message.type === 'tmp:check') {
    if (C.busy(session.status)) throw new Error('The answer is still running.');
    if (!session.pendingPrompt) return { ok: true };
    const id = session.id, requestId = session.requestId;
    if (!session.dispatched) {
      if (session.stopRequested) {
        session.status = 'done'; session.pendingPrompt = ''; session.error = ''; session.uncertain = false;
        await chrome.alarms.clear('tmp:watchdog'); await publish();
        return { ok: true, state: publicState() };
      }
      session.status = 'starting'; session.stage = 'helper_loading'; session.error = ''; session.errorCode = ''; session.updatedAt = Date.now(); await publish();
      await chrome.alarms.create('tmp:watchdog', { periodInMinutes: 1 });
      setTimeout(() => runRequest(id, requestId), 0);
    } else {
      if (!Number.isInteger(session.helperTabId)) throw new Error('The ChatGPT tab is gone. Discard this tangent to start another.');
      let result;
      try {
        // Refresh DOM adapters on an explicit observation retry. The agent's
        // guard preserves its existing attempt; this path never sends tmp:run.
        await withTimeout(chrome.scripting.executeScript({ target: { tabId: session.helperTabId }, files: ['lib/core.js', 'lib/selection.js', 'lib/answer.js', 'agent.js'] }), 15000,
          helperError('HELPER_CHECK_CONNECTION', 'request_check', 'The existing ChatGPT request could not be reconnected.'));
        result = await withTimeout(chrome.tabs.sendMessage(session.helperTabId, { type: 'tmp:check', requestId }), 5000,
          helperError('HELPER_CHECK_CONNECTION', 'request_check', 'The existing ChatGPT request could not be reconnected.'));
      }
      catch {
        session.errorCode = 'HELPER_CHECK_CONNECTION'; session.stage = 'request_check';
        session.error = 'tmp.chat cannot reconnect to the existing request. Open ChatGPT to inspect whether it was sent. Your question will not be sent again automatically.';
        session.uncertain = true; await publish();
        throw new Error(session.error);
      }
      if (!result?.ok) {
        session.errorCode = 'HELPER_CHECK_UNKNOWN'; session.stage = 'request_check';
        session.error = 'The ChatGPT adapter cannot identify the existing request. Open ChatGPT to check whether the question was sent. It will not be sent again automatically.';
        session.uncertain = true; await publish();
        throw new Error(session.error);
      }
      session.status = session.stopRequested ? 'stopping' : 'sending'; session.error = ''; session.updatedAt = Date.now(); await publish();
      await chrome.alarms.create('tmp:watchdog', { periodInMinutes: 1 });
    }
    return { ok: true, state: publicState() };
  }
  if (message.type === 'tmp:send') {
    if (C.busy(session.status)) throw new Error('Wait for the current answer to finish.');
    if (session.status === 'error') throw new Error('Check the existing request or discard this tangent before sending another question.');
    if (session.messages.length >= C.LIMITS.turns * 2 || session.messages.reduce((n, m) => n + m.text.length, 0) >= C.LIMITS.sessionChars) throw new Error('This tangent is getting long. Keep it in ChatGPT or start a fresh tangent.');
    const question = C.clip(message.question, C.LIMITS.question);
    if (!question) throw new Error('Write a question first.');
    session.warmExpiresAt = 0; await chrome.alarms.clear('tmp:prewarm');
    session.requestId = crypto.randomUUID();
    diagnostic('startup:send', { at: Date.now(), hasHelper: Number.isInteger(session.helperTabId), preparing: preparationJob?.id === session.id });
    session.pendingPrompt = C.buildPrompt(session.context, question, !session.hasSubmitted);
    session.messages.push({ id: crypto.randomUUID(), role: 'user', text: question }, { id: session.requestId, role: 'assistant', text: '', tree: null });
    session.status = 'starting'; session.stage = 'helper_creating'; session.error = ''; session.errorCode = ''; session.probe = null; session.dispatched = false; session.submitted = false; session.stopRequested = false; session.uncertain = false; session.updatedAt = Date.now();
    await publish();
    await chrome.alarms.create('tmp:watchdog', { periodInMinutes: 1 });
    const id = session.id, requestId = session.requestId;
    setTimeout(() => runRequest(id, requestId), 0);
    return { ok: true, state: publicState() };
  }
  throw new Error('Unknown tmp.chat command.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('tmp:')) return;
  if (message.type === 'tmp:event' && message.event?.kind === 'stream' && sender.id === chrome.runtime.id && sender.tab?.id === session?.helperTabId && message.requestId === session?.requestId && firstEventRequest !== message.requestId) {
    firstEventRequest = message.requestId; diagnostic('stream:first-receive', { at: Date.now() });
  }
  const log = message.type !== 'tmp:event' && message.type !== 'tmp:hello';
  if (log) diagnostic('command', { type: message.type, tabId: sender.tab?.id });
  serial(() => handle(message, sender)).then(result => {
    if (log) diagnostic('result', { type: message.type, ok: result.ok, status: session?.status || 'empty' });
    respond(result);
  }, error => {
    // Platform errors can contain URLs or page details. Keep those out of diagnostics.
    diagnostic('command-failed', { type: message.type, status: session?.status || 'empty', code: stageCode(error.code) || 'COMMAND_FAILED' });
    respond({ ok: false, error: error.message });
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  if (!session) return;
  if (session.ownerTabId === tabId) await clearSession();
  else if (session.helperTabId === tabId) {
    if (!session.messages.length && !session.hasSubmitted && !session.dispatched) {
      session.helperTabId = null; delete session.helperDocumentId; session.warmExpiresAt = 0;
      await chrome.alarms.clear('tmp:prewarm'); await publish(); return;
    }
    session.helperTabId = null; session.status = 'error'; session.stage = 'helper_closed'; session.errorCode = 'HELPER_CLOSED';
    session.error = 'The background ChatGPT tab was closed. Copy anything useful, then discard this tangent to start another.'; session.uncertain = !!session.dispatched;
    await chrome.alarms.clear('tmp:watchdog'); await publish();
  }
}).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  serial(async () => {
    if (session?.ownerTabId === tabId) {
      if (!change.url.startsWith('https://chatgpt.com/')) await clearSession();
      else chrome.tabs.sendMessage(tabId, { type: 'tmp:navigation' }).catch(() => {});
    }
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'tmp:prewarm') {
    serial(async () => {
      if (!session?.warmExpiresAt || Date.now() < session.warmExpiresAt || session.messages.length || session.hasSubmitted || session.dispatched || session.retained || !Number.isInteger(session.helperTabId)) return;
      const tabId = session.helperTabId;
      let idle;
      try {
        const tab = await chrome.tabs.get(tabId), url = new URL(tab.url);
        if (!tab.active && !tab.pendingUrl && url.origin === 'https://chatgpt.com' && url.pathname === '/' && url.hash === '#tmp-chat-helper' && url.searchParams.get('temporary-chat') === 'true') {
          idle = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'tmp:idle' }, session.helperDocumentId ? { documentId: session.helperDocumentId } : undefined), 5000, helperError('HELPER_IDLE_TIMEOUT', 'agent_ready', 'The empty helper could not be verified.'));
        }
      } catch {}
      // Only the unchanged, empty native helper can be expired automatically.
      // A user draft, manual native send, or unverifiable document is retained.
      session.warmExpiresAt = 0;
      if (idle?.ok && idle.empty === true) {
        session.helperTabId = null; delete session.helperDocumentId;
        await publish(); await chrome.tabs.remove(tabId).catch(() => {});
        diagnostic('startup:expired');
      } else { await persist(); diagnostic('startup:expiry-retained'); }
    }).catch(() => {});
    return;
  }
  if (alarm.name !== 'tmp:watchdog') return;
  serial(async () => {
    if (!session || !C.busy(session.status)) { await chrome.alarms.clear(alarm.name); return; }
    if (Date.now() - session.updatedAt > 90000) {
      session.status = 'error'; session.errorCode = session.dispatched ? 'REQUEST_HEARTBEAT_TIMEOUT' : 'HELPER_START_TIMEOUT';
      session.error = session.dispatched
        ? 'ChatGPT stopped responding in the background. Open its tab, then choose Check again. Your question will not be resent automatically.'
        : 'The ChatGPT helper stopped responding during setup. Open its tab, then choose Check again. Nothing was sent.';
      session.uncertain = !!session.dispatched;
      diagnostic('watchdog:failed', { code: session.errorCode, stage: stageName(session.stage), dispatched: !!session.dispatched });
      await chrome.alarms.clear(alarm.name); await publish();
    }
  }).catch(() => {});
});
chrome.action.onClicked.addListener(tab => {
  if ((tab.url || '').startsWith('https://chatgpt.com/')) chrome.tabs.sendMessage(tab.id, { type: 'tmp:toggle' }).catch(() => {});
});
