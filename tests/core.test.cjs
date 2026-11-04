'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/core.js');

test('stream revisions reject duplicates, gaps, and wrong offsets while allowing full repair', () => {
  assert.equal(C.streamCheck('', 0, { sequence: 1, offset: 0, delta: 'A' }), 'apply');
  assert.equal(C.streamCheck('A', 1, { sequence: 1, offset: 0, delta: 'A' }), 'ignore');
  assert.equal(C.streamCheck('A', 1, { sequence: 3, offset: 1, delta: 'C' }), 'resync');
  assert.equal(C.streamCheck('A', 1, { sequence: 2, offset: 0, delta: 'B' }), 'resync');
  assert.equal(C.streamCheck('A', 1, { sequence: 3, text: 'ABC' }), 'apply');
  assert.equal(C.streamCheck('ABC', 3, { sequence: 4, text: '' }), 'apply');
  assert.equal(C.streamCheck('', 0, { sequence: NaN, delta: 'A' }), 'resync');
  assert.equal(C.streamCheck('', 0, { delta: 'Legacy adapter' }), 'apply');
});
test('first question includes bounded source context, follow-ups do not repeat it', () => {
  const ctx = { selection: 'selected passage', nearby: 'x'.repeat(20000), prompt: 'original question' };
  const first = C.buildPrompt(ctx, 'Why?', true);
  assert.match(first, /selected passage/); assert.match(first, /original question/); assert.ok(first.length < 5000);
  assert.equal(C.buildPrompt(ctx, 'What about that?', false), 'What about that?');
});
test('context and questions cannot grow without bounds', () => {
  assert.equal(C.context({ selection: 'x'.repeat(10000) }).selection.length, C.LIMITS.selection);
  assert.equal(C.buildPrompt({}, 'x'.repeat(10000), false).length, C.LIMITS.question);
});
test('response trees strip executable elements, unsafe links, and hostile attributes', () => {
  const result = C.cleanTree([{tag:'script',children:[{text:'alert(1)'}]}, {tag:'a',href:'javascript:alert(1)',onclick:'evil()',children:[{text:'click'}]}, {tag:'p',style:'evil',children:[{text:'safe'}]}]);
  assert.equal(result.length,2); assert.equal(result[0].href,null); assert.equal(result[1].style,undefined); assert.equal(result[0].onclick,undefined);
  assert.equal(C.safeURL('https://example.org/a'), 'https://example.org/a');
});
test('response trees have size and depth limits', () => {
  assert.equal(C.cleanTree([{text:'x'.repeat(100000)}])[0].text.length,C.LIMITS.answer);
  let node = {text:'deep'}; for (let i=0;i<100;i++) node={tag:'p',children:[node]};
  assert.ok(JSON.stringify(C.cleanTree([node])).length < 1500);
});
test('wide layout uses the margin, medium layout reserves space, narrow layout collapses', () => {
  assert.deepEqual(C.layout(1800,260,1250),{compact:false,width:344,reserve:0});
  assert.deepEqual(C.layout(1440,260,1180),{compact:false,width:344,reserve:376});
  assert.deepEqual(C.layout(980,260,900),{compact:true,width:44,reserve:68});
});
test('copying a conversation never includes the hidden context prompt', () => {
  assert.equal(C.transcript([{role:'user',text:'Why?'},{role:'assistant',text:'Because.'},{role:'assistant',text:''}]), 'You\nWhy?\n\nChatGPT\nBecause.');
});
test('draft verification tolerates native contenteditable whitespace, but detects changed text', () => {
  assert.equal(C.sameDraft('one\n\n two\u00a0three', 'one\ntwo three'),true);
  assert.equal(C.sameDraft('one two', 'one three'),false);
});
test('stream patches handle appends and rewrites without unbounded growth', () => {
  assert.equal(C.streamText('Hello',{delta:' world'}),'Hello world');
  assert.equal(C.streamText('old',{text:'new'}),'new');
  assert.equal(C.streamText('x'.repeat(C.LIMITS.answer),{delta:'overflow'}).length,C.LIMITS.answer);
});

test('streaming preserves indentation and whitespace-only chunks', () => {
  let value = C.streamText('', { text: '  def method():' });
  value = C.streamText(value, { delta: '\n' });
  value = C.streamText(value, { delta: '    ' });
  value = C.streamText(value, { delta: 'return 1\n' });
  assert.equal(value, '  def method():\n    return 1\n');
  assert.equal(C.streamText('old', { text: '\n  rewritten\n' }), '\n  rewritten\n');
});

test('initial prompt requests concise readable answers without forbidding code', () => {
  const prompt = C.buildPrompt({}, 'Explain a class', true);
  assert.match(prompt, /short paragraphs or bullets/);
  assert.match(prompt, /code block.*preserving indentation/);
  assert.match(prompt, /Prefer text explanations over interactive visuals/);
  assert.equal(C.buildPrompt({}, 'Expand with code', false), 'Expand with code');
});
