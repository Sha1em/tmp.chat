'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/core.js');
const A = require('../lib/answer.js');

// A small DOM-shaped test helper. Browser regressions separately exercise real
// Chromium DOM APIs and styles; these tests check extraction and trust bounds.
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.childNodes = [];
    for (const child of children) this.append(child);
  }
  append(child) {
    if (typeof child === 'string') child = { nodeType: 3, textContent: child };
    child.parentElement = this; this.childNodes.push(child); return child;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  get href() { try { return new URL(this.attrs.href, 'https://chatgpt.com/').href; } catch { return this.attrs.href; } }
  getAttribute(name) { return this.attrs[name] ?? null; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains?.(node) || child === node); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim(); const tag = part.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      for (const [, name] of part.matchAll(/\.([\w-]+)/g)) if (!(this.attrs.class || '').split(/\s+/).includes(name)) return false;
      for (const [, name, operator, value] of part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)) {
        if (!(name in this.attrs)) return false;
        if (operator === '=' && this.attrs[name] !== value) return false;
        if (operator === '^=' && !this.attrs[name].startsWith(value)) return false;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) if (child.nodeType === 1) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const el = (tag, attrs, ...children) => new Element(tag, attrs, children.flat());
const p = text => el('p', {}, text);
const assistant = (...children) => el('article', { 'data-message-author-role': 'assistant' }, ...children);
const doc = (...children) => el('html', {}, el('body', {}, el('main', {}, ...children)));
const nativeSource = (...children) => el('div', { 'data-dil-source-message-id': 'answer', 'data-chatgpt-copy-reference': 'answer', 'data-markdown-copy': '' }, ...children);
const nativeMessage = (...children) => el('div', { 'data-chatgpt-selection-conversation-id': 'conversation', 'data-chatgpt-selection-message-id': 'answer' }, ...children);
const nativeUnit = (...children) => el('div', { 'data-content-search-unit-key': 'unit', 'data-chatgpt-search-unit-key': 'unit', 'data-chatgpt-search-message-ids': 'answer' }, el('h4', { 'data-conversation-role': 'assistant' }, 'ChatGPT said:'), ...children);
const flatten = tree => tree.map(node => node.text ?? flatten(node.children || [])).join('');
function tags(tree) { return tree.flatMap(node => node.tag ? [node.tag, ...tags(node.children || [])] : []); }
function find(tree, tag) { for (const node of tree) { if (node.tag === tag) return node; const child = node.children && find(node.children, tag); if (child) return child; } return null; }

test('the entire legacy assistant answer is retained across separate markdown regions', () => {
  const answer = assistant(el('div', { class: 'markdown' }, p('Before the example.')), el('div', { class: 'markdown' }, el('pre', {}, el('code', {}, 'class Account:\n    pass'))), el('div', { class: 'markdown' }, p('After the example.')));
  assert.deepEqual(A.roots(doc(answer)), [answer]);
  const result = A.snapshot(answer);
  assert.match(result.text, /^Before the example\.\n\nclass Account:\n    pass\n\nAfter the example\.$/);
  assert.equal(flatten(find(result.tree, 'pre').children), 'class Account:\n    pass');
  assert.deepEqual(result.notices, []);
});

test('native roots use one assistant-only unit, never the shared user/assistant turn or first source', () => {
  const first = nativeSource(p('An object is one particular instance.'));
  const second = nativeSource(p('A class is its blueprint.'));
  const answer = nativeUnit(nativeMessage(first, second), el('button', {}, 'Copy'));
  const user = el('div', {}, el('h4', { 'data-conversation-role': 'user' }, 'You said:'), p('PRIVATE USER PROMPT'));
  const shared = el('div', { 'data-testid': 'conversation-turn-1' }, user, answer);
  assert.deepEqual(A.roots(doc(shared)), [answer]);
  const result = A.snapshot(answer);
  assert.match(result.text, /particular instance[\s\S]*blueprint/);
  assert.doesNotMatch(result.text, /PRIVATE|ChatGPT said|Copy/);
});

test('ambiguous native units and copy metadata without an assistant boundary fail closed', () => {
  const mixed = nativeUnit(nativeMessage(nativeSource(p('Answer'))), el('h4', { 'data-conversation-role': 'user' }, 'User'));
  const unbounded = el('div', {}, nativeSource(p('Answer without assistant boundary')));
  assert.deepEqual(A.roots(doc(mixed, unbounded)), []);
});

