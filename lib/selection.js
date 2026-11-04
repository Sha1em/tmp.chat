/* Resolve selected response text without depending on one ChatGPT turn layout. */
(function (root) {
  'use strict';
  const C = root.TmpCore || (typeof require === 'function' ? require('./core.js') : null);
  const NATIVE_UNIT = '[data-content-search-unit-key][data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]';
  const NATIVE_MESSAGE = '[data-chatgpt-selection-conversation-id][data-chatgpt-selection-message-id]';
  const NATIVE_SOURCE = '[data-dil-source-message-id][data-chatgpt-copy-reference][data-markdown-copy]';
  const TURN = '[data-testid^="conversation-turn-"],[data-testid="assistant-message"],[data-turn],article';
  const USER = '[data-message-author-role="user"],[data-turn="user"],[data-testid="user-message"]';
  const PROSE = '.markdown,.prose,[data-message-content]';
  const UI = '#tmp-chat-root,.tmp-chat-selection,button,[role="button"],textarea,input,select,[role="textbox"],[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';
  const EXCLUDED = `${UI},script,style,noscript,svg,[hidden],[aria-hidden="true"],.sr-only`;
  const BLOCK = 'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th';
  const MAX_STEPS = 1800;
  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const textValue = node => node?.innerText || node?.textContent || '';
  const fail = reason => ({ ok: false, reason });

  function excluded(node, doc) {
    const el = element(node);
    return !el || node.getRootNode?.() !== doc || !!el.closest(EXCLUDED);
  }
  function turnRole(turn) {
    const role = turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn');
    if (role) return role.toLowerCase();
    const testid = turn.getAttribute('data-testid');
    if (testid === 'assistant-message') return 'assistant';
    if (testid === 'user-message') return 'user';
    const label = turn.getAttribute('aria-label') || turn.querySelector('h5.sr-only,h6.sr-only,[data-testid="conversation-turn-label"]')?.textContent || '';
    if (/^\s*(?:you said|your message|user)\s*[:：]?\s*$/i.test(label)) return 'user';
    if (/^\s*(?:chatgpt said|assistant said|assistant)\s*[:：]?\s*$/i.test(label)) return 'assistant';
    return '';
  }
  function assistantFor(node, doc = root.document) {
    if (!doc || excluded(node, doc)) return null;
    const el = element(node);
    if (el.closest(USER)) return null;
    const role = el.closest('[data-message-author-role]');
    if (role) return role.getAttribute('data-message-author-role') === 'assistant' ? role : null;
    const nativeUnit = el.closest(NATIVE_UNIT);
    if (nativeUnit) {
      const headings = [...nativeUnit.querySelectorAll('h4[data-conversation-role]')].filter(node => node.closest(NATIVE_UNIT) === nativeUnit);
      if (headings.length !== 1 || headings[0].getAttribute('data-conversation-role') !== 'assistant' || nativeUnit.querySelector(USER)) return null;
      const source = el.closest(NATIVE_SOURCE), message = source?.closest(NATIVE_MESSAGE);
      // The observed native renderer's source/copy block is bounded to one
      // message. The shared outer turn also contains the user's prompt, so it
      // must never be treated as an assistant answer merely from this heading.
      return source && message && source.closest(NATIVE_UNIT) === nativeUnit && nativeUnit.contains(message) ? source : null;
    }
    const turn = el.closest(TURN);
    if (!turn || !turn.closest('main') || turnRole(turn) === 'user' || turn.querySelector(USER)) return null;
    const explicit = turnRole(turn);
    if (explicit) return explicit === 'assistant' ? turn : null;
    // A generic article alone is not enough: require response prose in a main
    // conversation turn, with no user marker anywhere in that turn.
    const prose = el.closest(PROSE);
    return prose && turn.contains(prose) ? turn : null;
  }
  function assistantRoots(doc = root.document) {
    if (!doc) return [];
    const result = [];
    for (const candidate of doc.querySelectorAll(`[data-message-author-role="assistant"],${TURN},${NATIVE_UNIT}`)) {
      let answer;
      if (candidate.matches('[data-message-author-role="assistant"]')) answer = assistantFor(candidate, doc);
      else {
        // Prefer the actual role element when a turn provides both wrappers.
        if (candidate.querySelector('[data-message-author-role="assistant"]')) continue;
        answer = assistantFor(candidate.querySelector(NATIVE_SOURCE) || candidate.querySelector(PROSE) || candidate, doc);
      }
      if (answer && !result.includes(answer)) result.push(answer);
    }
    return result;
  }
  function userRoots(doc = root.document) {
    if (!doc) return [];
    const result = [...doc.querySelectorAll(USER)].filter(node => !excluded(node, doc));
    for (const heading of doc.querySelectorAll('h4[data-conversation-role="user"]')) {
      const message = heading.parentElement;
      if (message && !excluded(message, doc) && !message.querySelector('h4[data-conversation-role="assistant"]') && !result.some(node => node.contains(message) || message.contains(node))) result.push(message);
    }
    return result;
  }

  function outside(node, forward, bound) {
    while (node && node !== bound) {
      const sibling = forward ? node.nextSibling : node.previousSibling;
      if (sibling) {
        node = sibling;
        if (!forward) while (node.lastChild) node = node.lastChild;
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  function step(node, forward, bound) {
    if (forward && node.firstChild) return node.firstChild;
    return outside(node, forward, bound);
  }
  function boundary(range, forward, doc) {
    const container = forward ? range.startContainer : range.endContainer;
    const offset = forward ? range.startOffset : range.endOffset;
    const bound = range.commonAncestorContainer;
    let node;
    if (container.nodeType === 3) {
      node = (forward ? offset < container.length : offset > 0) ? container : outside(container, forward, bound);
    } else {
      node = container.childNodes[forward ? offset : offset - 1] || outside(container, forward, bound);
      if (!forward && node) while (node.lastChild) node = node.lastChild;
    }
    for (let n = 0; node && n < MAX_STEPS; n++, node = step(node, forward, bound)) {
      if (node.nodeType !== 3 || !node.length) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      // Element boundaries can sit outside the assistant wrapper. Resolve the
      // first/last selected text instead of treating the wrapper as selected.
      if (forward ? range.comparePoint(node, from) > 0 : range.comparePoint(node, to) < 0) return null;
      if (to <= from || !node.data.slice(from, to).trim() || excluded(node, doc)) continue;
      return { node, offset: forward ? from : to };
    }
    return null;
  }
  function block(node) { return element(node)?.closest(BLOCK); }
  function neighbors(endpoint, forward, limit, answer, doc) {
    if (!limit) return '';
    let node = endpoint.node;
    let value = forward ? node.data.slice(endpoint.offset) : node.data.slice(0, endpoint.offset);
    let previousBlock = block(node);
    value = forward ? value.slice(0, limit) : value.slice(-limit);
    for (let n = 0; value.length < limit && n < MAX_STEPS; n++) {
      node = step(node, forward, answer);
      if (!node) break;
      if (node.nodeType !== 3 || !node.length || excluded(node, doc)) continue;
      const currentBlock = block(node);
      const separator = currentBlock !== previousBlock ? '\n' : '';
      value = forward ? (value + separator + node.data).slice(0, limit) : (node.data + separator + value).slice(-limit);
      previousBlock = currentBlock;
    }
    return value;
  }
  function originalQuestion(answer) {
    const main = answer.closest('main');
    let current = answer.closest(TURN) || answer;
    let remaining = 80;
    while (current && current !== main && remaining > 0) {
      for (let previous = current.previousElementSibling; previous && remaining-- > 0; previous = previous.previousElementSibling) {
        const heading = [...previous.querySelectorAll('h4[data-conversation-role="user"]')].at(-1);
        const user = previous.matches(USER) || turnRole(previous) === 'user' ? previous : previous.querySelector(USER) || heading?.parentElement;
        if (user) return C.clip(textValue(user), C.LIMITS.prompt);
      }
      current = current.parentElement;
    }
    return '';
  }
  function detect(selection, doc = root.document) {
    if (!C || !doc) return fail('unavailable');
    if (!selection || selection.isCollapsed || !selection.rangeCount) return fail('collapsed');
    if (selection.rangeCount !== 1) return fail('multiple-ranges');
    try {
      const range = selection.getRangeAt(0);
      if (range.startContainer.getRootNode() !== doc || range.endContainer.getRootNode() !== doc) return fail('outside-document');
      for (const [node, offset, forward] of [[range.startContainer, range.startOffset, true], [range.endContainer, range.endOffset, false]]) {
        // A zero-width boundary beside a control is harmless; actual selected
        // control/composer text must not be skipped into a neighboring answer.
        if (node.nodeType === 3 && (forward ? offset < node.length : offset > 0) && element(node)?.closest(UI)) return fail('excluded-ui');
      }
      const start = boundary(range, true, doc), end = boundary(range, false, doc);
      if (!start || !end) return fail('no-response-text');
      const answer = assistantFor(start.node, doc);
      if (!answer) return fail('not-assistant');
      if (assistantFor(end.node, doc) !== answer) return fail('cross-message');
      const selected = C.clip(selection.toString(), C.LIMITS.selection);
      if (selected.length < 2) return fail('too-short');
      const budget = C.LIMITS.nearby - selected.length;
      const before = neighbors(start, false, Math.min(1400, Math.floor(budget * .4)), answer, doc);
      const after = neighbors(end, true, Math.max(0, budget - before.length - 2), answer, doc);
      const context = C.context({ selection: selected, nearby: `${before}\n${selected}\n${after}`, prompt: originalQuestion(answer) });
      const r = range.getBoundingClientRect();
      const rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      const strategy = answer.matches(NATIVE_SOURCE) ? 'native-renderer' : answer.hasAttribute('data-message-author-role') ? 'role' : turnRole(answer) === 'assistant' ? 'turn-marker' : 'prose-fallback';
      return { ok: true, reason: 'assistant-selection', context, rect, strategy, message: answer };
    } catch {
      // React can replace the selected nodes while a response is streaming.
      return fail('selection-changed');
    }
  }
  // Diagnostics intentionally contain structure and lengths, never chat text,
  // element IDs, class lists, or full aria labels.
  function describe(selection, doc = root.document) {
    const knownRole = value => ['assistant', 'user', 'system', 'tool'].includes(value) ? value : value ? 'other' : '';
    function endpoint(node, offset) {
      const el = element(node), turn = el?.closest(TURN), actualRoot = node?.getRootNode?.();
      let excludedBy = '';
      for (const selector of EXCLUDED.split(',')) if (el?.closest(selector)) { excludedBy = selector; break; }
      const ancestors = [];
      for (let current = el; current && ancestors.length < 8; current = current.parentElement) {
        ancestors.push({ tag: current.tagName.toLowerCase(), author: knownRole(current.getAttribute('data-message-author-role')), turn: knownRole(current.getAttribute('data-turn')), speaker: knownRole(current.getAttribute('data-conversation-role')), nativeUnit: current.matches(NATIVE_UNIT), nativeSource: current.matches(NATIVE_SOURCE), nativeMessage: current.matches(NATIVE_MESSAGE) });
      }
      return {
        nodeType: node?.nodeType || 0, offset,
        textLength: node?.nodeType === 3 ? node.length : 0,
        root: actualRoot === doc ? 'document' : actualRoot?.host ? 'shadow' : 'detached',
        excludedBy, hasTurn: !!turn, turnRole: turn ? knownRole(turnRole(turn)) : '',
        hasProse: !!el?.closest(PROSE), ancestors
      };
    }
    try {
      const count = selection?.rangeCount || 0;
      const result = { rangeCount: count, collapsed: !!selection?.isCollapsed };
      if (count) {
        const range = selection.getRangeAt(0);
        result.start = endpoint(range.startContainer, range.startOffset);
        result.end = endpoint(range.endContainer, range.endOffset);
      }
      return result;
    } catch { return { rangeCount: 0, changed: true }; }
  }
  const api = Object.freeze({ detect, assistantFor, assistantRoots, userRoots, describe });
  root.TmpSelection = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
