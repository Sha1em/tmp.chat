'use strict';
module.exports = function fixture(helper = false, variant = false) {
  // Named modes exercise connection stages separately. They are offline DOM
  // examples, not assertions about ChatGPT's signed-in website.
  const mode = typeof variant === 'string' ? variant : variant ? 'unverified' : '';
  const unverified = mode === 'unverified' || mode === 'temporary-toggle';
  const dil = mode === 'dil' || mode === 'rich' || mode === 'streaming';
  const modern = ['modern', 'loading', 'loading-manual', 'personalization', 'dil', 'rich'].includes(mode);
  const editor = mode === 'textarea'
    ? '<textarea id="prompt-textarea" data-fixture-editor aria-label="Ask anything" placeholder="Ask anything"></textarea>'
    : mode === 'submission-ready'
      ? '<div style="min-height:40px;white-space:pre-wrap;outline:0" data-fixture-editor contenteditable="true" role="textbox" aria-label="Preparing editor"></div>'
    : dil
      ? '<div class="ProseMirror" style="min-height:40px;white-space:pre-wrap;outline:0" data-fixture-editor contenteditable="true" role="textbox" aria-label="Ask ChatGPT" data-placeholder="Ask ChatGPT"></div>'
    : modern
      ? '<textarea id="prompt-textarea" hidden aria-hidden="true"></textarea><div class="ProseMirror" style="min-height:40px;white-space:pre-wrap;outline:0" data-fixture-editor contenteditable="true" role="textbox" aria-label="Ask anything" data-placeholder="Ask anything"></div>'
      : '<div id="prompt-textarea" data-fixture-editor contenteditable="true" role="textbox" aria-label="Message ChatGPT"></div>';
  const base = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT — tmp.chat test</title><style>
    *{box-sizing:border-box}body{margin:0;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202123;background:#fff}.app{display:flex;height:100vh}aside{width:250px;flex:none;background:#f8f8f8;padding:24px}aside h2{font-size:18px;margin:0 0 35px}aside p{font-size:14px;color:#555;margin:18px 0}#thread{flex:1;min-width:0;display:flex;flex-direction:column}main{overflow:auto;flex:1}.text{width:min(730px,calc(100% - 80px));margin:42px auto 20px}h1{font-size:29px;letter-spacing:-.8px;margin:0 0 18px;line-height:1.3}h2{font-size:22px;line-height:1.4;margin:30px 0 12px}p{margin:12px 0}li{margin:6px 0}.user{background:#f3f3f3;border-radius:16px;padding:11px 16px;margin:0 0 25px auto;max-width:75%;font-size:14px}.native-composer{width:min(760px,calc(100% - 64px));margin:0 auto 20px;border:1px solid #ddd;border-radius:22px;padding:17px;color:#999;box-shadow:0 2px 10px #00000006;min-height:95px}button{font:inherit}#prompt-textarea{outline:0;min-height:40px;white-space:pre-wrap;color:#222}[data-testid=send-button],[data-testid=stop-button]{border:0;border-radius:50%;background:#222;color:white;padding:8px 13px;float:right}.dark body{background:#212121;color:#ececec}.dark aside{background:#171717}.dark aside p{color:#aaa}.dark .user{background:#303030}.dark .native-composer{border-color:#444}
  </style></head><body><div class="app"><aside><h2>◌ &nbsp; ChatGPT</h2><p>＋ &nbsp; New chat</p><p>⌕ &nbsp; Search chats</p><p style="margin-top:50px;color:#999;font-size:11px">Today</p><p>Product ideas</p><p>Understanding attention</p><p>Writing help</p></aside><div id="thread"><main><div class="text">`;
  if (!helper) return base + `<div data-message-author-role="user" class="user">Explain how attention works in a transformer.</div><article data-message-author-role="assistant"><div class="markdown"><h1>A more focused way to understand attention</h1><p>Attention lets a model decide which parts of an input matter most when it produces the next piece of its response.</p><h2>How it works</h2><p id="select-me">Each token creates a query, a key, and a value. The query is compared with the keys of other tokens to determine which information should receive more weight.</p><p>These weights help the model combine the values into a representation that reflects the surrounding context. Different attention heads can learn different relationships.</p><h2>Why this matters</h2><ul><li>Words can depend on information far earlier in a sentence.</li><li>The model can combine several kinds of relationships.</li><li>Context helps resolve ambiguous words and references.</li></ul><h2>A concrete example</h2><p>In “the animal was tired because it ran,” attention can help connect “it” with the animal. The useful relationship depends on the sentence, rather than a fixed distance.</p></div></article></div></main><div class="native-composer">Message ChatGPT…</div></div></div></body></html>`;
  const header = mode === 'submission-ready' ? '<h1 id="fixture-temporary-heading">Loading</h1>' : dil ? '<header><button aria-label="Turn off temporary chat">Temporary Chat</button><button aria-label="Personalized">Personalized</button></header>' : unverified ? '<h1>New chat</h1>' : '<h1 data-testid="temporary-chat-header">Temporary Chat</h1>';
  const composerShell = mode === 'submission-ready' ? 'id="fixture-latent-composer"' : dil ? 'id="composer-background"' : `data-testid="${modern ? 'composer-shell' : 'composer'}"`;
  const sendMarkup = mode === 'submission-ready' ? '<button id="fixture-send" aria-label="Preparing Send" disabled>↑</button>' : dil ? '<button id="fixture-send" aria-label="Send" disabled>↑</button>' : '<button id="fixture-send" data-testid="send-button" aria-label="Send prompt" disabled>↑</button>';
  return base + `${header}${['temporary-toggle', 'submission-ready'].includes(mode) ? '<button data-testid="temporary-chat-button" aria-label="Turn on temporary chat" aria-pressed="false">Temporary</button>' : ''}<div id="turns"></div></div></main><div class="native-composer" ${composerShell}><div id="fixture-composer-slot"></div>${sendMarkup}</div></div></div>${mode === 'personalization' ? '<div role="dialog" aria-modal="true" data-testid="temporary-chat-personalization" style="position:fixed;inset:20%;z-index:9999;padding:30px;background:white;color:black;border:1px solid #aaa"><h2>Start a Temporary Chat</h2><p>Choose a Personalized or Unpersonalized Temporary Chat.</p><button id="fixture-personalize">Personalized</button><button id="fixture-not-now">Unpersonalized</button></div>' : ''}<script>
    const fixtureMode=${JSON.stringify(mode)},editorMarkup=${JSON.stringify(editor)};
    window.__sends=0;window.__prompts=[];window.__fixture={mode:fixtureMode,mounts:0,temporaryClicks:0,personalizationClicks:0,draftInputs:0,sendButtonClicks:0};
    let box=null,button=document.getElementById('fixture-send');const isDil=['dil','rich','streaming'].includes(fixtureMode);let streaming=false;
    const sending=()=>{streaming=true;if(!isDil)button.dataset.testid='stop-button';button.setAttribute('aria-label','Stop generating');button.disabled=false;};
    const idle=()=>{streaming=false;if(!isDil)button.dataset.testid='send-button';button.setAttribute('aria-label',isDil?'Send':'Send prompt');button.disabled=true;};
    const read=()=>box instanceof HTMLTextAreaElement?box.value:box?.innerText||'';
    const write=text=>{if(box instanceof HTMLTextAreaElement)box.value=text;else if(box)box.textContent=text;};
    const refresh=()=>{button.disabled=fixtureMode==='send-disabled'||!read().trim();};
    window.__mountComposer=()=>{if(box)return;document.getElementById('fixture-composer-slot').innerHTML=editorMarkup;box=document.querySelector('[data-fixture-editor]');window.__fixture.mounts++;box.addEventListener('input',()=>{window.__fixture.draftInputs++;refresh();});if(fixtureMode==='draft')write('An existing native draft.');refresh();};
    if(fixtureMode==='loading')setTimeout(window.__mountComposer,700);else if(fixtureMode!=='loading-manual')window.__mountComposer();
    document.querySelector('[data-testid="temporary-chat-button"]')?.addEventListener('click',event=>{window.__fixture.temporaryClicks++;if(fixtureMode==='submission-ready')return;event.currentTarget.setAttribute('aria-pressed','true');event.currentTarget.setAttribute('aria-label','Turn off temporary chat');const heading=document.querySelector('main h1');heading.textContent='Temporary Chat';heading.dataset.testid='temporary-chat-header';});
    for(const id of ['fixture-personalize','fixture-not-now'])document.getElementById(id)?.addEventListener('click',()=>{window.__fixture.personalizationClicks++;document.querySelector('[role="dialog"]').remove();});
    let streamTimer;
    const submitNative=event=>{
      if(streaming){clearInterval(streamTimer);idle();return;}
      if(button.disabled)return;
      window.__fixture.sendButtonClicks++;
      if(!event.currentTarget.isConnected)window.__fixture.detachedSendClicks=(window.__fixture.detachedSendClicks||0)+1;
      if(fixtureMode==='no-ack')return;
      const prompt=read().trim();window.__fixture.nativeSentAt=Date.now();window.__sends++;window.__prompts.push(prompt);write('');
      const turns=document.getElementById('turns');let answer,body;
      if(isDil){
        // Reproduce the observed DIL structure: the shared turn contains both
        // roles, and the assistant copy region is narrower than that turn.
        const turn=document.createElement('div');turn.setAttribute('data-talvt-turn-state','completed');
        const pair=document.createElement('div');turn.append(pair);turns.append(turn);
        const user=document.createElement('div'),userHeading=document.createElement('h4'),bubble=document.createElement('div');userHeading.setAttribute('data-conversation-role','user');userHeading.textContent='You said:';bubble.className='user';bubble.textContent=prompt;user.append(userHeading,bubble);pair.append(user);
        answer=document.createElement('div');answer.setAttribute('data-content-search-unit-key','fixture-unit-'+window.__sends);answer.setAttribute('data-chatgpt-search-unit-key','fixture-unit-'+window.__sends);answer.setAttribute('data-chatgpt-search-message-ids','fixture-answer-'+window.__sends);
        const heading=document.createElement('h4');heading.setAttribute('data-conversation-role','assistant');heading.textContent='ChatGPT said:';answer.append(heading);
        const inner=document.createElement('div'),selection=document.createElement('div'),overlay=document.createElement('div'),copy=document.createElement('div'),message=document.createElement('div');
        selection.setAttribute('data-chatgpt-selection-conversation-id','fixture-conversation');selection.setAttribute('data-chatgpt-selection-message-id','fixture-answer-'+window.__sends);
        overlay.setAttribute('data-selected-text-overlay-target','');overlay.setAttribute('data-markdown-text-style','');
        copy.setAttribute('data-dil-source-message-id','fixture-answer-'+window.__sends);copy.setAttribute('data-chatgpt-copy-reference','fixture-answer-'+window.__sends);copy.setAttribute('data-markdown-copy','');
        message.setAttribute('data-dil-message-id','fixture-answer-'+window.__sends);body=document.createElement('p');body.setAttribute('data-d-text-flow','');body.setAttribute('data-d-component','');
        message.append(body);copy.append(message);overlay.append(copy);selection.append(overlay);inner.append(selection);answer.append(inner);pair.append(answer);
      }else{
        const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.className='user';user.textContent=prompt;turns.append(user);
      }
      if(fixtureMode==='no-answer'){button.disabled=true;return;}
      if(!isDil){answer=document.createElement('article');answer.dataset.messageAuthorRole='assistant';body=document.createElement('div');body.className='markdown';answer.append(body);turns.append(answer);}
      sending();
      if(fixtureMode==='streaming'){
        // Event-paced by the Node driver, not by a hidden-page interval. Start
        // with only a bounded assistant role: copy/search enrichment comes later.
        for(const name of ['data-content-search-unit-key','data-chatgpt-search-unit-key','data-chatgpt-search-message-ids'])answer.removeAttribute(name);
        for(const element of answer.querySelectorAll('*'))for(const attr of [...element.attributes])if(/^data-(?:dil|chatgpt|markdown|selected)/.test(attr.name))element.removeAttribute(attr.name);
        answer.id='stream-answer-'+window.__sends;body.id='stream-body-'+window.__sends;
        window.__fixture.streamReady=true;window.__fixture.streamFinished=false;
        window.__finishStream=()=>{window.__fixture.streamFinished=true;idle();};
        return;
      }
      if(fixtureMode==='rich'){
        body.textContent='A class is a blueprint; each account is a specific instance.';
        const addSource=()=>{const selection=document.createElement('div'),copy=document.createElement('div');selection.setAttribute('data-chatgpt-selection-conversation-id','fixture-conversation');selection.setAttribute('data-chatgpt-selection-message-id','fixture-answer-'+window.__sends);copy.setAttribute('data-dil-source-message-id','fixture-answer-'+window.__sends);copy.setAttribute('data-chatgpt-copy-reference','fixture-answer-'+window.__sends);copy.setAttribute('data-markdown-copy','');selection.append(copy);answer.append(selection);return copy;};
        setTimeout(()=>{
          const codeSource=addSource(),codePanel=document.createElement('div');
          const label=document.createElement('div');label.textContent='Python';codePanel.append(label);
          for(const text of ['Copy','Run']){const control=document.createElement('button');control.textContent=text;codePanel.append(control);}
          const editor=document.createElement('div');editor.className='cm-editor';const content=document.createElement('div');content.className='cm-content';
          const codeLines=['class BankAccount:','    interest_rate = 5','','    def __init__(self, balance):','        self.balance = balance','','a = BankAccount(1000)'];
          for(const text of codeLines){const line=document.createElement('div');line.className='cm-line';if(text)line.textContent=text;else line.append(document.createElement('br'));content.append(line);}
          editor.append(content);codePanel.append(editor);codeSource.append(codePanel);window.__fixture.expectedCode=codeLines.join(String.fromCharCode(10));
          const middle=addSource();middle.innerHTML='<h3>Two separate accounts</h3><p>Text before the visual.</p><div data-fixture-widget><svg role="img" aria-label="Account relationship diagram" viewBox="0 0 100 30"><text x="0" y="20">Account a to BankAccount</text></svg><canvas width="20" height="20"></canvas></div><p>Text after the visual must remain in the answer.</p><ul><li><code>self</code> identifies one account.</li><li><code>cls</code> identifies the class.</li></ul><table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody><tr><td>a</td><td>1000</td></tr></tbody></table>';
          const final=addSource(),last=document.createElement('p');last.id='rich-conclusion';last.textContent='Final explanation after every code block and visual.';final.append(last);
          // Keep generation active until the test has observed the stream.
          // The final pass changes formatting but not the answer text.
          window.__finishRich=()=>{const em=document.createElement('em');em.textContent=last.textContent;last.replaceChildren(em);window.__fixture.richFinished=true;idle();};
          window.__fixture.richReady=true;
        },250);
        return;
      }
      const text=window.__sends===1?'Think of a query as a question and a key as a label. Attention compares them to decide which values are most useful.':'For example, the query for “it” can match the key for “animal,” helping connect the pronoun to what it describes.';
      let n=0;streamTimer=setInterval(()=>{n+=24;body.textContent=text.slice(0,n);if(n>=text.length){clearInterval(streamTimer);if(!isDil){body.replaceChildren();const p=document.createElement('p');p.textContent=text;body.append(p);}const strong=document.createElement('strong');strong.textContent='Your main conversation stays untouched.';body.append(strong);const bad=document.createElement('a');bad.href='javascript:window.__unsafe=true';bad.textContent='Unsafe link test';body.append(bad);idle();}},90);
    };button.addEventListener('click',submitNative);
    // Test-only SPA replacement during the extension's durable pre-send ACK.
    // Preserve the exact draft and enabled state; only element identities change.
    window.__remountSubmission=()=>{const draft=read(),nextBox=box.cloneNode(true),nextButton=button.cloneNode(true);box.replaceWith(nextBox);box=nextBox;write(draft);box.addEventListener('input',()=>{window.__fixture.draftInputs++;refresh();});button.replaceWith(nextButton);button=nextButton;button.addEventListener('click',submitNative);window.__fixture.submissionRemounts=(window.__fixture.submissionRemounts||0)+1;};
  </script></body></html>`;
};
