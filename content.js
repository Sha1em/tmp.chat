/* The visible layer: isolated styles, bounded context, and incremental updates. */
(async function () {
  'use strict';
  if (window.top !== window || location.hash === '#tmp-chat-helper' || globalThis.__tmpChatUI) return;
  globalThis.__tmpChatUI = true;
  const C = TmpCore;
  const diagnostics = globalThis.__tmpChatDiagnostics = [];
  function trace(event, data = {}, warning = false) {
    const entry = { event, time: Date.now(), ...data };
    diagnostics.push(entry); if (diagnostics.length > 60) diagnostics.shift();
    console[warning ? 'warn' : 'debug']('[tmp.chat/ui]', event, data);
  }
  let connectionError = '';
  const rpc = async (type, payload = {}) => {
    trace('rpc:start', { command: type });
    try {
      const result = await chrome.runtime.sendMessage({ type: `tmp:${type}`, ...payload });
      if (!result?.ok) throw new Error(result?.error || 'tmp.chat was updated. Refresh this page to reconnect.');
      connectionError = ''; trace('rpc:ok', { command: type, hasSession: !!result.state, occupied: !!result.occupied });
      return result;
    } catch (error) { trace('rpc:failed', { command: type, reason: error?.name || 'Error' }, true); throw error; }
  };
  let initial;
  try { initial = await rpc('hello'); }
  catch (error) { connectionError = error.message; initial = {}; }
  if (initial.helper) return;
  let state = initial.state || null, occupied = !!initial.occupied, opened = false, minimized = false;
  let preferences = { speed: (initial.preferences || state?.preferences)?.speed === 'instant' ? 'instant' : 'current' }, preferenceSaving = false;
  let pendingContext = null, selectionRect = null;
  let lastMessageIds = '', toastTimer = null, streamingId = '', compact = false, submitting = false, inputSignature = '';
  let stateRevision = 0, visibilityRevision = 0;
  const host = document.createElement('div');
  host.id = 'tmp-chat-root';
  host.style.cssText = 'position:fixed;right:16px;top:104px;z-index:1000;display:none;width:344px;color-scheme:light dark;';
  const shadow = host.attachShadow({ mode: 'open' });
  const icons = {
    chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 2v-4.4A7.5 7.5 0 1 1 20 11.5Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', minus: '<path d="M5 12h14"/>',
    arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    keep: '<path d="M7 3h10v18l-5-4-5 4V3Z"/>',
    external: '<path d="M14 3h7v7m0-7L11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
  shadow.innerHTML = `<style>
    :host { --bg:#fff;--fg:#202123;--muted:#777b84;--line:#e8e8eb;--soft:#f7f7f8;--bubble:#eef2fc;--accent:#4967dc;--danger:#b63d43; font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fg); }
    :host([data-dark]) { --bg:#212121;--fg:#ececec;--muted:#a1a1aa;--line:#3a3a3e;--soft:#2b2b2d;--bubble:#30394b;--accent:#a0b3ff;--danger:#ff9298; }
    * { box-sizing:border-box; } button,textarea,select { font:inherit; } button { cursor:pointer; color:inherit; } button:disabled { cursor:default; opacity:.4; }
    button:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible { outline:2px solid var(--accent);outline-offset:3px; }
    [hidden] { display:none!important; } .card { background:var(--bg);border:1px solid var(--line);border-radius:20px;box-shadow:0 8px 30px #00000008,0 1px 4px #00000004;overflow:hidden;display:flex;flex-direction:column;height:min(610px,calc(100dvh - 136px));min-height:280px; }
    header { display:flex;align-items:center;gap:9px;height:57px;min-height:57px;padding:0 14px 0 18px;border-bottom:1px solid var(--line); } .brand { font-size:15px;letter-spacing:-.4px;font-weight:650; } .brand-icon { color:var(--accent);display:flex; } .spacer { flex:1; }
    .icon { display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;width:29px;height:29px;border-radius:8px;color:var(--muted);padding:0; } .icon:hover { color:var(--fg);background:var(--soft); } .icon.danger:hover { color:var(--danger); }
    .context { border-bottom:1px solid var(--line);padding:0 17px;flex-shrink:0; } summary { display:flex;align-items:center;gap:7px;cursor:pointer;list-style:none;padding:10px 0;font-size:11px;color:var(--muted);letter-spacing:.1px; } summary::-webkit-details-marker { display:none; } summary svg { width:12px;height:12px;transition:transform .15s; } details[open] summary svg { transform:rotate(90deg); } .context-label { color:var(--fg);font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:205px; } .context-quote { margin:0 0 13px;border-left:2px solid var(--accent);padding-left:10px;font-size:12px;color:var(--muted);white-space:pre-wrap;max-height:120px;overflow:auto;overflow-wrap:anywhere; } .context-note { font-size:10px;margin:0 0 10px;color:var(--muted); }
    .messages { flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 14px;scrollbar-width:thin;scrollbar-color:var(--line) transparent; }
    .welcome { display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:190px;padding:8px 5px 18px; } .eyebrow { display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);margin-bottom:15px; } .dot { width:5px;height:5px;background:var(--accent);border-radius:50%; } h2 { font-size:22px;letter-spacing:-.7px;line-height:1.23;font-weight:550;margin:0 0 10px; } .welcome p { margin:0;color:var(--muted);font-size:12px;max-width:252px;line-height:1.65; } .suggestions { display:flex;gap:7px;flex-wrap:wrap;margin-top:18px; } .chip { background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:6px 10px;font-size:11px; } .chip:hover { background:var(--soft); }
    .message { margin-bottom:17px;overflow-wrap:anywhere;font-size:13px;line-height:1.7; } .message.user { background:var(--bubble);border-radius:15px 15px 4px 15px;padding:10px 13px;margin-left:25px;white-space:pre-wrap; } .message.assistant { background:var(--soft);border-radius:15px 15px 15px 4px;padding:12px 14px;margin-right:8px; } .message.streaming { white-space:pre-wrap; } .message p { margin:0 0 10px; } .message p:last-child { margin-bottom:0; } .message ul,.message ol { padding-left:21px;margin:8px 0; } .message li { margin:4px 0; } .message pre { overflow-x:auto;background:var(--bg);border:1px solid var(--line);padding:10px;border-radius:9px;font-size:11px;white-space:pre; } .message code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em; } .message blockquote { margin:10px 0;border-left:2px solid var(--muted);padding-left:10px;color:var(--muted); } .message h1,.message h2,.message h3,.message h4 { font-size:14px;line-height:1.4;margin:14px 0 7px;font-weight:650;letter-spacing:0; } .message a { color:var(--accent); } .message table { display:block;overflow-x:auto;border-collapse:collapse;font-size:11px; } .message td,.message th { padding:5px;border:1px solid var(--line); } .waiting { display:flex;gap:4px;align-items:center;min-height:20px; } .waiting i { width:4px;height:4px;border-radius:50%;background:var(--muted);animation:pulse 1.2s infinite; } .waiting i:nth-child(2) { animation-delay:.15s; } .waiting i:nth-child(3) { animation-delay:.3s; } @keyframes pulse { 50% { opacity:.25; } }
    .notice { margin:0 14px 10px;padding:9px 11px;background:var(--soft);border:1px solid var(--line);border-radius:10px;font-size:11px;color:var(--muted); } .notice.error { color:var(--danger); } .notice-actions { display:flex;gap:12px;margin-top:7px; } .text-button { border:0;background:transparent;padding:0;color:var(--fg);font-size:11px;text-decoration:underline;text-underline-offset:3px; }
    .answer-notice { margin-top:11px;padding-top:9px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;line-height:1.5;white-space:normal; } .answer-notice .text-button { display:block;margin-top:5px;color:var(--accent); }
    .composer-wrap { padding:0 12px 9px; } form { border:1px solid var(--line);border-radius:19px;padding:12px 12px 9px;box-shadow:0 1px 3px #00000003; } form:focus-within { border-color:color-mix(in srgb,var(--muted) 45%,var(--line)); } textarea { width:100%;resize:none;border:0;outline:0!important;background:transparent;color:var(--fg);font-size:13px;line-height:1.5;min-height:39px;max-height:110px;padding:0; } textarea::placeholder { color:var(--muted); } .composer-actions { display:flex;align-items:center;gap:4px;margin-top:4px; } .status { font-size:10px;color:var(--muted);line-height:1.3; } .send { margin-left:auto;border:0;background:var(--fg);color:var(--bg);height:30px;width:30px;border-radius:50%;display:grid;place-items:center; } .send:disabled { background:var(--line);color:var(--muted);opacity:1; } .send svg { width:16px;height:16px; } footer { font-size:9px;color:var(--muted);text-align:center;padding-top:7px;letter-spacing:.05px; }
    .manual-context { margin:0 16px 10px;flex-shrink:0; } .manual-context summary { padding:3px 0;font-size:11px; } .manual-context textarea { border:1px solid var(--line);border-radius:9px;padding:8px;font-size:12px;min-height:70px;margin-top:7px; }
    .speed-settings { margin:0 17px 10px;flex-shrink:0; } .speed-settings summary { padding:3px 0;font-size:10px; } .speed-settings summary span { margin-left:auto; } .speed-settings label { display:block;margin:7px 0 4px;color:var(--muted);font-size:11px; } .speed-settings select { width:100%;border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--bg);color:var(--fg);font-size:11px; } .speed-settings select:disabled { opacity:.5; } .speed-settings p { margin:6px 0 0;font-size:10px;line-height:1.5;color:var(--muted); }
    .confirm { padding:14px 17px;border-top:1px solid var(--line);background:var(--soft);font-size:12px; } .confirm p { margin:0 0 10px; } .confirm-actions { display:flex;gap:8px; } .button { border:1px solid var(--line);border-radius:9px;padding:6px 10px;background:var(--bg);font-size:11px; } .button.danger { color:var(--danger); }
    .dock { display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:10px 13px;box-shadow:0 2px 10px #00000008;width:100%;font-size:12px; } .dock svg { color:var(--accent); } :host([data-compact]) .dock { padding:12px;flex-direction:column;gap:10px; } :host([data-compact]) .dock span { writing-mode:vertical-rl;font-size:10px;letter-spacing:.4px; }
    .toast { position:absolute;left:10px;right:10px;bottom:135px;background:var(--fg);color:var(--bg);font-size:11px;padding:10px 12px;border-radius:12px;box-shadow:0 3px 12px #0002; }
    @media(prefers-reduced-motion:reduce) { * { animation:none!important;transition:none!important; } }
  </style>
  <section class="card" role="region" aria-label="tmp.chat side conversation" hidden>
    <header><span class="brand-icon">${svg('chat')}</span><span class="brand">tmp.chat</span><span class="spacer"></span><button class="icon" id="copy" title="Copy conversation" aria-label="Copy conversation">${svg('copy')}</button><button class="icon" id="keep" title="Open in ChatGPT to save or continue" aria-label="Keep in ChatGPT">${svg('keep')}</button><button class="icon" id="minimize" title="Minimize — keeps your tangent open" aria-label="Minimize">${svg('minus')}</button><button class="icon danger" id="discard" title="Discard tangent" aria-label="Discard tangent">${svg('close')}</button></header>
    <details class="context"><summary>${svg('chevron')}<span>About</span><span class="context-label"></span></summary><blockquote class="context-quote"></blockquote><p class="context-note">Includes this passage, nearby text, and its original question.</p></details>
    <div class="messages" role="log" aria-label="Side conversation messages" aria-live="off"></div>
    <div class="notice" id="error" role="status" hidden><span></span><div id="failure-stage" style="margin-top:5px;font-size:10px"></div><div class="notice-actions"><button class="text-button" id="focus-helper">Open ChatGPT</button><button class="text-button" id="check">Check again</button></div></div>
    <div class="confirm" id="confirm" hidden><p>Discard this tangent? Its temporary ChatGPT tab will close.</p><div class="confirm-actions"><button class="button" id="cancel-discard">Keep exploring</button><button class="button danger" id="confirm-discard">Discard tangent</button></div></div>
    <details class="manual-context" id="manual-context"><summary>Add context · optional</summary><textarea id="pasted-context" rows="3" maxlength="6600" placeholder="Paste a passage you want to ask about…" aria-label="Optional context"></textarea></details>
    <details class="speed-settings" id="speed-settings"><summary>Answer speed<span id="speed-summary">Current setting</span></summary><label for="speed-preference">Helper preference</label><select id="speed-preference"><option value="current">Use current ChatGPT setting</option><option value="instant">Prefer Instant</option></select><p>Uses ChatGPT’s own controls when available. May also affect ChatGPT’s default for other chats.</p><p id="speed-feedback" role="status" hidden></p></details>
    <div class="composer-wrap"><form><textarea id="question" rows="2" maxlength="4000" placeholder="Ask a follow-up…" aria-label="Ask a follow-up"></textarea><div class="composer-actions"><span class="status" role="status"></span><button type="submit" class="send" title="Send question" aria-label="Send question" disabled>${svg('arrow')}</button></div></form><footer>Explore the tangent. Keep the thread.</footer></div>
  </section>
  <button class="dock" aria-label="Reopen tmp.chat" hidden>${svg('chat')}<span>tmp.chat</span><span class="spacer"></span>${svg('expand')}</button>
  <div class="toast" role="status" hidden></div>`;
  document.documentElement.append(host);
  const $ = selector => shadow.querySelector(selector);
  const messages = $('.messages'), textarea = $('#question'), pastedContext = $('#pasted-context'), card = $('.card'), dock = $('.dock');
  const selectionHost = document.createElement('div'); selectionHost.id = 'tmp-chat-selection-root';
  selectionHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const selectionShadow = selectionHost.attachShadow({ mode: 'open' });
  selectionShadow.innerHTML = '<style>:host{all:initial}.tmp-chat-selection{position:fixed;pointer-events:auto;display:flex;align-items:center;gap:5px;border:1px solid #dedee4;border-radius:10px;background:#fff;color:#232328;box-shadow:0 3px 12px #0000000e;padding:7px 10px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}.tmp-chat-selection-label{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}.tmp-chat-selection[hidden]{display:none!important}.tmp-chat-selection:focus-visible{outline:2px solid #4967dc;outline-offset:2px}:host([data-dark]) .tmp-chat-selection{background:#292929;border-color:#444;color:#ececec}</style>';
  const selectionButton = document.createElement('button');
  selectionButton.className = 'tmp-chat-selection'; selectionButton.innerHTML = `${svg('chat')}<span class="tmp-chat-selection-label">tmp.chat()</span>`;
  selectionButton.setAttribute('aria-label', 'tmp.chat(): ask about the selected text'); selectionButton.hidden = true;
  // Keep selection intact when moving from the answer to its action button.
  for (const name of ['pointerdown', 'mousedown']) selectionButton.addEventListener(name, e => { e.preventDefault(); e.stopPropagation(); });
  selectionShadow.append(selectionButton); document.documentElement.append(selectionHost);
  const theme = () => { const dark = document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'; host.toggleAttribute('data-dark', dark); selectionHost.toggleAttribute('data-dark', dark); };
  theme(); new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  function toast(text) { clearTimeout(toastTimer); $('.toast').textContent = text; $('.toast').hidden = false; toastTimer = setTimeout(() => { $('.toast').hidden = true; }, 5000); }
  const layout = TmpLayout.create({ host, onChange(plan) {
    compact = plan.compact;
    host.toggleAttribute('data-compact', false); // Preserve the horizontal minimized pill.
    host.style.width = `${plan.width}px`; host.style.top = `${plan.top}px`;
    card.hidden = compact || minimized; dock.hidden = !card.hidden;
    dock.querySelector('span').textContent = 'tmp.chat';
    dock.title = compact ? plan.reason || 'Widen your browser to keep both conversations readable.' : 'Reopen your tangent';
    dock.setAttribute('aria-label', dock.title);
    if (opened) host.style.display = 'block';
    trace('layout', { compact, minimized, reason: plan.reason });
  } });
  function place() { if (opened) layout.place({ minimized, anchorTop: selectionRect?.top }); }
  function scheduleLayout() { if (opened) layout.schedule(); }
  let openingPreparation = null;
  function prepareOnOpen() {
    if (occupied || state?.messages.length || openingPreparation) return;
    const revision = stateRevision;
    openingPreparation = rpc('prepare').then(result => {
      if (revision === stateRevision) applyState(result.state);
    }).catch(() => { /* Submission reports setup errors through existing controls. */ }).finally(() => { openingPreparation = null; });
  }
  function open(prepare = true) { visibilityRevision++; opened = true; minimized = false; render(); place(); if (!compact) textarea.focus({ preventScroll: true }); if (prepare) prepareOnOpen(); }
  async function reopen() {
    const intent = ++visibilityRevision, revision = stateRevision;
    try {
      const snapshot = await rpc('hello');
      if (intent !== visibilityRevision) return;
      if (revision === stateRevision) { stateRevision++; state = snapshot.state || null; occupied = !!snapshot.occupied; if (snapshot.preferences) preferences = { speed: snapshot.preferences.speed === 'instant' ? 'instant' : 'current' }; }
      open();
    } catch (error) { if (intent === visibilityRevision) { open(); toast(error.message); } }
  }
  function hide() { visibilityRevision++; opened = false; host.style.display = 'none'; layout.release(); }
  function minimize() { visibilityRevision++; minimized = true; place(); }
  function createTree(nodes, parent) {
    function append(clean, target) {
      for (const node of clean) {
        if (typeof node.text === 'string') { target.append(document.createTextNode(node.text)); continue; }
        const element = document.createElement(node.tag);
        if (node.tag === 'a' && node.href) { element.href = node.href; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
        append(node.children || [], element); target.append(element);
      }
    }
    append(C.cleanTree(nodes), parent);
  }
  function appendAnswerNotice(item, bubble) {
    if (item.role !== 'assistant') return;
    const unsupported = item.notices?.includes('unsupported'), truncated = item.notices?.includes('truncated');
    if (!unsupported && !truncated) return;
    const notice = document.createElement('div'); notice.className = 'answer-notice'; notice.setAttribute('role', 'note');
    const description = document.createElement('span');
    description.textContent = truncated ? 'This answer exceeds tmp.chat’s display limit.' : 'Some visuals are available in ChatGPT.';
    if (truncated && unsupported) description.textContent += ' Some visuals also need ChatGPT.';
    const button = document.createElement('button'); button.className = 'text-button'; button.type = 'button';
    button.textContent = truncated ? 'Open full answer' : 'View in ChatGPT';
    button.disabled = !state?.hasHelper;
    button.title = state?.hasHelper ? 'Open the existing temporary ChatGPT tab' : 'The temporary ChatGPT tab is no longer available';
    button.addEventListener('click', async () => { try { await rpc('focus'); } catch (error) { toast(error.message); } });
    notice.append(description, button); bubble.append(notice);
  }
  function renderSpeed() {
    if (state?.preferences) preferences = { speed: state.preferences.speed === 'instant' ? 'instant' : 'current' };
    const control = $('#speed-preference'); control.value = preferences.speed;
    control.disabled = preferenceSaving || submitting || C.busy(state?.status) || occupied;
    control.title = occupied ? 'Continue the tangent in its original tab' : C.busy(state?.status) || submitting ? 'Wait for the answer to finish before changing the helper preference' : 'Remember this preference for future helper requests';
    $('#speed-summary').textContent = preferenceSaving ? 'Saving…' : preferences.speed === 'instant' ? 'Prefer Instant' : 'Current setting';
    const labels = { instant: 'Instant selected', current: 'Using ChatGPT’s current setting', unavailable: 'Instant unavailable; using current setting', unverified: 'Check speed in ChatGPT', checking: 'Checking Instant availability…' };
    const feedback = labels[state?.speedStatus] || '';
    $('#speed-feedback').textContent = feedback; $('#speed-feedback').hidden = !feedback;
  }
  const stageLabels = Object.freeze({
    helper_creating: 'Opening ChatGPT…', helper_loading: 'Loading helper page…', helper_navigation: 'Checking helper page…',
    agent_injecting: 'Connecting adapter…', agent_ready: 'Checking adapter…', dispatch: 'Starting question…',
    composer_ready: 'Waiting for ChatGPT input…', temporary_setup: 'Checking Temporary Chat…', speed_setup: 'Checking helper answer speed…', draft_insert: 'Preparing question…',
    send_ready: 'Waiting for Send…', send_confirm: 'Confirming submission…', submitted: 'Confirming submission…',
    response_wait: 'Waiting for ChatGPT’s answer…', response_stream: 'ChatGPT is answering…', request_stop: 'Stopping…'
  });
  let connectionSignature = '';
  const messageViews = new Map();
  function render() {
    const list = state?.messages || [];
    const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
    const ids = list.length ? list.map(m => m.id).join('|') : `empty:${occupied ? 'occupied' : state?.context?.selection ? 'selected' : 'manual'}`;
    if (ids !== lastMessageIds || !messages.children.length) {
      lastMessageIds = ids;
      if (!list.length) {
        messages.replaceChildren(); messageViews.clear();
        const welcome = document.createElement('div'); welcome.className = 'welcome';
        welcome.innerHTML = `<div class="eyebrow"><span class="dot"></span>A little room for curiosity</div><h2>Stay with the thought.</h2><p>${state?.context?.selection ? 'Ask about this passage. Your main conversation stays right where you left it.' : occupied ? 'A tangent is already open in another ChatGPT tab. Return there to continue or discard it.' : 'Ask a quick question, paste some context, or highlight a passage in an answer.'}</p>${state?.context?.selection ? '<div class="suggestions"><button class="chip" data-question="Explain this more simply.">Explain simply</button><button class="chip" data-question="Can you give me a concrete example?">Give an example</button></div>' : ''}`;
        messages.append(welcome);
        welcome.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { textarea.value = button.dataset.question; updateComposer(); textarea.focus(); }));
      } else {
        if (!messageViews.size) messages.replaceChildren();
        const keep = new Set(list.map(item => item.id));
        for (const [id, bubble] of messageViews) if (!keep.has(id)) { bubble.remove(); messageViews.delete(id); }
        list.forEach((item, index) => {
          let bubble = messageViews.get(item.id);
          if (!bubble) { bubble = document.createElement('div'); bubble.className = `message ${item.role}`; bubble.dataset.id = item.id; messageViews.set(item.id, bubble); }
          if (messages.children[index] !== bubble) messages.insertBefore(bubble, messages.children[index] || null);
        });
      }
    }
    for (const item of list) {
      const bubble = messageViews.get(item.id);
      if (!bubble) continue;
      const signature = `${item.text}|${item.tree?.length ? JSON.stringify(item.tree) : ''}|${(item.notices || []).join(',')}|${!!state?.hasHelper}|${item.text ? '' : state?.status}`;
      if (bubble._signature === signature) continue;
      bubble._signature = signature;
      bubble._textNode = null;
      bubble.classList.toggle('streaming', !item.tree);
      if (!item.text && item.role === 'assistant' && C.busy(state?.status)) {
        bubble.innerHTML = '<span class="waiting" aria-label="ChatGPT is working"><i></i><i></i><i></i></span>';
      } else if (item.tree?.length) { bubble.replaceChildren(); createTree(item.tree, bubble); }
      else {
        bubble._textNode = document.createTextNode(item.text || (state?.status === 'error' ? 'Waiting for ChatGPT…' : 'Stopped.'));
        bubble.replaceChildren(bubble._textNode);
      }
      appendAnswerNotice(item, bubble);
    }
    const ctx = state?.context;
    $('.context').hidden = !ctx?.selection;
    $('.context-label').textContent = ctx?.selection || '';
    $('.context-quote').textContent = ctx?.selection || '';
    $('#manual-context').hidden = !!ctx?.selection || list.length > 0 || occupied;
    const error = $('#error'); error.hidden = state?.status !== 'error' && !connectionError; error.classList.toggle('error', !state?.uncertain);
    error.querySelector('span').textContent = connectionError || state?.error || '';
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(state?.errorCode || '') ? state.errorCode : '';
    $('#failure-stage').textContent = code ? `${stageLabels[state.stage]?.replace(/…$/, '') || 'ChatGPT connection'} · ${code}` : '';
    $('#focus-helper').hidden = !state?.hasHelper;
    $('#check').hidden = !state?.pendingPrompt || (!state?.hasHelper && !!state?.uncertain);
    $('#keep').disabled = !state?.hasHelper || !list.length || C.busy(state?.status);
    $('#keep').title = !state?.hasHelper || !list.length ? 'Send a question before opening this tangent in ChatGPT' : C.busy(state?.status) ? 'Wait for the answer to finish before keeping it' : 'Open in ChatGPT to save or continue';
    $('#copy').disabled = !list.some(m => m.text);
    $('#copy').title = $('#copy').disabled ? 'Send a question before copying the conversation' : 'Copy conversation';
    $('#discard').disabled = false;
    $('#discard').title = state ? 'Discard tangent' : 'Close panel';
    $('.status').textContent = state?.status === 'stopping' ? 'Stopping…' : state?.status === 'error' ? 'Needs a quick check' : C.busy(state?.status) && stageLabels[state.stage] || ({ starting: 'Opening ChatGPT…', sending: 'Asking ChatGPT…', streaming: 'ChatGPT is answering…' })[state?.status] || (occupied ? 'Continue the tangent in its original tab' : 'Temporary · your ChatGPT');
    const nextConnection = `${state?.status}|${state?.stage}|${code}`;
    if (nextConnection !== connectionSignature) { connectionSignature = nextConnection; trace('connection:state', { status: state?.status || 'idle', stage: state?.stage || 'idle', code }); }
    const nowStreaming = C.busy(state?.status) ? state?.requestId : '';
    if (streamingId && !nowStreaming && state?.status === 'done') $('.status').setAttribute('aria-label', 'ChatGPT finished answering');
    else $('.status').removeAttribute('aria-label');
    streamingId = nowStreaming;
    updateComposer();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }
  let composerDraft = null, composerWidth = -1;
  function resizeComposer() {
    const width = textarea.clientWidth;
    if (textarea.value === composerDraft && width === composerWidth) return;
    composerDraft = textarea.value; composerWidth = width;
    textarea.style.height = 'auto'; textarea.style.height = `${Math.min(110, Math.max(39, textarea.scrollHeight))}px`;
  }
  new ResizeObserver(resizeComposer).observe(textarea);
  function updateComposer() {
    const busy = C.busy(state?.status);
    textarea.disabled = busy || submitting;
    pastedContext.disabled = busy || submitting;
    const send = $('.send');
    send.disabled = submitting || preferenceSaving || (busy ? state?.status === 'stopping' : occupied || state?.status === 'error' || !textarea.value.trim());
    const icon = busy ? 'stop' : 'arrow';
    if (send.dataset.icon !== icon) { send.dataset.icon = icon; send.innerHTML = svg(icon); }
    send.title = submitting ? 'Sending question…' : preferenceSaving ? 'Saving helper preference…' : busy ? 'Stop answer' : occupied ? 'Continue the tangent in its original tab' : state?.status === 'error' ? 'Resolve the existing request before sending another question' : !textarea.value.trim() ? 'Write a question to send' : 'Send question'; send.setAttribute('aria-label', busy ? 'Stop answer' : 'Send question');
    resizeComposer();
    const signature = `${!!state}|${state?.status}|${textarea.disabled}|${send.disabled}|${occupied}|${submitting}`;
    if (signature !== inputSignature) { inputSignature = signature; trace('input:state', { hasSession: !!state, status: state?.status || 'manual', inputEnabled: !textarea.disabled, sendEnabled: !send.disabled, occupied }); }
    renderSpeed();
  }
  function applyState(value) {
    if (value && state?.id === value.id && (value.revision || 0) < (state.revision || 0)) return;
    stateRevision++; state = value; occupied = false;
    if (!state) { lastMessageIds = ''; textarea.value = ''; pastedContext.value = ''; $('#confirm').hidden = true; }
    render(); scheduleLayout();
  }
  let refreshingStream = false, refreshAgain = false, firstPatchRequest = null;
  async function refreshStream() {
    if (refreshingStream) { refreshAgain = true; return; }
    refreshingStream = true; refreshAgain = false;
    const intent = stateRevision, sessionId = state?.id;
    try {
      const snapshot = await rpc('hello');
      if (intent === stateRevision || snapshot.state?.id === sessionId && state?.id === sessionId) applyState(snapshot.state || null);
    } catch { trace('stream:resync-failed', {}, true); }
    finally {
      refreshingStream = false;
      // A later gap can arrive while an older snapshot is in flight. Perform
      // one more read only when a real incoming patch requested it.
      if (refreshAgain) { refreshAgain = false; refreshStream(); }
    }
  }
  function applyStream(message) {
    if (state?.id !== message.sessionId || state.requestId !== message.requestId) { refreshStream(); return; }
    if (Number.isInteger(message.revision) && message.revision <= (state.revision || 0)) return;
    const answer = state.messages.find(item => item.id === message.requestId);
    if (!answer) { refreshStream(); return; }
    const check = C.streamCheck(answer.text, answer.sequence, message);
    if (check === 'ignore') return;
    if (check === 'resync') { trace('stream:gap'); refreshStream(); return; }
    const first = firstPatchRequest !== message.requestId;
    if (first) trace('stream:first-receive');
    const previous = answer.text;
    const transition = state.status !== message.status || state.stage !== 'response_stream' || state.error || state.uncertain;
    stateRevision++;
    answer.text = C.streamText(previous, message); answer.tree = null;
    if (Number.isSafeInteger(message.sequence)) answer.sequence = message.sequence;
    if (Number.isInteger(message.revision)) state.revision = message.revision;
    state.status = message.status; state.error = ''; state.uncertain = false;
    state.stage = 'response_stream'; state.errorCode = '';
    const bubble = messageViews.get(answer.id);
    if (transition || !answer.text || !bubble?._textNode || bubble._textNode.data !== previous) render();
    else {
      const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
      if (typeof message.delta === 'string' && answer.text.startsWith(previous)) bubble._textNode.appendData(answer.text.slice(previous.length));
      else bubble._textNode.data = answer.text;
      bubble._signature = null;
      if (stick) messages.scrollTop = messages.scrollHeight;
    }
    if (first) { firstPatchRequest = message.requestId; trace('stream:first-commit', { characters: answer.text.length }); }
  }
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    if (submitting) return;
    if (C.busy(state?.status)) { try { await rpc('stop'); } catch (e) { toast(e.message); } return; }
    const question = textarea.value.trim();
    if (!question || occupied || state?.status === 'error') return;
    // Lock immediately, before waiting for the service worker, to prevent double clicks.
    const previous = textarea.value; textarea.value = ''; submitting = true; updateComposer();
    try {
      if (!state || !state.messages.length && !state.context.selection) {
        const pasted = pastedContext.value.trim();
        const result = await rpc('ensure', { context: { selection: pasted.slice(0, C.LIMITS.selection), nearby: pasted.slice(C.LIMITS.selection, C.LIMITS.selection + C.LIMITS.nearby) } });
        stateRevision++; state = result.state;
      }
      const result = await rpc('send', { question }); applyState(result.state);
    } catch (e) { textarea.value = previous; toast(e.message); }
    finally { submitting = false; render(); }
  });
  textarea.addEventListener('input', updateComposer);
  $('#speed-preference').addEventListener('change', async () => {
    const previous = preferences.speed, requested = $('#speed-preference').value;
    preferenceSaving = true; updateComposer();
    try {
      const result = await rpc('preference', { speed: requested });
      preferences = { speed: result.preferences?.speed === 'instant' ? 'instant' : 'current' };
      // Saving a preference before the first question has no session snapshot.
      // Keep the user's unsent question and pasted context intact in that case.
      if (result.state) applyState(result.state);
      toast(preferences.speed === 'instant' ? 'Instant preferred when available. ChatGPT’s defaults may also change.' : 'Using ChatGPT’s current setting.');
    } catch (error) { preferences = { speed: previous }; toast(error.message); }
    finally { preferenceSaving = false; updateComposer(); }
  });
  textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$('.send').disabled) $('form').requestSubmit(); } });
  $('#minimize').addEventListener('click', minimize);
  dock.addEventListener('click', () => { if (!compact) reopen(); });
  $('#discard').addEventListener('click', () => {
    if (!state?.messages.length && !textarea.value.trim() && !pastedContext.value.trim()) discard();
    else { $('#confirm p').textContent = state?.hasHelper ? 'Discard this tangent? Its temporary ChatGPT tab will close.' : 'Close this panel and clear its draft?'; $('#confirm').hidden = false; }
  });
  $('#cancel-discard').addEventListener('click', () => { $('#confirm').hidden = true; });
  $('#confirm-discard').addEventListener('click', discard);
  async function discard() { try { if (openingPreparation) await openingPreparation; if (state) await rpc('discard'); applyState(null); hide(); } catch (e) { toast(e.message); } }
  $('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(C.transcript(state.messages)); toast('Conversation copied.'); } catch { toast('Your browser could not copy this conversation.'); } });
  $('#keep').addEventListener('click', async () => {
    try { await rpc('keep'); applyState(null); render(); open(false); toast('The chat is yours now. Choose Save chat in ChatGPT to keep it in your history.'); }
    catch (e) { toast(e.message); }
  });
  $('#focus-helper').addEventListener('click', async () => { try { await rpc('focus'); } catch (e) { toast(e.message); } });
  $('#check').addEventListener('click', async () => { $('#check').disabled = true; try { await rpc('check'); } catch (e) { toast(e.message); } finally { $('#check').disabled = false; } });
  shadow.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); minimize(); } });
  function captureSelection(source = 'selectionchange') {
    const selection = window.getSelection();
    const result = TmpSelection.detect(selection, document);
    if (result.reason !== lastSelectionReason || result.ok) {
      lastSelectionReason = result.reason;
      trace('selection:detected', { source, accepted: result.ok, reason: result.reason, strategy: result.strategy || '', selectedChars: result.context?.selection.length || 0, ...(!result.ok && result.reason !== 'collapsed' ? { structure: TmpSelection.describe(selection, document) } : {}) });
    }
    // Native selection toolbars can collapse the Range while taking focus.
    // Retain a successful pointer-up capture until another pointer-down/Escape.
    if (!result.ok) {
      if (result.reason !== 'collapsed') {
        selectionButton.hidden = true; pendingContext = null; pendingRange = null;
      }
      return;
    }
    pendingContext = result.context; selectionRect = result.rect;
    pendingRange = selection.getRangeAt(0).cloneRange();
    selectionButton.hidden = false; positionSelectionAction(); scheduleSelectionPosition();
  }
  function positionSelectionAction() {
    if (selectionButton.hidden || !selectionRect) return;
    let left = Math.max(8, Math.min(innerWidth - 148, selectionRect.right - 120));
    let top = Math.min(innerHeight - 44, Math.max(8, selectionRect.bottom + 9));
    const own = selectionButton.getBoundingClientRect(), width = own.width || 136, height = own.height || 34;
    // Leave ChatGPT's own selection action usable; our action gets its own row.
    const nativeActions = [...document.querySelectorAll('button,[role="button"]')].filter(e => /^ask (?:chat)?gpt\b/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
    for (const native of nativeActions) {
      const r = native.getBoundingClientRect();
      if (r.width && r.height && left < r.right + 6 && left + width > r.left - 6 && top < r.bottom + 6 && top + height > r.top - 6) {
        top = r.bottom + height + 12 < innerHeight ? r.bottom + 8 : Math.max(8, r.top - height - 8);
      }
    }
    selectionButton.style.left = `${left}px`; selectionButton.style.top = `${top}px`;
  }
  let pendingRange = null, lastSelectionReason = '', selectionFrame = null;
  function scheduleSelectionPosition() {
    if (selectionFrame !== null) return;
    selectionFrame = requestAnimationFrame(() => { selectionFrame = null; positionSelectionAction(); });
  }
  // Snapshot now: ChatGPT's window-level toolbar handlers can collapse the
  // browser Range before a delayed callback or document pointer-up sees it.
  document.addEventListener('selectionchange', () => captureSelection('selectionchange'), true);
  window.addEventListener('pointerup', e => { if (e.button === 0 && !e.composedPath().includes(host) && !e.composedPath().includes(selectionHost)) { captureSelection('pointerup'); scheduleSelectionPosition(); } }, true);
  window.addEventListener('keyup', e => { if (e.shiftKey || ['Shift','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) captureSelection('keyboard'); }, true);
  document.addEventListener('pointerdown', e => {
    if (e.composedPath().includes(selectionHost)) return;
    selectionButton.hidden = true; pendingContext = null; pendingRange = null;
  }, true);
  document.addEventListener('scroll', e => {
    if (selectionButton.hidden || selectionFrame !== null || e.composedPath().includes(host)) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = null;
      if (!pendingRange?.startContainer.isConnected) { selectionButton.hidden = true; return; }
      selectionRect = pendingRange.getBoundingClientRect(); positionSelectionAction();
    });
  }, { passive: true, capture: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') selectionButton.hidden = true; });
  selectionButton.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    if (!pendingContext) return;
    selectionButton.hidden = true;
    try { const result = await rpc('context', { context: pendingContext }); applyState(result.state); open(); trace('selection:opened', { selectedChars: result.state.context.selection.length }); }
    catch (e) { open(); toast(e.message); }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'tmp:state') applyState(message.state);
    if (message.type === 'tmp:navigation') { scheduleLayout(); setTimeout(scheduleLayout, 200); }
    if (message.type === 'tmp:patch') applyStream(message);
    if (message.type === 'tmp:toggle') opened && !minimized ? minimize() : reopen();
  });
  // Restoring a source tab restores a small dock, without unexpectedly taking space.
  if (state) { opened = true; minimized = true; render(); place(); }
  trace('ready', { hasSession: !!state, occupied, connected: !connectionError });
})();