test('explicit native assistant boundary streams before any search/copy metadata exists', () => {
  const answer = el('div', {}, el('h4', { 'data-conversation-role': 'assistant' }, 'ChatGPT said:'), p('Early answer.'));
  const shared = el('div', {}, el('div', {}, el('h4', { 'data-conversation-role': 'user' }, 'You said:'), p('PRIVATE PROMPT')), answer);
  const document = doc(shared);
  assert.deepEqual(A.roots(document), [answer]);
  assert.equal(A.snapshot(answer, { tree: false }).text, 'Early answer.');
  answer.attrs['data-chatgpt-search-unit-key'] = 'late-unit';
  assert.deepEqual(A.roots(document), [answer], 'Partial enrichment must not change the role boundary');
  answer.attrs['data-chatgpt-search-message-ids'] = 'late-id';
  assert.deepEqual(A.roots(document), [answer]);
});

test('role-only discovery rejects shared, hidden, reasoning, and unbounded heading containers', () => {
  const role = () => el('h4', { 'data-conversation-role': 'assistant' }, 'ChatGPT said:');
  const hidden = el('div', { hidden: '' }, role(), p('Hidden'));
  const reasoning = el('div', { 'data-message-channel': 'analysis' }, role(), p('Reasoning'));
  const mixed = el('div', {}, role(), el('h4', { 'data-conversation-role': 'user' }, 'User'), p('Shared'));
  const repeated = el('div', {}, role(), role(), p('Ambiguous'));
  assert.deepEqual(A.roots(doc(hidden, reasoning, mixed, repeated)), []);
  assert.deepEqual(A.roots(doc(role(), p('Unbounded main text'))), []);
});

test('answer identity is stable across an old root remount and distinct for another turn', () => {
  const first = assistant(p('First')); first.attrs['data-message-id'] = 'old';
  const remount = assistant(p('First')); remount.attrs['data-message-id'] = 'old';
  const second = assistant(p('Second')); second.attrs['data-message-id'] = 'new';
  assert.equal(A.identity(first), A.identity(remount));
  assert.notEqual(A.identity(first), A.identity(second));
  assert.equal(A.identity(assistant(p('Unidentified'))), '');
});

test('CodeMirror div lines preserve Python indentation and empty br lines without language/control chrome', () => {
  const editor = el('div', { class: 'cm-editor' }, el('div', { class: 'cm-gutters' }, '1 2 3 4'), el('div', { class: 'cm-content' },
    el('div', { class: 'cm-line' }, el('span', {}, 'class BankAccount:')),
    el('div', { class: 'cm-line' }, '    def balance(self):'),
    el('div', { class: 'cm-line' }, el('br', {})),
    el('div', { class: 'cm-line' }, '        return self.balance')));
  const block = el('div', {}, el('div', {}, el('span', {}, 'Python'), el('button', {}, 'Copy code'), el('button', {}, 'Run')), editor);
  const answer = assistant(p('For example:'), block, p('This refers to one account.'));
  const result = A.snapshot(answer);
  const expected = 'class BankAccount:\n    def balance(self):\n\n        return self.balance';
  assert.equal(flatten(find(result.tree, 'pre').children), expected);
  assert.match(result.text, /For example:[\s\S]*class BankAccount:[\s\S]*This refers to one account\./);
  assert.doesNotMatch(result.text, /Python|Copy code|Run|1 2 3 4/);
  assert.equal(result.text.includes(expected), true);
});

test('Monaco rendered lines preserve indentation and code is text rather than HTML', () => {
  const answer = assistant(el('div', { class: 'monaco-editor' }, el('div', { class: 'view-lines' },
    el('div', { class: 'view-line' }, '<script>alert(1)</script>'),
    el('div', { class: 'view-line' }, '\u00a0\u00a0return "<b>literal</b>"'))));
  const result = A.snapshot(answer);
  assert.equal(flatten(find(result.tree, 'pre').children), '<script>alert(1)</script>\n  return "<b>literal</b>"');
  assert.deepEqual(tags(result.tree), ['pre', 'code']);
});

test('div-based code lines without an editor class preserve line boundaries and blank lines', () => {
  const answer = assistant(el('pre', {}, el('code', {}, el('div', {}, 'class Account:'), el('div', {}, '    def balance(self):'), el('div', {}, el('br', {})), el('div', {}, '        return 5'))));
  assert.equal(flatten(find(A.snapshot(answer).tree, 'pre').children), 'class Account:\n    def balance(self):\n\n        return 5');
});

test('language names in ordinary inline prose are preserved beside code', () => {
  const answer = assistant(el('p', {}, el('span', {}, 'Python'), ' is useful here.'), el('div', {}, el('span', {}, 'Python'), ' is also a language.'), el('pre', {}, el('code', {}, 'return 5')));
  const result = A.snapshot(answer);
  assert.match(result.text, /^Python is useful here\./);
  assert.match(result.text, /Python is also a language\./);
});

