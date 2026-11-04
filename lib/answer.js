/* Read complete assistant answers without copying ChatGPT's executable UI. */
(function (root) {
  'use strict';
  const C = root.TmpCore || (typeof require === 'function' ? require('./core.js') : null);
  // Search/copy enrichment may arrive after prose. The explicit assistant role
  // and its bounded parent identify a live response independently of that data.
  const UNIT = '[data-content-search-unit-key],[data-chatgpt-search-unit-key],[data-chatgpt-search-message-ids]';
  const ROLE = 'h4[data-conversation-role="assistant"]';
  const ASSISTANT = '[data-message-author-role="assistant"],[data-turn="assistant"],[data-testid="assistant-message"]';
  const USER = '[data-message-author-role="user"],[data-turn="user"],[data-testid="user-message"],h4[data-conversation-role="user"]';
  const TURN = '[data-testid^="conversation-turn-"],article';
  const PROSE = '.markdown,.prose,[data-message-content]';
  const REASONING = '[data-message-channel="analysis"],[data-channel="analysis"],[data-message-type="reasoning"],[data-content-type="reasoning"],[data-is-reasoning="true"],[data-testid="reasoning"],[data-testid="reasoning-content"],[data-testid="reasoning-block"]';
  const SKIP = `button,[role="button"],script,style,noscript,template,form,input,textarea,select,[hidden],[aria-hidden="true"],[inert],.sr-only,[data-conversation-role],[data-testid="conversation-turn-label"],.line-numbers,.cm-gutters,.minimap,${REASONING}`;
  const EDITOR = '.cm-editor,.cm-content,.monaco-editor,.view-lines';
  const CODE = `pre,${EDITOR}`;
  const WIDGET = 'svg,canvas,iframe,object,embed,img,picture,video,audio,[role="application"],[role="img"],[data-testid="interactive-map"],[data-testid="interactive-chart"],[data-testid="map"],[data-testid="chart"]';
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'pre']);
  const LANG = /^(?:python|javascript|typescript|jsx|tsx|java|c|c\+\+|c#|csharp|go|rust|ruby|php|swift|kotlin|scala|r|sql|bash|sh|shell|powershell|html|css|json|yaml|yml|xml|toml|text|plaintext|plain text|markdown|md|mermaid|code)$/i;
  // Leave headroom for safe-tree validation and avoid unbounded DOM work.
  const MAX_NODES = 1800, MAX_DEPTH = 20;
  const tagOf = node => String(node?.tagName || '').toLowerCase();
  const matches = (node, selector) => !!node?.matches?.(selector);
  const all = (node, selector) => [...(node?.querySelectorAll?.(selector) || [])];
  const nearest = (node, selector) => node?.closest?.(selector) || null;
  const boundarySelector = `${ASSISTANT},${UNIT},${ROLE}`;
  const observedAttributes = Object.freeze(['data-conversation-role', 'data-message-author-role', 'data-turn', 'data-testid', 'data-message-id', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key', 'data-chatgpt-search-message-ids', 'data-chatgpt-selection-message-id', 'data-message-channel', 'data-channel', 'data-message-type', 'data-content-type', 'data-is-reasoning', 'hidden', 'aria-hidden', 'inert']);

  function eligible(candidate) {
    if (!candidate || nearest(candidate, '[hidden],[aria-hidden="true"],[inert]') || nearest(candidate, REASONING) || nearest(candidate, USER) || candidate.querySelector(USER)) return false;
    if (matches(candidate, ASSISTANT)) return true;
    // The observed native heading is a direct child of the role boundary.
    // Never walk upward into a shared turn to find an arbitrary prose region.
    const headings = all(candidate, 'h4[data-conversation-role]');
    if (headings.length === 1 && headings[0].parentElement === candidate && headings[0].getAttribute('data-conversation-role') === 'assistant') return !!nearest(candidate, 'main') && !matches(candidate, 'main,body,html');
    if (matches(candidate, UNIT) || !matches(candidate, TURN) || !nearest(candidate, 'main') || candidate.querySelector(boundarySelector)) return false;
    const label = candidate.getAttribute('aria-label') || candidate.querySelector('h5.sr-only,h6.sr-only,[data-testid="conversation-turn-label"]')?.textContent || '';
    return !/^\s*(?:you said|your message|user)\s*[:：]?\s*$/i.test(label) && (/^\s*(?:chatgpt said|assistant said|assistant)\s*[:：]?\s*$/i.test(label) || !!candidate.querySelector(PROSE));
  }

  function identity(answer) {
    if (!answer) return '';
    for (const name of ['data-message-id', 'data-chatgpt-search-message-ids', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key']) {
      const value = answer.getAttribute(name);
      if (value) return `${name}:${value}`;
    }
    const message = answer.querySelector('[data-chatgpt-selection-message-id]');
    return message?.getAttribute('data-chatgpt-selection-message-id') ? `message:${message.getAttribute('data-chatgpt-selection-message-id')}` : '';
  }

  function roots(doc = root.document) {
    if (!doc) return [];
    const answers = [];
    for (const node of all(doc, `${boundarySelector},${TURN}`)) {
      const candidate = matches(node, ROLE) ? node.parentElement : node;
      if (!eligible(candidate)) continue;
      // Prefer the role boundary over an enclosing generic turn; otherwise
      // retain one stable element containing every answer block in DOM order.
      if (answers.some(answer => answer.contains(candidate))) continue;
      for (let index = answers.length - 1; index >= 0; index--) if (candidate.contains(answers[index])) answers.splice(index, 1);
      answers.push(candidate);
    }
    return answers;
  }

  function snapshot(answer, options = {}) {
    const withTree = options.tree !== false;
    const notices = new Set();
    let visited = 0, remaining = C.LIMITS.answer, placeholders = 0;
    const piece = (text = '', tree = []) => ({ text, ...(withTree ? { tree } : {}) });
    function limited(text) {
      text = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
      if (text.length > remaining) notices.add('truncated');
      const result = text.slice(0, remaining); remaining -= result.length; return result;
    }
    function textNode(text) {
      text = limited(text);
      return piece(text, text ? [{ text }] : []);
    }
    function wrap(tag, content, extra = {}) {
      return piece(content.text, withTree ? [{ tag, children: content.tree, ...extra }] : []);
    }
    function skip(node) { return matches(node, SKIP) || matches(node, USER); }
    function languageHeader(node) {
      if (!['div', 'span', 'header'].includes(tagOf(node)) || (node.textContent || '').length > 120 || node.querySelector(CODE)) return false;
      if (nearest(node, 'p,li,td,th,blockquote,h1,h2,h3,h4,h5,h6,pre,code')) return false;
      const label = current => current.nodeType === 3 ? current.textContent : matches(current, 'button,[role="button"],svg') ? '' : [...current.childNodes].map(label).join('');
      if (!LANG.test(label(node).trim())) return false;
      if (tagOf(node) === 'span' && (!['div', 'header'].includes(tagOf(node.parentElement)) || !LANG.test(label(node.parentElement).trim()))) return false;
      return !!node.parentElement?.querySelector(CODE) || !!node.parentElement?.parentElement?.querySelector(CODE);
    }
    function fallback(node) {
      notices.add('unsupported');
      if (++placeholders > 16) return piece();
      const label = ['img', 'picture'].includes(tagOf(node)) ? 'Image' : 'Interactive content';
      return wrap('blockquote', textNode(`${label} — view in ChatGPT.`));
    }
    function raw(node, depth = 0, budget = { left: remaining + 1 }) {
      if (++visited > MAX_NODES || depth > MAX_DEPTH) { notices.add('truncated'); return ''; }
      if (node.nodeType === 3) {
        const value = String(node.textContent || '').replace(/\u0000/g, '').replace(/\u00a0/g, ' ');
        if (value.length > budget.left) notices.add('truncated');
        const text = value.slice(0, budget.left); budget.left -= text.length; return text;
      }
      if (node.nodeType !== 1 || skip(node)) return '';
      if (tagOf(node) === 'br') { if (!budget.left) return ''; budget.left--; return '\n'; }
      let value = '';
      for (const child of node.childNodes) {
        const childText = raw(child, depth + 1, budget);
        value += childText;
        if (['div', 'p'].includes(tagOf(child)) && child !== node.childNodes[node.childNodes.length - 1] && !childText.endsWith('\n')) {
          if (budget.left) { value += '\n'; budget.left--; } else notices.add('truncated');
        }
        if (visited > MAX_NODES || !budget.left) { if (child !== node.childNodes[node.childNodes.length - 1]) notices.add('truncated'); break; }
      }
      return value;
    }
    function code(node) {
      // CodeMirror/Monaco represent newlines using sibling divs, not text.
      // textContent or flattening spans would join those lines together.
      const lines = all(node, '.cm-line,.view-line').filter(line => !nearest(line.parentElement, '.cm-line,.view-line'));
      let source = '';
      if (lines.length) {
        const budget = { left: remaining + 1 };
        for (const line of lines) {
          if (visited > MAX_NODES || !budget.left) { notices.add('truncated'); break; }
          let value = raw(line, 0, budget);
          if (value === '\n' && line.childNodes.length === 1 && tagOf(line.firstChild) === 'br') { value = ''; budget.left++; }
          if (line !== lines[0]) { source += '\n'; budget.left = Math.max(0, budget.left - 1); }
          source += value;
        }
      } else source = raw(node.querySelector?.('code') || node);
      if (node.querySelector?.('.cm-gap') || Number(node.getAttribute?.('data-line-count')) > lines.length && lines.length) notices.add('truncated');
      const content = textNode(source);
      return wrap('pre', wrap('code', content));
    }
    function combine(children) {
      return piece(children.map(child => child.text).join(''), withTree ? children.flatMap(child => child.tree) : []);
    }
    function childrenOf(node, depth) {
      const children = [];
      for (const child of node.childNodes) {
        children.push(convert(child, depth));
        if (visited > MAX_NODES) break;
      }
      return combine(children);
    }
    function convert(node, depth = 0) {
      if (++visited > MAX_NODES || depth > MAX_DEPTH) { notices.add('truncated'); return piece(); }
      if (!remaining) { if (node.textContent || matches(node, WIDGET)) notices.add('truncated'); return piece(); }
      if (node.nodeType === 3) return textNode(String(node.textContent || '').replace(/\s+/g, ' '));
      if (node.nodeType !== 1 || skip(node) || languageHeader(node)) return piece();
      const tag = tagOf(node);
      if (tag === 'pre' || matches(node, EDITOR)) {
        const value = code(node); value.text += '\n\n'; return value;
      }
      if (matches(node, WIDGET)) { const value = fallback(node); value.text += '\n\n'; return value; }
      if (tag === 'code') return wrap('code', textNode(raw(node)));
      if (tag === 'br') return piece('\n', withTree ? [{ tag: 'br', children: [] }] : []);
      const content = childrenOf(node, depth + 1);
      if (tag === 'li') content.text = `• ${content.text.replace(/\n+$/, '')}\n`;
      else if (tag === 'td' || tag === 'th') content.text += '\t';
      else if (BLOCK.has(tag) && content.text && !content.text.endsWith('\n')) content.text += tag === 'tr' ? '\n' : '\n\n';
      const safeTag = tag === 'h5' || tag === 'h6' ? 'h4' : tag;
      if (C.TAGS.has(safeTag)) return wrap(safeTag, content, safeTag === 'a' ? { href: C.safeURL(node.getAttribute('href') ? node.href : null) } : {});
      // A div containing prose without semantic block tags still needs a
      // boundary in the panel, rather than visually concatenated sentences.
      if (['div', 'section', 'figcaption'].includes(tag) && content.tree?.length && !content.tree.some(child => child.tag && BLOCK.has(child.tag))) return wrap('p', content);
      return content;
    }
    if (!answer) return { text: '', ...(withTree ? { tree: [] } : {}), notices: [] };
    const result = childrenOf(answer, 0);
    result.text = result.text.replace(/^\n+|\n+$/g, '');
    if (result.text.length > C.LIMITS.answer) notices.add('truncated');
    result.text = result.text.slice(0, C.LIMITS.answer);
    if (remaining === 0 && visited > MAX_NODES) notices.add('truncated');
    return { ...result, notices: [...notices] };
  }

  const api = Object.freeze({ roots, snapshot, eligible, identity, boundarySelector, observedAttributes });
  root.TmpAnswer = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
