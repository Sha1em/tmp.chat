/* Runs only in the extension-owned ChatGPT tab. No private endpoints or tokens. */
(function () {
  'use strict';
  if (globalThis.__tmpChatAgent) return;
  globalThis.__tmpChatAgent = true;
  const C = TmpCore;
  let current = null, preparation = null, preparedRoute = null, released = false;
  let preparedStartup = { stage: 'idle', marks: [] };
  const diagnostics = globalThis.__tmpChatAgentDiagnostics = [];
  function diagnostic(event, details = {}) {
    // Fixed event names, stages, counts and flags only. Never retain native
    // identity values, page text, prompts, URLs or authentication information.
    diagnostics.push({ event, time: Date.now(), ...details });
    if (diagnostics.length > 60) diagnostics.shift();
    console.debug('[tmp.chat agent]', event, details);
  }
  const clock = () => globalThis.performance?.now() ?? Date.now();
  function startupMark(run, phase) {
    run.startupAt ??= clock();
    run.startup ||= [];
    if (run.startup.some(entry => entry.phase === phase) || run.startup.length >= 24) return;
    const entry = { phase, at: Date.now(), elapsedMs: Math.max(0, clock() - run.startupAt), visibility: document.visibilityState || 'unknown' };
    run.startup.push(entry);
    diagnostic(`startup:${phase}`, entry);
  }
  function mark(run, phase, details = {}) {
    run.marks ||= new Set();
    if (run.marks.has(phase)) return;
    run.marks.add(phase);
    diagnostic(`stream:${phase}`, { at: Date.now(), elapsedMs: Date.now() - run.startedAt, visibility: document.visibilityState || 'unknown', ...details });
  }
  const COMPOSER = '#prompt-textarea, [data-testid="composer"] [contenteditable="true"], [data-testid="composer-shell"] [contenteditable="true"], #composer-background [contenteditable="true"], form .ProseMirror[contenteditable="true"], form [contenteditable="true"][role="textbox"], main [contenteditable="true"].ProseMirror, [contenteditable="true"][aria-label="Ask ChatGPT"], textarea[aria-label="Ask ChatGPT"], textarea[placeholder*="Message"], textarea[placeholder*="Ask"], textarea[placeholder*="message"]';
  const visible = element => !!element && !element.hidden && element.isConnected !== false && element.getAttribute('aria-hidden') !== 'true' && !element.closest('[hidden], [aria-hidden="true"], [inert]') && element.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility) && getComputedStyle(element).display !== 'none';
  const editors = () => [...document.querySelectorAll(COMPOSER)];
  const composer = () => editors().find(element => visible(element) && !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true' && (element instanceof HTMLTextAreaElement || element.isContentEditable));
  const control = selector => [...document.querySelectorAll(selector)].find(visible);
  const sendButton = () => control('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
  const stopButton = () => control('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]');
  const assistants = () => globalThis.TmpAnswer?.roots(document) || globalThis.TmpSelection?.assistantRoots(document) || [...document.querySelectorAll('[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-turn="assistant"]')];
  const users = () => globalThis.TmpSelection?.userRoots?.(document) || [...document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], [data-turn="user"]')].filter((element, index, list) => !list.some((parent, other) => index !== other && parent.contains?.(element)));
  function emit(event, run = current) {
    if (!run || run.preparing || released) return Promise.resolve();
    if (event.kind !== 'stream' && event.kind !== 'heartbeat') diagnostic('event', { kind: event.kind, attempted: !!run.attempted, cancelled: !!run.cancelled });
    if (event.kind === 'done') event.sequence = run.streamSequence || 0;
    return chrome.runtime.sendMessage({ type: 'tmp:event', sessionId: run.sessionId, requestId: run.requestId, event }).then(reply => {
      // Recover output only. A rejected/gapped delta must never replay Send.
      if (event.kind === 'stream' && reply?.resync && !run.resyncing && current === run && !released) {
        run.resyncing = true;
        return emit({ kind: 'stream', stage: 'response_stream', text: run.lastText || '', sequence: run.streamSequence }, run).finally(() => { run.resyncing = false; });
      }
      return reply;
    }).catch(() => { diagnostic('message-failed', { kind: event.kind }); });
  }
  function canonicalTemporaryConfirmed() {
    if (!conversationRoute().id || new URLSearchParams(location.search).get('temporary-chat') !== 'true') return false;
    const save = control('main header button[aria-label="Save chat"], main [role="banner"] button[aria-label="Save chat"]');
    return !!save && !save.closest('[data-message-author-role], [data-testid^="conversation-turn-"], [role="dialog"], [aria-modal="true"]');
  }
  function temporaryConfirmed() {
    if (control('[data-testid="temporary-chat-header"], [data-testid="temporary-chat-banner"], [data-testid="temporary-chat-button"][aria-pressed="true"], button[aria-label="Turn off temporary chat"]')) return true;
    // Current ChatGPT replaces the initial Temporary heading with Save chat.
    // The URL alone is never mode verification; require its native header UI.
    if (canonicalTemporaryConfirmed()) return true;
    const headings = [...document.querySelectorAll('main h1, main h2, main [role="heading"], header [role="heading"]')];
    return headings.some(element => visible(element) && !element.closest('[data-message-author-role], [data-testid^="conversation-turn-"], [role="dialog"], [aria-modal="true"]') && /^temporary(?: chat)?$/i.test(element.textContent.trim()));
  }
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].filter(visible);
  function temporaryChoice() {
    // Inspect only setup controls. Their text is never returned or logged.
    return dialogs().some(dialog => /temporary\s+chat|personalized|unpersonalized|personalisation|personalization/i.test(dialog.innerText || dialog.textContent || ''));
  }
  function temporaryControl() {
    return control('[data-testid="temporary-chat-button"]') || [...document.querySelectorAll('button')].find(element => visible(element) && !element.closest('[data-message-author-role], [data-testid^="conversation-turn-"]') && /^(?:turn on |start (?:a )?)?temporary(?: chat)?$/i.test(element.getAttribute('aria-label') || element.textContent.trim()));
  }
  function authGate() {
    return /\/(?:auth|login|log-in|sign-in)(?:\/|$)/i.test(location.pathname) || (!composer() && [...document.querySelectorAll('button,a')].some(element => visible(element) && /^(log in|sign in)$/i.test(element.textContent.trim())));
  }
  function probe() {
    const boxes = editors(), send = sendButton();
    return { documentState: document.readyState, hasMain: !!document.querySelector('main'), hasComposer: !!composer(), composerCount: boxes.filter(visible).length, hiddenComposerCount: boxes.filter(element => !visible(element)).length, temporary: temporaryConfirmed(), temporaryChoice: temporaryChoice(), dialogCount: dialogs().length, authGate: authGate(), sendPresent: !!send, sendEnabled: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true', assistantCount: assistants().length, userCount: users().length, continuationReason: current?.continuationReason || '' };
  }
  function problem(code, stage, text) { return Object.assign(new Error(text), { code, stage }); }
  function setStage(run, stage) {
    if (run.stage === stage) return;
    run.stage = stage; emit({ kind: 'stage', stage, probe: probe() }, run);
  }
  function pageProblem(stage) {
    const beforeSend = !['send_confirm', 'response_wait', 'response_stream'].includes(stage);
    const safety = beforeSend ? ' Nothing was sent.' : ' Your question will not be resent automatically.';
    if (authGate()) return problem('SIGN_IN_REQUIRED', stage, 'ChatGPT needs sign-in. Open its tab, finish signing in, then choose Check again.' + safety);
    if (temporaryChoice()) return problem('TEMPORARY_CHOICE_REQUIRED', 'temporary_setup', 'ChatGPT requires a Temporary Chat setup or personalization choice. Open its tab, choose your preference, then return and choose Check again.' + safety);
    if (dialogs().length) return problem('SETUP_DIALOG_REQUIRED', 'temporary_setup', 'A ChatGPT dialog needs your attention. Open its tab, finish the setup, then return and choose Check again.' + safety);
    const alerts = [...document.querySelectorAll('[role="alert"], [data-testid="error-message"]')].filter(visible);
    const text = alerts.map(element => element.innerText).join(' ');
    if (/limit|try again|something went wrong|unusual activity|failed|error|sign in|log in/i.test(text)) return problem('NATIVE_PAGE_ERROR', stage, 'ChatGPT is displaying an error or account limit. Open its tab to inspect it, then choose Check again.');
    return null;
  }
  function until(check, timeout = 20000, run = null, timeoutError = problem('COMPOSER_NOT_FOUND', 'composer_ready', 'The ChatGPT page loaded, but its message composer was not found or ready. Open its tab to inspect it, then choose Check again. Nothing was sent.')) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const observer = new MutationObserver(inspect);
      const timer = setTimeout(() => finish(timeoutError), timeout);
      const cancel = () => finish(null, null);
      if (run) (run.waiters ||= new Set()).add(cancel);
      function finish(error, value) { if (finished) return; finished = true; observer.disconnect(); clearTimeout(timer); run?.waiters?.delete(cancel); error ? reject(error) : resolve(value); }
      function inspect() { try { if (run && halted(run)) { cancel(); return; } const value = check(); if (value) finish(null, value); } catch (e) { finish(e); } }
      // Hydration can identify an existing composer/control or change the
      // Temporary heading without inserting any element. Watch the predicates'
      // inputs, including changes to existing text nodes; never poll for focus.
      observer.observe(document.documentElement || document, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['id', 'data-testid', 'aria-label', 'placeholder', 'role', 'disabled', 'readonly', 'aria-disabled', 'aria-hidden', 'aria-pressed', 'contenteditable', 'hidden', 'inert', 'style', 'class'] });
      inspect();
    });
  }
  function treeOf(element) {
    let count = 0;
    function convert(node, depth = 0) {
      if (++count > 2200 || depth > 24) return [];
      if (node.nodeType === Node.TEXT_NODE) return [{ text: node.textContent }];
      if (node.nodeType !== Node.ELEMENT_NODE) return [];
      const tag = node.tagName.toLowerCase();
      if (['button', 'script', 'style', 'svg', 'img', 'form', 'input', 'textarea'].includes(tag) || node.getAttribute('aria-hidden') === 'true') return [];
      const children = [...node.childNodes].flatMap(n => convert(n, depth + 1));
      if (!C.TAGS.has(tag)) return children;
      return [{ tag, children, ...(tag === 'a' ? { href: C.safeURL(node.href) } : {}) }];
    }
    return C.cleanTree([...element.childNodes].flatMap(n => convert(n)));
  }
  function answerNode(run) {
    if (!run.clicked) return null;
    if (run.activeAnswer?.isConnected !== false && run.activeAnswer && !run.discoverDirty) return run.activeAnswer;
    run.discoverDirty = false;
    const list = assistants();
    run.discoveryCount = (run.discoveryCount || 0) + 1;
    const userList = users(), anchor = userList.length > run.baselineUsers ? userList.at(-1) : null;
    const baseline = run.baselineAnswers || [];
    const candidate = [...list].reverse().find(node => {
      const key = globalThis.TmpAnswer?.identity(node) || '';
      if (key && baseline.some(item => item.key === key)) return false;
      const previous = baseline.find(item => item.node === node);
      if (previous && (!key || previous.key === key)) return false;
      if (anchor?.compareDocumentPosition) return !!(anchor.compareDocumentPosition(node) & 4);
      // Without a stable key or current-user ordering, an old remount is not
      // evidence of a new answer. Fail closed on an ambiguous replacement.
      return !!key || list.length > baseline.length;
    }) || null;
    run.activeAnswer = candidate;
    if (candidate) mark(run, 'root', { discoveries: run.discoveryCount });
    return candidate;
  }
  const answerBody = node => node?.querySelector('.markdown, [data-message-content], [data-markdown-copy]') || node;
  function readAnswer(node, structured = false) {
    if (!node) return { text: '', tree: [], notices: [] };
    if (globalThis.TmpAnswer) return TmpAnswer.snapshot(node, { tree: structured });
    // Compatibility for an adapter already running before an extension reload.
    const body = answerBody(node);
    const raw = body.innerText || '';
    return { text: C.streamText('', { text: raw }), ...(structured ? { tree: treeOf(body) } : {}), notices: raw.length > C.LIMITS.answer ? ['truncated'] : [] };
  }
  // Speed is explicitly opt-in: never touch a global header model picker or
  // invent a model name. Only a recognized effort menu beside this composer.
  function effortPicker(box) {
    const scope = box?.closest('form, [data-testid="composer"], [data-testid="composer-shell"], #composer-background');
    if (!scope) return null;
    const choices = [...scope.querySelectorAll('button[aria-haspopup="menu"], button[aria-haspopup="listbox"]')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && /^(?:instant|light|low|medium|high|extra high|standard|extended|thinking|auto)$/i.test((element.getAttribute('aria-label') || element.textContent || '').trim()));
    return choices.length === 1 ? choices[0] : null;
  }
  const instantSelected = box => /^instant$/i.test((effortPicker(box)?.getAttribute('aria-label') || effortPicker(box)?.textContent || '').trim());
  async function configureSpeed(run, box) {
    const report = speedStatus => emit({ kind: 'stage', stage: 'speed_setup', speedStatus }, run);
    if (run.speed !== 'instant') { await report('current'); return; }
    setStage(run, 'speed_setup'); await report('checking');
    if (halted(run)) return;
    if (instantSelected(box)) { await report('instant'); return; }
    const picker = effortPicker(box);
    if (!picker || picker.getAttribute('aria-expanded') === 'true') { await report('unavailable'); return; }
    const menus = () => [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(visible);
    // An unrelated open menu must not be mistaken for this effort control.
    if (menus().length) { await report('unavailable'); return; }
    const closeOwnedMenu = () => {
      try { if (picker.isConnected !== false && picker.getAttribute('aria-expanded') === 'true') picker.click(); }
      catch { diagnostic('speed-menu-close-failed'); }
    };
    picker.click();
    let menu;
    try { menu = await until(() => {
      const list = menus(), controlled = picker.getAttribute('aria-controls');
      return controlled ? list.find(element => element.id === controlled) : list.length === 1 ? list[0] : null;
    }, 1500, run, problem('SPEED_MENU_UNAVAILABLE', 'speed_setup', 'The native answer-speed menu did not open.')); }
    catch { closeOwnedMenu(); if (!halted(run)) await report('unavailable'); return; }
    if (halted(run) || !menu) { closeOwnedMenu(); return; }
    const options = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && /^Instant(?:\s|$)/i.test((element.getAttribute('aria-label') || element.textContent || '').trim()));
    if (options.length !== 1) { closeOwnedMenu(); await report('unavailable'); return; }
    options[0].click();
    const unverified = problem('SPEED_UNVERIFIED', 'speed_setup', 'Instant was requested, but ChatGPT did not confirm the selected speed. Open its tab to check the setting, or choose Use current ChatGPT setting in tmp.chat before checking again. Nothing was sent.');
    try { await until(() => instantSelected(composer()), 1500, run, unverified); }
    catch { await report('unverified'); throw unverified; }
    if (!halted(run)) await report('instant');
  }
  function recordSubmission(run, node, stopping) {
    if (!run.clicked) return;
    if (run.submissionRecorded) {
      // Stop can acknowledge Send before React mounts either message. Capture
      // our first real answer once, independently of that acknowledgement.
      if (node && !run.answerProofRecorded) {
        run.answerProofRecorded = true;
        rememberConversation(run, node);
      }
      return;
    }
    if (!(stopping || node || users().length > run.baselineUsers || visible(stopButton()))) return;
    run.submissionRecorded = true; run.continuation = true;
    startupMark(run, 'submission-observed');
    run.answerProofRecorded = !!node;
    rememberConversation(run, node);
  }
  function conversationRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const id = path.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)$/)?.[1] || '';
    return { key: id ? `conversation:${id}` : path, id, entry: path === '/' };
  }
  function conversationIds(nodes) {
    const ids = new Set();
    for (const node of nodes) {
      const bound = node.closest?.('[data-chatgpt-selection-conversation-id]');
      for (const element of [node, bound, ...node.querySelectorAll('[data-chatgpt-selection-conversation-id]')]) {
        const id = element?.getAttribute('data-chatgpt-selection-conversation-id');
        if (id) ids.add(id);
      }
    }
    return ids;
  }
  function conversationFacts(node) {
    const facts = {};
    for (const name of ['data-message-id', 'data-chatgpt-search-message-ids', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key']) {
      const value = node.getAttribute(name);
      if (value) facts[name] = value;
    }
    const name = 'data-chatgpt-selection-message-id';
    const value = node.getAttribute(name) || node.querySelector(`[${name}]`)?.getAttribute(name);
    if (value) facts[name] = value;
    return facts;
  }
  const anchorConflict = (anchor, facts) => Object.entries(anchor.facts).some(([name, value]) => facts[name] && facts[name] !== value);
  const anchorOverlap = (anchor, facts) => Object.entries(anchor.facts).some(([name, value]) => facts[name] === value);
  const anchorMatches = (anchor, candidate) => !anchorConflict(anchor, candidate.facts) && (anchor.primary ? candidate.facts[anchor.primary] === anchor.facts[anchor.primary] : candidate.node === anchor.node);
  function rememberConversation(run, node = run.activeAnswer) {
    if (!run.clicked || !run.continuation) return;
    const proof = run.conversationProof ||= { document, route: conversationRoute(), id: '', anchors: [], initialRequestId: run.requestId };
    const route = conversationRoute();
    // Completion must not silently rebase an inherited proof after navigation.
    if (proof.document !== document || proof.route.key !== route.key && !(proof.route.entry && route.id)) { diagnostic('conversation:capture-skipped', { reason: 'route' }); return; }
    const anchors = [{ node, role: 'assistant' }, { node: users().at(-1), role: 'user' }]
      .filter(anchor => anchor.node && anchor.node.isConnected !== false)
      .map(anchor => {
        const facts = conversationFacts(anchor.node);
        return { ...anchor, facts, primary: Object.keys(facts)[0] || '' };
      });
    const ids = conversationIds(anchors.map(anchor => anchor.node));
    // Never overwrite known identity with contradictory native metadata.
    if (ids.size > 1 || proof.id && ids.size && !ids.has(proof.id)) { diagnostic('conversation:capture-skipped', { reason: 'native-identity', identities: ids.size }); return; }
    for (const anchor of anchors) {
      const previous = proof.anchors.find(saved => saved.role === anchor.role && (saved.node === anchor.node || anchorOverlap(saved, anchor.facts)));
      if (!previous) continue;
      if (anchorConflict(previous, anchor.facts)) { diagnostic('conversation:capture-skipped', { reason: 'anchor' }); return; }
      // Preserve facts learned by earlier checks when completion refreshes the
      // same anchor. Missing metadata is never permission to forget a fact.
      anchor.facts = { ...previous.facts, ...anchor.facts };
      anchor.primary = previous.primary || anchor.primary;
    }
    const retained = proof.anchors.some(saved => anchors.some(anchor => saved.role === anchor.role && anchorMatches(saved, anchor)));
    const strongAnswer = anchors.some(anchor => anchor.role === 'assistant' && ['data-message-id', 'data-chatgpt-search-message-ids', 'data-chatgpt-selection-message-id'].some(name => anchor.facts[name]));
    diagnostic('conversation:captured', { priorAnchors: proof.anchors.length, anchors: anchors.length, retained, strongAnswer, identities: ids.size, canonical: !!route.id, canonicalTemporary: canonicalTemporaryConfirmed(), initialRequest: proof.initialRequestId === run.requestId, emptyBaseline: run.baselineUsers === 0 && run.baselineAnswers?.length === 0 });
    // Native selection IDs and URL IDs are different namespaces on live
    // ChatGPT. Bind the first canonical URL only during our initial owned,
    // acknowledged answer, while prior message evidence and native Temporary
    // UI still corroborate it. Later follow-ups cannot invent this binding.
    if (proof.route.entry && route.id && proof.initialRequestId === run.requestId && run.submissionRecorded && run.baselineUsers === 0 && run.baselineAnswers?.length === 0 && retained && strongAnswer && ids.size === 1 && canonicalTemporaryConfirmed()) {
      proof.route = route;
      proof.canonicalTemporary = true;
      diagnostic('conversation:canonical-bound', { retained: true, nativeIdentity: true });
    }
    if (proof.route.key === route.key && route.id && canonicalTemporaryConfirmed()) proof.canonicalTemporary = true;
    if (!proof.id && ids.size === 1) proof.id = [...ids][0];
    if (anchors.length) proof.anchors = anchors;
  }
  function verifyContinuation(run) {
    if (!run.continuation) {
      if (preparedRoute !== null && !run.clicked && (conversationRoute().key !== preparedRoute || users().length || assistants().length)) {
        throw problem('HELPER_CHANGED', 'temporary_setup', 'The prepared ChatGPT tab changed or already contains messages. Open it to inspect it. Nothing was sent.');
      }
      return;
    }
    run.continuationReason = '';
    const proof = run.conversationProof, route = conversationRoute();
    const reject = reason => {
      run.continuationReason = reason;
      diagnostic('conversation:rejected', { reason });
      throw problem('CONVERSATION_CHANGED', 'temporary_setup', 'The background chat changed or its previous messages could not be verified. Open it to check your conversation. Nothing was sent.');
    };
    if (!proof || proof.document !== document) reject('document');
    // A different concrete conversation path is a navigation, even if the old
    // messages remain visible briefly during an SPA transition.
    if (proof.route.key !== route.key && !(proof.route.entry && route.id)) reject('route');
    const lists = { assistant: assistants(), user: users() };
    const candidates = Object.fromEntries(Object.entries(lists).map(([role, nodes]) => [role, nodes.map(node => ({ node, facts: conversationFacts(node) }))]));
    const matches = [];
    for (const anchor of proof.anchors) {
      const list = candidates[anchor.role];
      // A surviving user anchor cannot override contradictory identity on the
      // saved answer, including a remount retaining its original unit key.
      if (list.some(candidate => (candidate.node === anchor.node || anchorOverlap(anchor, candidate.facts)) && anchorConflict(anchor, candidate.facts))) reject('anchor');
      const possible = list.filter(candidate => anchorMatches(anchor, candidate));
      const retained = possible.find(candidate => candidate.node === anchor.node);
      if (!retained && possible.length > 1) reject('anchor');
      const candidate = retained || possible[0];
      if (candidate) matches.push({ anchor, candidate });
    }
    const matched = matches.map(({ candidate }) => candidate.node);
    // Virtualization can remove our last message. An already known native
    // conversation ID may instead be corroborated by other bounded live turns.
    const ids = conversationIds(matched.length ? matched : [...lists.assistant, ...lists.user]);
    if (!matched.length && (!proof.id || ids.size !== 1 || !ids.has(proof.id))) reject('anchor');
    if (ids.size > 1 || proof.id && ids.size && !ids.has(proof.id)) reject('native-identity');
    const id = proof.id || (ids.size === 1 ? [...ids][0] : '');
    const canonicalized = proof.route.key !== route.key;
    // Entry -> /c/id is valid only when that exact native conversation ID is
    // carried by a retained message from our verified temporary conversation.
    if (canonicalized && (!id || id !== route.id || !temporaryConfirmed())) reject('canonical-route');
    const temporaryOff = control('[data-testid="temporary-chat-button"][aria-pressed="false"],button[aria-label="Turn on temporary chat"]');
    if (temporaryOff || new URLSearchParams(location.search).get('temporary-chat') === 'false' || proof.canonicalTemporary && !temporaryConfirmed()) reject('temporary-off');
    // Enrichment changes the adapter's priority key, not message identity. Add
    // newly corroborated namespaces only after all continuation guards pass.
    for (const { anchor, candidate } of matches) {
      anchor.node = candidate.node;
      anchor.facts = { ...anchor.facts, ...candidate.facts };
      anchor.primary ||= Object.keys(anchor.facts)[0] || '';
    }
    proof.route = route; proof.id = id;
    if (canonicalTemporaryConfirmed()) proof.canonicalTemporary = true;
    diagnostic('conversation:verified', { canonicalized, stableIdentity: !!id, anchors: matched.length });
  }
  function cleanup(run) {
    run.observer?.disconnect(); run.guard?.disconnect(); clearTimeout(run.updateTimer); clearTimeout(run.finishTimer); clearTimeout(run.timeout); clearInterval(run.heartbeat);
    run.observer = null; run.guard = null; run.observedAnswer = null; run.heartbeat = null; run.inspect = null;
    run.updateTimer = null; run.finishTimer = null; run.timeout = null;
    for (const cancel of run.waiters || []) cancel();
  }
  function complete(run, text, tree, notices = []) {
    if (released || current !== run || run.finished) return;
    rememberConversation(run);
    run.finished = true; cleanup(run);
    emit({ kind: 'done', text, notices, ...(tree ? { tree } : {}), ...(run.cancelled && !run.clicked ? { cancelledBeforeSend: true, continuation: !!run.continuation } : {}) }, run);
  }
  function halted(run) {
    return released || (run.preparing ? preparation !== run : current !== run) || run.finished || run.cancelled;
  }
  function clearOwnedDraft(run) {
    const box = run.box;
    if (run.clicked || !run.draftOwned || !box || !C.sameDraft(box.innerText || box.value || '', run.prompt)) return;
    // Cancel only the exact draft we inserted; never erase a user's replacement.
    if (box instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      box.focus(); const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('delete', false);
    }
    run.draftOwned = false;
  }
  function watch(run) {
    cleanup(run);
    run.finished = false;
    if (run.clicked && !run.lastText) setStage(run, 'response_wait');
    let lastText = run.lastText || '', seenStreaming = false;
    let dirty = true, controlsDirty = true, lastFlush = -Infinity;
    const attributes = [...(globalThis.TmpAnswer?.observedAttributes || ['data-message-author-role', 'data-turn', 'data-testid', 'hidden', 'aria-hidden']), 'disabled', 'aria-busy', 'aria-label'];
    const boundary = globalThis.TmpAnswer?.boundarySelector || '[data-message-author-role="assistant"],[data-testid="assistant-message"],[data-turn="assistant"]';
    const containsBoundary = node => node?.nodeType === 1 && (node.matches?.(boundary) || !!node.querySelector?.(boundary));
    function bind(node) {
      if (run.observedAnswer === node) return;
      run.observer?.disconnect(); run.observedAnswer = node;
      if (!node) return;
      run.observer = new MutationObserver(records => {
        // Identity/visibility changes invalidate the cache; text-only changes do not.
        if (records?.some(record => record.type === 'attributes' && (record.attributeName !== 'class' || record.target === run.activeAnswer))) run.discoverDirty = true;
        schedule(true);
      });
      run.observer.observe(node, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: [...attributes, 'class'] });
    }
    function inspect() {
      if (released || current !== run || run.finished) return;
      lastFlush = clock();
      const node = answerNode(run);
      bind(node);
      // Keep the last snapshot through transient root replacement. A verified
      // empty response may still intentionally replace previously emitted text.
      let text = lastText;
      if (node && dirty) {
        text = readAnswer(node).text;
        run.extractionCount = (run.extractionCount || 0) + 1;
        if (text) mark(run, 'extract', { characters: text.length, extractions: run.extractionCount });
      }
      dirty = false;
      const stopping = visible(stopButton());
      recordSubmission(run, node, stopping);
      if (run.cancelled && !stopping) { complete(run, text || run.lastText || ''); return; }
      seenStreaming ||= stopping;
      if (text !== lastText) {
        const change = text.startsWith(lastText) ? { delta: text.slice(lastText.length), offset: lastText.length } : { text };
        lastText = text; run.lastText = text;
        run.stage = 'response_stream';
        run.streamSequence = (run.streamSequence || 0) + 1;
        mark(run, 'emit', { characters: text.length });
        emit({ kind: 'stream', stage: 'response_stream', sequence: run.streamSequence, ...change }, run);
      }
      clearTimeout(run.finishTimer);
      if (text && !stopping && (seenStreaming || Date.now() - run.startedAt > 1800)) {
        run.finishTimer = setTimeout(() => {
          if (visible(stopButton()) || !answerNode(run)) { schedule(true); return; }
          const finalNode = answerNode(run);
          const final = readAnswer(finalNode, true);
          const finalText = final.text;
          if (finalText !== lastText) { schedule(true); return; }
          diagnostic('answer-complete', { at: Date.now(), characters: finalText.length, notices: final.notices, discoveries: run.discoveryCount || 0, extractions: run.extractionCount || 0 });
          complete(run, finalText, final.tree, final.notices);
        }, 1100);
      }
      const checkPage = controlsDirty || !run.problemCheckedAt || clock() - run.problemCheckedAt >= 1000;
      controlsDirty = false;
      if (checkPage) run.problemCheckedAt = clock();
      const failure = checkPage ? pageProblem(run.stage) : null;
      if (failure) { run.finished = true; cleanup(run); emit({ kind: 'error', text: failure.message, code: failure.code, stage: failure.stage, probe: probe(), attempted: run.attempted }, run); }
    }
    function schedule(answerChanged = false) {
      if (run.finished || released || current !== run) return;
      dirty ||= answerChanged;
      mark(run, 'observe');
      const elapsed = clock() - lastFlush;
      // MutationObserver already batches synchronous writes. Do not put first
      // text, or an overdue meaningful mutation, behind a hidden-page timer.
      if (!lastText || elapsed >= 120) {
        clearTimeout(run.updateTimer); run.updateTimer = null; inspect(); return;
      }
      if (run.updateTimer) return;
      mark(run, 'timer-scheduled');
      run.updateTimer = setTimeout(() => { mark(run, 'timer-fired'); run.updateTimer = null; inspect(); }, 120 - elapsed);
    }
    run.guard = new MutationObserver(records => {
      if (run.finished || released || current !== run) return;
      // Observe structure outside the active answer without extracting it on
      // unrelated page mutations. This survives replacement of main itself.
      if (!records || !run.activeAnswer || run.activeAnswer.isConnected === false) {
        const relevant = record => record.target?.closest?.('main') || record.target?.matches?.('button,[role="alert"],[role="dialog"]') ||
          record.type === 'attributes' && ['hidden', 'aria-hidden', 'inert'].includes(record.attributeName) ||
          [...record.addedNodes || [], ...record.removedNodes || []].some(node => node?.matches?.('main') || containsBoundary(node) || node?.querySelector?.('main,button,[role="alert"],[role="dialog"]'));
        if (records && !records.some(relevant)) return;
        run.discoverDirty = true; controlsDirty = true; schedule(true); return;
      }
      let changed = false;
      for (const record of records) {
        if (run.activeAnswer.contains?.(record.target)) continue;
        const nodes = [record.target, ...record.addedNodes || [], ...record.removedNodes || []];
        if ((record.type === 'attributes' && (containsBoundary(record.target) || record.target.contains?.(run.activeAnswer))) || nodes.slice(1).some(containsBoundary)) {
          run.discoverDirty = true; changed = true;
        }
        if (record.target?.matches?.('button,[role="alert"],[role="dialog"],[aria-modal="true"]') || nodes.slice(1).some(node => node?.matches?.('button,[role="alert"],[role="dialog"],[aria-modal="true"]') || node?.querySelector?.('button,[role="alert"],[role="dialog"]'))) controlsDirty = true;
      }
      if (changed || controlsDirty) schedule(changed);
    });
    run.inspect = inspect;
    run.discoverDirty = true;
    run.guard.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: attributes });
    run.heartbeat = setInterval(() => { run.discoverDirty = true; dirty = true; inspect(); emit({ kind: 'heartbeat' }, run); }, 20000);
    run.timeout = setTimeout(() => { if (run.finished || released || current !== run) return; run.finished = true; cleanup(run); emit({ kind: 'error', code: run.lastText ? 'RESPONSE_TIMEOUT' : 'RESPONSE_NOT_FOUND', stage: run.lastText ? 'response_stream' : 'response_wait', text: run.lastText ? 'The ChatGPT answer has not finished. Open its tab to inspect it, then choose Check again to observe the existing answer. Your question will not be resent.' : 'No assistant answer was detected for the existing send attempt. Open ChatGPT to inspect it, then choose Check again to observe the existing attempt. Your question will not be resent.', probe: probe(), attempted: run.attempted }, run); }, 240000);
    inspect();
  }
  function prepareNative() {
    if (released) return Promise.resolve({ ok: false, code: 'HELPER_RELEASED', stage: 'agent_ready', error: 'This tab was handed back to you. Start a new tangent.' });
    if (current) return Promise.resolve({ ok: true, probe: probe() });
    if (preparation) return preparation.promise;
    const run = { preparing: true, startedAt: Date.now(), route: conversationRoute().key };
    preparation = run;
    run.promise = (async () => {
      try {
        run.stage = 'composer_ready'; startupMark(run, 'prepare-received');
        // No focus, draft insertion, preference change, or native Send here.
        await until(() => { const failure = pageProblem('composer_ready'); if (failure) throw failure; return composer(); }, 20000, run);
        if (halted(run)) return { ok: false, code: 'HELPER_RELEASED', stage: 'agent_ready' };
        startupMark(run, 'prepare-composer-ready'); run.stage = 'temporary_setup';
        if (users().length || assistants().length) throw problem('HELPER_NOT_EMPTY', 'temporary_setup', 'The prepared ChatGPT tab already contains messages. Open it to inspect it. Nothing was sent.');
        if (!temporaryConfirmed()) {
          const toggle = temporaryControl();
          if (!toggle || toggle.disabled || toggle.getAttribute('aria-disabled') === 'true') throw problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified. Open the ChatGPT tab, turn on Temporary Chat, then choose Check again. Nothing was sent.');
          toggle.click();
          await until(() => { const failure = pageProblem('temporary_setup'); if (failure) throw failure; return temporaryConfirmed(); }, 8000, run,
            problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified after opening its setup. Open the ChatGPT tab to finish setup, then choose Check again. Nothing was sent.'));
        }
        if (halted(run)) return { ok: false, code: 'HELPER_RELEASED', stage: 'agent_ready' };
        startupMark(run, 'prepare-temporary-verified'); run.stage = 'composer_ready';
        await until(() => { const failure = pageProblem('composer_ready'); if (failure) throw failure; return composer(); }, 20000, run);
        if (halted(run)) return { ok: false, code: 'HELPER_RELEASED', stage: 'agent_ready' };
        const failure = pageProblem('temporary_setup'); if (failure) throw failure;
        if (!temporaryConfirmed()) throw problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified. Nothing was sent.');
        if (conversationRoute().key !== run.route || preparedRoute !== null && preparedRoute !== run.route || users().length || assistants().length || visible(stopButton())) throw problem('HELPER_CHANGED', 'temporary_setup', 'The prepared ChatGPT tab changed or already contains messages. Open it to inspect it. Nothing was sent.');
        preparedRoute = run.route;
        run.stage = 'ready'; startupMark(run, 'prepare-ready');
        diagnostic('startup:native-ready', { at: Date.now(), elapsedMs: Date.now() - run.startedAt, documentState: document.readyState });
        return { ok: true, probe: probe() };
      } catch (error) {
        run.stage = error.stage || 'composer_ready'; startupMark(run, 'prepare-failed');
        return { ok: false, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'HELPER_PREPARE', stage: error.stage || 'composer_ready', error: error.code ? error.message : 'The ChatGPT helper could not be prepared. Nothing was sent.' };
      } finally { preparedStartup = { stage: run.stage, marks: run.startup || [] }; cleanup(run); if (preparation === run) preparation = null; }
    })();
    return run.promise;
  }
  async function execute(run) {
    try {
      startupMark(run, 'run-received');
      setStage(run, 'composer_ready');
      let box = await until(() => { const failure = pageProblem('composer_ready'); if (failure) throw failure; return composer(); }, 20000, run);
      if (halted(run)) return;
      run.box = box;
      startupMark(run, 'composer-ready');
      // First request must positively identify Temporary Chat before any context is sent.
      setStage(run, 'temporary_setup');
      if (!run.continuation && !temporaryConfirmed()) {
        const toggle = temporaryControl();
        if (!toggle || toggle.disabled || toggle.getAttribute('aria-disabled') === 'true') throw problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified. Open the ChatGPT tab, turn on Temporary Chat, then return and choose Check again. Nothing was sent.');
        if (!run.temporaryRequested) { run.temporaryRequested = true; toggle.click(); }
        await until(() => { const failure = pageProblem('temporary_setup'); if (failure) throw failure; return temporaryConfirmed(); }, 8000, run, problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified after opening its setup. Open the ChatGPT tab, finish Temporary Chat setup, then choose Check again. Nothing was sent.'));
        if (halted(run)) return;
      }
      const setupFailure = pageProblem('temporary_setup'); if (setupFailure) throw setupFailure;
      verifyContinuation(run);
      startupMark(run, 'temporary-verified');
      // Switching Temporary Chat can replace the native editor. Resolve the live
      // editor again after setup instead of inserting into a detached old one.
      if (composer() !== box) {
        setStage(run, 'composer_ready');
        box = await until(() => { const failure = pageProblem('composer_ready'); if (failure) throw failure; return composer(); }, 20000, run);
        if (halted(run)) return;
        run.box = box;
      }
      if (visible(stopButton())) throw problem('NATIVE_BUSY', 'draft_insert', 'ChatGPT is already answering. Open its tab and finish that answer first. Nothing was sent.');
      if ((box.innerText || box.value || '').trim() && !(run.draftOwned && C.sameDraft(box.innerText || box.value || '', run.prompt))) throw problem('DRAFT_PRESENT', 'draft_insert', 'There is a draft in the ChatGPT tab. Clear or send it there before checking again. Nothing was overwritten.');
      await configureSpeed(run, box);
      if (halted(run)) return;
      if (composer() !== box) {
        box = await until(() => { const failure = pageProblem('composer_ready'); if (failure) throw failure; return composer(); }, 20000, run);
        if (halted(run)) return;
        run.box = box;
      }
      if (!run.continuation && !temporaryConfirmed()) throw problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified after preparing the composer. Open its tab to check Temporary Chat, then choose Check again. Nothing was sent.');
      verifyContinuation(run);
      if (visible(stopButton())) throw problem('NATIVE_BUSY', 'draft_insert', 'ChatGPT is already answering. Open its tab and finish that answer first. Nothing was sent.');
      setStage(run, 'draft_insert');
      const existingDraft = (box.innerText || box.value || '').trim();
      if (existingDraft && !(run.draftOwned && C.sameDraft(existingDraft, run.prompt))) throw problem('DRAFT_PRESENT', 'draft_insert', 'There is a draft in the ChatGPT tab. Clear or send it there before checking again. Nothing was overwritten.');
      run.baselineAnswers = assistants().map(node => ({ node, key: globalThis.TmpAnswer?.identity(node) || '' }));
      run.baselineUsers = users().length;
      box.focus();
      if (existingDraft && run.draftOwned) {
        // Resume only the exact draft this request inserted before a confirmed pre-send failure.
      } else if (box instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, run.prompt);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const selection = getSelection(), range = document.createRange();
        range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, run.prompt)) throw problem('DRAFT_INSERT_FAILED', 'draft_insert', 'ChatGPT did not accept the draft. Open its tab to check the composer. Nothing was sent.');
      }
      const actual = (box.innerText || box.value || '').replace(/\r\n/g, '\n').trim();
      if (!C.sameDraft(actual, run.prompt)) throw problem('DRAFT_MISMATCH', 'draft_insert', 'The ChatGPT draft could not be verified. Open its tab to inspect it. Nothing was sent.');
      run.draftOwned = true;
      startupMark(run, 'draft-inserted');
      setStage(run, 'send_ready');
      const sendTimeout = problem('SEND_NOT_READY', 'send_ready', 'The question is in the ChatGPT composer, but its Send control did not become ready. Open its tab to inspect it, then choose Check again. Nothing was sent.');
      const readySend = () => {
        const failure = pageProblem('send_ready'); if (failure) throw failure;
        if (!run.continuation && !temporaryConfirmed()) throw problem('TEMPORARY_UNVERIFIED', 'temporary_setup', 'Temporary Chat could not be verified before submission. Open its tab to inspect it. Nothing was sent.');
        verifyContinuation(run);
        const liveBox = composer();
        if (!liveBox) return null;
        if (!C.sameDraft(liveBox.innerText || liveBox.value || '', run.prompt)) throw problem('DRAFT_MISMATCH', 'send_ready', 'The ChatGPT draft changed before submission. Open its tab to inspect it. Nothing was sent or overwritten.');
        run.box = liveBox;
        if (visible(stopButton())) throw problem('NATIVE_BUSY', 'send_ready', 'ChatGPT is already answering. Open its tab and finish that answer first. Nothing was sent.');
        const button = sendButton();
        return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? { box: liveBox, button } : null;
      };
      await until(readySend, 8000, run, sendTimeout);
      if (halted(run)) return;
      startupMark(run, 'send-ready');
      run.attempted = true; run.startedAt = Date.now();
      // Mark the attempt before the one and only click. Never automatically replay a send.
      run.stage = 'send_confirm'; startupMark(run, 'attempt-ack-start');
      const acknowledgement = await emit({ kind: 'submitted', stage: 'send_confirm', probe: probe() }, run);
      if (halted(run)) return;
      startupMark(run, 'attempt-ack-end');
      if (!acknowledgement?.ok) throw problem('SUBMISSION_NOT_RECORDED', 'send_confirm', 'The extension could not confirm its submission checkpoint. Nothing was sent. Choose Check again to retry setup.');
      // Saving the checkpoint yields to the page: React may replace the editor
      // or Send button. Resolve and validate the live owned draft again. Never
      // click the stale pre-checkpoint element or insert a replacement draft.
      await until(readySend, 8000, run, sendTimeout);
      if (halted(run)) return;
      const live = readySend();
      if (!live) throw sendTimeout;
      run.box = live.box;
      watch(run); if (halted(run)) return;
      // No asynchronous work between the final validation and this single click.
      run.clicked = true; startupMark(run, 'native-send'); live.button.click(); startupMark(run, 'native-click-return'); setStage(run, 'send_confirm');
      await until(() => users().length > run.baselineUsers || answerNode(run) || visible(stopButton()), 15000, run, problem('SEND_UNCONFIRMED', 'send_confirm', 'The ChatGPT Send control was clicked, but submission could not be confirmed. Open its tab to inspect the existing attempt. Check again only observes it; your question will not be resent.'));
      if (halted(run)) return;
      recordSubmission(run);
      if (!run.lastText) setStage(run, 'response_wait');
    } catch (error) {
      if (halted(run)) return;
      cleanup(run); run.finished = true;
      const cancelledBeforeSend = !run.clicked;
      if (cancelledBeforeSend) run.attempted = false;
      startupMark(run, 'failed');
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : run.attempted ? 'SEND_FAILED' : 'SETUP_FAILED';
      const stage = error.stage || run.stage;
      run.stage = stage;
      diagnostic('setup-failed', { code, stage, attempted: !!run.attempted, probe: probe() });
      await emit({ kind: 'error', code, stage, text: error.code ? error.message : run.attempted ? 'The ChatGPT adapter failed after starting a send attempt. Open its tab to inspect it. Your question will not be resent automatically.' : 'The ChatGPT adapter could not finish setup. Open its tab to inspect it, then choose Check again. Nothing was sent.', probe: probe(), attempted: run.attempted, ...(cancelledBeforeSend ? { cancelledBeforeSend: true, continuation: !!run.continuation } : {}) }, run);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('tmp:')) return;
    diagnostic('command', { type: message.type, active: !!current && !current.finished });
    if (message.type === 'tmp:startup') { respond({ ok: true, stage: current?.stage || preparation?.stage || 'idle', marks: (current?.startup || []).map(entry => ({ ...entry })), preparation: { stage: preparation?.stage || preparedStartup.stage, marks: (preparation?.startup || preparedStartup.marks).map(entry => ({ ...entry })) } }); return; }
    if (message.type === 'tmp:probe') { respond({ ok: true, protocol: 2, ready: !released, probe: probe() }); return; }
    if (message.type === 'tmp:prepare') { prepareNative().then(respond); return true; }
    if (message.type === 'tmp:idle') {
      respond({ ok: true, empty: !released && !current && !preparation && !!composer() && !(composer().innerText || composer().value || '').trim() && !users().length && !assistants().length && !visible(stopButton()) }); return;
    }
    if (message.type === 'tmp:run') {
      if (released) { respond({ ok: false, error: 'This tab was handed back to you. Start a new tangent.' }); return; }
      if (preparation) { respond({ ok: false, code: 'HELPER_PREPARING', error: 'The helper is still being prepared. Nothing was sent.' }); return; }
      if (current?.requestId === message.requestId) {
        respond({ ok: true });
        if (current.finished && !current.attempted && !current.cancelled) { current.finished = false; current.speed = message.speed === 'instant' ? 'instant' : 'current'; execute(current); }
        return;
      }
      if (current && !current.finished) { respond({ ok: false, error: 'A question is already running in this tab.' }); return; }
      const continuation = !!current?.continuation;
      if (message.continuation && !continuation) { respond({ ok: false, error: 'The temporary ChatGPT page reloaded, so this conversation cannot be resumed safely. Keep it or discard it to start a fresh tangent.' }); return; }
      const conversationProof = current?.conversationProof;
      current = { sessionId: message.sessionId, requestId: message.requestId, prompt: message.prompt, speed: message.speed === 'instant' ? 'instant' : 'current', attempted: false, finished: false, startedAt: Date.now(), continuation, conversationProof };
      respond({ ok: true }); execute(current); return;
    }
    if (message.type === 'tmp:check') {
      if (!current || current.requestId !== message.requestId || !current.attempted || current.cancelled) { respond({ ok: false }); return; }
      respond({ ok: true }); watch(current); return;
    }
    if (message.type === 'tmp:stop') {
      if (current?.requestId === message.requestId && !current.finished) {
        recordSubmission(current);
        current.cancelled = true;
        try { clearOwnedDraft(current); } catch { diagnostic('draft-clear-failed', { attempted: !!current.attempted }); }
        const button = stopButton();
        if (current.clicked && visible(button)) { button.click(); current.inspect?.(); }
        else complete(current, current.lastText || '');
      }
      respond({ ok: true }); return;
    }
    if (message.type === 'tmp:release') {
      released = true; if (current) cleanup(current); if (preparation) cleanup(preparation);
      // Remove the helper marker so the tab behaves normally after a reload.
      if (location.hash === '#tmp-chat-helper') history.replaceState(null, '', location.pathname + location.search);
      respond({ ok: true });
    }
  });
})();
