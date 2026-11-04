/* Offline geometry regressions. These do not verify signed-in ChatGPT. */
'use strict';
const assert = require('node:assert/strict');

module.exports = async function layoutRegressions({ cdp, source, worker, waitFor, delay }) {
  const evaluate = expression => cdp.evaluate(expression, source);
  const shadow = 'document.getElementById("tmp-chat-root").shadowRoot';
  const click = selector => evaluate(`${shadow}.querySelector(${JSON.stringify(selector)}).click()`);
  const toggle = () => cdp.evaluate('(async()=>{const tab=(await chrome.tabs.query({url:"https://chatgpt.com/c/source"}))[0];await chrome.tabs.sendMessage(tab.id,{type:"tmp:toggle"});return true;})()', worker);
  const setWidth = width => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 941, deviceScaleFactor: 1, mobile: false }, source);
  const inspect = () => evaluate(`(()=>{
    const host=document.getElementById('tmp-chat-root'),s=host.shadowRoot,main=document.querySelector('main');
    const panel=host.getBoundingClientRect(),composer=document.querySelector('.native-composer');
    const rects=[],range=document.createRange(),walk=document.createTreeWalker(main,NodeFilter.SHOW_TEXT);
    let node;while(node=walk.nextNode()){
      if(!node.textContent.trim()||node.parentElement.closest('button,textarea,[contenteditable="true"],script,style'))continue;
      if(getComputedStyle(node.parentElement).visibility==='hidden')continue;
      range.selectNodeContents(node);for(const r of range.getClientRects())if(r.width&&r.height&&r.bottom>0&&r.top<innerHeight)rects.push(r);
    }
    for(const el of [...main.querySelectorAll('img,video,canvas,table,pre'),composer]){const r=el.getBoundingClientRect();if(r.width&&r.height&&r.bottom>0&&r.top<innerHeight)rects.push(r);}
    const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
    return {visible:getComputedStyle(host).display!=='none',card:!s.querySelector('.card').hidden,dock:!s.querySelector('.dock').hidden,
      panelLeft:panel.left,panelWidth:panel.width,dockHeight:s.querySelector('.dock').getBoundingClientRect().height,
      right:rects.reduce((n,r)=>Math.max(n,r.right),0),reserved:document.querySelectorAll('.tmp-chat-reserve-space').length,
      main:box(main),composer:box(composer),mainStyle:main.getAttribute('style'),threadStyle:document.querySelector('#thread')?.getAttribute('style'),
      mainOverflow:main.scrollWidth-main.clientWidth,bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  })()`);
  const expanded = label => waitFor(async () => { const data = await inspect(); return data.visible && data.card && data.right <= data.panelLeft - 8 && data.bodyWidth <= data.viewport ? data : false; }, label);
  const collapsed = label => waitFor(async () => { const data = await inspect(); return data.visible && data.dock && !data.card && !data.reserved ? data : false; }, label);
  const assertPill = data => { assert.equal(data.panelWidth, 152); assert.ok(data.dockHeight < 60, 'Compact mode must preserve the horizontal pill'); };
  const sameRect = (actual, expected, label) => { for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 1, `${label}.${key}: ${actual[key]} vs ${expected[key]}`); };
  const close = async () => { await click('#discard'); await waitFor(async () => !(await inspect()).visible, 'closing an empty panel'); };

  await setWidth(1672);
  await evaluate(`(()=>{
    const main=document.querySelector('main'),thread=document.querySelector('#thread'),text=main.querySelector('.text'),article=main.querySelector('article'),markdown=main.querySelector('.markdown'),composer=document.querySelector('.native-composer'),aside=document.querySelector('aside');
    window.__tmpLayoutFixture={main,thread,text,article,markdown,composer,aside,composerParent:composer.parentNode,composerNext:composer.nextSibling,
      styles:[main,thread,text,article,markdown,composer,aside].map(node=>[node,node.getAttribute('style')]),threadId:thread.id,mainId:main.id};
    text.style.width='calc(100% - 64px)';article.style.position='relative';markdown.style.maxWidth='730px';
    return true;
  })()`);
  try {
    await delay(150);
    const baseline = await inspect();
    await toggle();
    await expanded('expanded panel protects all text and the native composer');

    // This image is a sibling of .markdown, where the old layout never looked.
    await evaluate(`(()=>{const img=document.createElement('img');img.id='tmp-layout-media';img.alt='Layout regression image';img.style.cssText='position:absolute;right:0;top:20px;max-width:none;';window.__tmpLayoutFixture.article.append(img);return true;})()`);
    await delay(150);
    await evaluate(`(()=>{document.getElementById('tmp-layout-media').src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="210" height="130"><rect width="210" height="130" fill="lightblue"/></svg>');return true;})()`);
    await waitFor(() => evaluate('document.getElementById("tmp-layout-media").complete&&document.getElementById("tmp-layout-media").naturalWidth===210'), 'delayed sibling image load');
    let data = await expanded('late-loading sibling media triggers a collision-free reservation');
    assert.ok(data.reserved, 'The wide image requires a reserved column');
    assert.ok(data.mainOverflow <= baseline.mainOverflow + 1, 'Reservation must not introduce horizontal scrolling');

    await click('#minimize');
    data = await collapsed('minimizing removes all reservation'); assertPill(data);
    sameRect(data.main, baseline.main, 'restored main'); sameRect(data.composer, baseline.composer, 'restored composer');
    assert.equal(data.mainStyle, baseline.mainStyle); assert.equal(data.threadStyle, baseline.threadStyle);
    await click('.dock'); await expanded('expanding reserves collision-free space again');

    await evaluate('window.__tmpLayoutFixture.aside.style.width="80px"');
    await expanded('sidebar width changes reflow the reservation');
    await evaluate('window.__tmpLayoutFixture.aside.style.width="250px"');
    await expanded('restoring sidebar width reflows the reservation');
    await close();

    // Width constraints that would create a new inner horizontal scrollbar
    // must cause collapse, rather than concealing part of the source answer.
    await evaluate('window.__tmpLayoutFixture.text.style.minWidth="1250px"');
    const constrainedBaseline = await inspect();
    await toggle(); data = await collapsed('unshrinkable content collapses instead of scrolling horizontally'); assertPill(data);
    sameRect(data.main, constrainedBaseline.main, 'unshrinkable main');
    assert.ok(data.mainOverflow <= constrainedBaseline.mainOverflow + 1);
    await close();
    await evaluate('window.__tmpLayoutFixture.text.style.removeProperty("min-width")');

    await evaluate('window.__tmpLayoutFixture.composer.style.cssText="position:fixed;right:16px;bottom:16px;width:720px;margin:0"');
    const fixedBaseline = await inspect();
    await toggle(); data = await collapsed('a fixed composer that cannot move forces compact mode'); assertPill(data);
    sameRect(data.main, fixedBaseline.main, 'fixed-composer main'); sameRect(data.composer, fixedBaseline.composer, 'fixed composer');
    await close();
    await evaluate(`(()=>{const f=window.__tmpLayoutFixture;const prior=f.styles.find(([node])=>node===f.composer)[1];if(prior===null)f.composer.removeAttribute('style');else f.composer.setAttribute('style',prior);return true;})()`);

    await evaluate(`(()=>{const large=document.createElement('div');large.id='tmp-layout-long';const fragment=document.createDocumentFragment();for(let i=0;i<4100;i++){const span=document.createElement('span');span.textContent='Fragment '+i+' ';fragment.append(span);}large.append(fragment);document.querySelector('main').append(large);return true;})()`);
    await toggle(); data = await collapsed('a truncated content measurement must fail safely'); assertPill(data);
    assert.equal(data.reserved, 0, 'A large DOM must never silently omit later answers from collision protection');
    await close();
    await evaluate('document.getElementById("tmp-layout-long").remove()');

    // Current site variants can make main itself own both thread and composer.
    await evaluate(`(()=>{const f=window.__tmpLayoutFixture;f.thread.style.cssText='flex:1;min-width:0;display:flex;flex-direction:column';f.thread.id='tmp-layout-wrapper';f.main.id='thread';f.main.append(f.composer);return true;})()`);
    await toggle(); await expanded('main itself can be the shared thread/composer shell');
    await click('#minimize'); data = await collapsed('main-shell minimization restores the source'); assertPill(data);
    await click('.dock'); await expanded('main-shell expansion is repeatable');
    await close();
    await evaluate(`(()=>{const f=window.__tmpLayoutFixture;f.main.id=f.mainId;f.thread.id=f.threadId;f.composerParent.insertBefore(f.composer,f.composerNext);const prior=f.styles.find(([node])=>node===f.thread)[1];if(prior===null)f.thread.removeAttribute('style');else f.thread.setAttribute('style',prior);return true;})()`);

    await setWidth(980); await delay(150);
    const narrowBaseline = await inspect();
    await toggle(); data = await collapsed('a narrow viewport retains the horizontal compact dock'); assertPill(data);
    sameRect(data.main, narrowBaseline.main, 'narrow main'); sameRect(data.composer, narrowBaseline.composer, 'narrow composer');
    await close();
    assert.equal(await cdp.evaluate('(async()=>!(await chrome.storage.session.get("tmp.chat.session"))["tmp.chat.session"])()', worker), true, 'Layout-only interaction must not create a tangent');
    console.log('PASS full content/media/composer bounds, delayed image, shared main shell, sidebar changes, fixed/min-width/large-DOM collapse, and exact minimize/close restoration');
  } finally {
    await evaluate(`(()=>{
      const host=document.getElementById('tmp-chat-root'),s=host.shadowRoot;
      if(getComputedStyle(host).display!=='none'&&!s.querySelector('.card').hidden)s.querySelector('#discard').click();
      const f=window.__tmpLayoutFixture;if(!f)return true;
      document.getElementById('tmp-layout-media')?.remove();document.getElementById('tmp-layout-long')?.remove();f.main.id=f.mainId;f.thread.id=f.threadId;f.composerParent.insertBefore(f.composer,f.composerNext);
      for(const [node,style] of f.styles){if(style===null)node.removeAttribute('style');else node.setAttribute('style',style);}
      delete window.__tmpLayoutFixture;return true;
    })()`);
    // A compact dock has no visible close button: restore the width and expand
    // before closing, leaving subsequent smoke tests with their original page.
    await setWidth(1672); await delay(200);
    let data = await inspect();
    if (data.visible && data.dock) { await click('.dock'); await delay(150); data = await inspect(); }
    if (data.visible) await close();
  }
};