test('unsupported widgets leave an explicit safe placeholder and keep all following prose', () => {
  const answer = assistant(p('Before the diagram.'), el('svg', { onclick: 'evil()' }, el('text', {}, 'Private widget internals')), p('After the diagram.'), el('iframe', { src: 'https://example.com' }), p('Final explanation.'));
  const result = A.snapshot(answer);
  assert.match(result.text, /Before the diagram[\s\S]*Interactive content — view in ChatGPT\.[\s\S]*After the diagram[\s\S]*Final explanation/);
  assert.deepEqual(result.notices, ['unsupported']);
  assert.doesNotMatch(JSON.stringify(result.tree), /iframe|onclick|Private widget|example\.com/);
});

test('lists, tables, headings, inline code, and safe links survive without executable attributes', () => {
  const answer = assistant(el('h5', {}, 'A useful distinction'), el('ul', {}, el('li', {}, 'Use ', el('code', {}, 'self'))), el('table', {}, el('tbody', {}, el('tr', {}, el('th', {}, 'Class'), el('td', {}, 'Blueprint')))), p('After the table.'), el('a', { href: '/help', onclick: 'evil()' }, 'Help'), el('a', { href: 'javascript:alert(1)' }, 'Unsafe'));
  const result = A.snapshot(answer);
  for (const tag of ['h4', 'ul', 'li', 'code', 'table', 'tbody', 'tr', 'th', 'td', 'a']) assert.equal(tags(result.tree).includes(tag), true, tag);
  const links = result.tree.filter(node => node.tag === 'a');
  assert.equal(links[0].href, 'https://chatgpt.com/help'); assert.equal(links[1].href, null);
  assert.doesNotMatch(JSON.stringify(result.tree), /onclick|javascript:/);
  assert.deepEqual(C.cleanTree(result.tree), result.tree);
});

test('hidden, reasoning, user, form, and action text is excluded without excluding final text', () => {
  const answer = assistant(el('div', { 'data-message-channel': 'analysis' }, p('PRIVATE REASONING')), el('div', { 'data-testid': 'reasoning-content' }, p('MORE REASONING')), p('The visible final answer.'), el('div', { hidden: '' }, 'HIDDEN'), el('div', { 'aria-hidden': 'true' }, 'HIDDEN'), el('div', { 'data-turn': 'user' }, 'USER'), el('form', {}, 'DRAFT'), el('button', {}, 'Retry'));
  const result = A.snapshot(answer);
  assert.equal(result.text, 'The visible final answer.');
  assert.equal(flatten(result.tree), 'The visible final answer.');
});

test('the streaming path produces identical normalized text/notices without constructing a tree', () => {
  const answer = assistant(el('div', {}, 'First paragraph.'), el('div', {}, 'Second paragraph.'), el('pre', {}, el('code', {}, '  indented\n\tline\n')), el('canvas', {}));
  const full = A.snapshot(answer), streaming = A.snapshot(answer, { tree: false });
  assert.equal(streaming.text, full.text); assert.deepEqual(streaming.notices, full.notices); assert.equal('tree' in streaming, false);
  assert.match(streaming.text, /First paragraph\.\n\nSecond paragraph\./);
  assert.equal(flatten(find(full.tree, 'pre').children), '  indented\n\tline\n');
});

test('character, node, depth, and known virtualized-code limits report truncation explicitly', () => {
  const long = A.snapshot(assistant(p('x'.repeat(C.LIMITS.answer + 1))));
  assert.equal(long.text.length, C.LIMITS.answer); assert.equal(long.notices.includes('truncated'), true);
  const many = A.snapshot(assistant(...Array.from({ length: 2000 }, () => el('span', {}, 'x'))));
  assert.equal(many.notices.includes('truncated'), true); assert.ok(many.tree.length < 2000);
  const manyCode = A.snapshot(assistant(...Array.from({ length: 800 }, () => el('div', { class: 'cm-editor' }, 'x'))));
  assert.deepEqual(C.cleanTree(manyCode.tree), manyCode.tree, 'generated wrappers must remain inside final safe-tree validation limits');
  let deep = p('Deep text'); for (let i = 0; i < 25; i++) deep = el('div', {}, deep);
  assert.equal(A.snapshot(assistant(deep)).notices.includes('truncated'), true);
  const virtual = assistant(el('div', { class: 'cm-editor' }, el('div', { class: 'cm-content' }, el('div', { class: 'cm-line' }, 'first line'), el('div', { class: 'cm-gap' }))));
  assert.equal(A.snapshot(virtual).notices.includes('truncated'), true);
});
