/* Measured, reversible space for the panel. No changes to ChatGPT's content. */
(function (root) {
  'use strict';
  const WIDTH = 344, DOCK = 152, EDGE = 16, GAP = 16, MIN_READING = 430;
  const MEDIA = 'img,video,canvas,iframe,table,pre,svg';
  const COMPOSER = '.native-composer,#composer-background,[data-testid="composer"],[data-testid="composer-container"],form[data-type="unified-composer"]';
  const EDITOR = '#prompt-textarea,[data-testid="composer-text-input"],textarea';
  const OWN_CLASS = 'tmp-chat-reserve-space';
  const PROPERTIES = ['width', 'max-width', 'min-width', 'box-sizing', 'margin-inline-end', 'flex-grow', 'flex-shrink', 'flex-basis'];

  function create({ host, onChange = () => {} }) {
    let active = false, destroyed = false, lastOptions = {}, current = null;
    let main = null, shell = null, composer = null, reservation = null;
    let frame = null, timer = null, lastRun = 0, dirty = true, incomplete = false, candidates = [], media = [];
    let observed = [], ownStyle = null, ownClass = null;
    let clipCache = new WeakMap();
    const viewportWidth = () => document.documentElement.clientWidth || innerWidth;
    const viewportHeight = () => document.documentElement.clientHeight || innerHeight;
    const number = value => Number.parseFloat(value) || 0;
    const isOwn = node => node === host || host.contains(node) || node?.id === 'tmp-chat-layout-style' || node?.classList?.contains('tmp-chat-selection');

    function restore() {
      if (!reservation) return;
      const saved = reservation;
      reservation = null;
      for (const [property, value, priority, written] of saved.properties) {
        // Preserve unrelated changes made by the site while the panel was open.
        if (saved.node.style.getPropertyValue(property) !== written) continue;
        if (value) saved.node.style.setProperty(property, value, priority);
        else saved.node.style.removeProperty(property);
      }
      if (!saved.hadClass) saved.node.classList.remove(OWN_CLASS);
      if (saved.originalStyle === null && !saved.node.style.length) saved.node.removeAttribute('style');
      if (saved.originalClass === null && !saved.node.classList.length) saved.node.removeAttribute('class');
      ownStyle = saved.node.getAttribute('style');
      ownClass = saved.node.getAttribute('class');
    }

    function findPage() {
      const nextMain = [...document.querySelectorAll('main')].find(node => node.getBoundingClientRect().width > 100) || null;
      const editor = document.querySelector(EDITOR);
      const nextComposer = editor?.closest(COMPOSER) || document.querySelector(COMPOSER) || editor?.closest('form') || editor?.parentElement || null;
      let nextShell = nextMain;
      if (nextComposer && nextMain && !nextMain.contains(nextComposer)) {
        let ancestor = nextMain.parentElement;
        while (ancestor && !ancestor.contains(nextComposer)) ancestor = ancestor.parentElement;
        if (ancestor && ancestor !== document.body && ancestor !== document.documentElement) nextShell = ancestor;
      }
      if (nextMain !== main || nextShell !== shell || nextComposer !== composer) {
        restore();
        main = nextMain; shell = nextShell; composer = nextComposer;
        dirty = true;
      }
    }

    function rebuild() {
      dirty = false; incomplete = false; candidates = []; media = []; clipCache = new WeakMap();
      if (!main) return;
      // Text ranges measure painted lines rather than a full-width article box.
      // Media is collected across main, including siblings outside .markdown.
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!node.textContent.trim() || !parent || parent.closest('button,[role="button"],nav,script,style,textarea,[contenteditable="true"],pre,table,svg')) continue;
        if (composer?.contains(parent) || isOwn(parent)) continue;
        // Keep work bounded without ever treating an omitted later answer as
        // empty whitespace. Very large DOMs retain the safe, unreserved dock.
        if (candidates.length >= 4000) { incomplete = true; break; }
        candidates.push(node);
      }
      media = [...main.querySelectorAll(MEDIA)].filter(node => !node.closest('button,[role="button"],nav') && !composer?.contains(node) && !isOwn(node));
    }

    function clippers(element) {
      if (clipCache.has(element)) return clipCache.get(element);
      const result = [];
      for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const x = /auto|scroll|hidden|clip/.test(style.overflowX);
        const y = /auto|scroll|hidden|clip/.test(style.overflowY);
        if (x || y) result.push({ node: parent, x, y });
      }
      clipCache.set(element, result);
      return result;
    }

    function visibleRect(rect, element, width, height) {
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) return null;
      let left = Math.max(0, rect.left), right = Math.min(width, rect.right);
      let top = Math.max(0, rect.top), bottom = Math.min(height, rect.bottom);
      for (const clip of clippers(element)) {
        const bounds = clip.node.getBoundingClientRect();
        if (clip.x) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (clip.y) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      return right > left && bottom > top ? { left, right, top, bottom } : null;
    }

    function measure() {
      if (dirty) rebuild();
      const width = viewportWidth(), height = viewportHeight(), rects = [];
      const range = document.createRange();
      for (const node of candidates) {
        const parent = node.parentElement;
        if (!node.isConnected || !parent) { dirty = true; continue; }
        const bounds = parent.getBoundingClientRect();
        if (bounds.bottom <= 0 || bounds.top >= height || !bounds.width || !bounds.height) continue;
        const style = getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          const rect = visibleRect(line, parent, width, height);
          if (rect) rects.push(rect);
        }
      }
      for (const node of [...media, ...(composer ? [composer] : [])]) {
        if (!node.isConnected || getComputedStyle(node).visibility === 'hidden') continue;
        const rect = visibleRect(node.getBoundingClientRect(), node, width, height);
        if (rect) rects.push(rect);
      }
      return { rects, incomplete, right: rects.reduce((right, rect) => Math.max(right, rect.right), 0) };
    }

    function reserve(baseWidth, pixels, originalMargin) {
      restore();
      const width = Math.floor(baseWidth - pixels);
      const row = shell.parentElement && /flex/.test(getComputedStyle(shell.parentElement).display) && !/column/.test(getComputedStyle(shell.parentElement).flexDirection);
      const values = {
        width: `${width}px`, 'max-width': `${width}px`, 'min-width': `${MIN_READING}px`,
        'box-sizing': 'border-box', 'margin-inline-end': `${originalMargin + pixels}px`
      };
      if (row) Object.assign(values, { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': `${width}px` });
      const properties = PROPERTIES.filter(property => property in values).map(property => [property, shell.style.getPropertyValue(property), shell.style.getPropertyPriority(property), values[property]]);
      reservation = { node: shell, properties, hadClass: shell.classList.contains(OWN_CLASS), originalStyle: shell.getAttribute('style'), originalClass: shell.getAttribute('class'), pixels };
      for (const [property, , , value] of properties) shell.style.setProperty(property, value, 'important');
      shell.classList.add(OWN_CLASS);
      ownStyle = shell.getAttribute('style'); ownClass = shell.getAttribute('class');
    }

    function dockTop(rects, width, height) {
      const left = width - EDGE - DOCK;
      const obstacles = rects.filter(rect => rect.right > left - 8 && rect.left < width - EDGE);
      const clear = top => top >= 8 && top + 46 <= height - 8 && obstacles.every(rect => rect.bottom <= top - 8 || rect.top >= top + 54);
      const choices = [104, 64, 12, ...obstacles.map(rect => Math.ceil(rect.bottom + 8))];
      return choices.find(clear) ?? 64;
    }

    function updateObservers() {
      if (!resizeObserver) return;
      const next = [...new Set([main, shell, shell?.parentElement, composer, ...media.slice(0, 64)].filter(Boolean))];
      if (next.length === observed.length && next.every((node, index) => node === observed[index])) return;
      resizeObserver.disconnect(); observed = next;
      for (const node of observed) resizeObserver.observe(node);
    }

    function run() {
      if (!active || destroyed) return current;
      lastRun = performance.now();
      findPage(); restore();
      const width = viewportWidth(), height = viewportHeight();
      // An ancestor's overflow styles can change during a route/sidebar change.
      clipCache = new WeakMap();
      const natural = measure();
      const minimized = !!lastOptions.minimized;
      const baseRect = shell?.getBoundingClientRect();
      let compact = false, reason = '', reserved = 0;
      if (!minimized) {
        const limit = width - EDGE - WIDTH - GAP;
        const baseWidth = baseRect?.width || 0;
        const maxReserve = Math.max(0, Math.floor(baseWidth - MIN_READING));
        if (natural.incomplete) { compact = true; reason = 'This conversation is too large to safely measure. Open tmp.chat in a shorter conversation.'; }
        else if (!main || !shell || !natural.rects.length) { compact = true; reason = 'Waiting for the conversation layout.'; }
        else if (width - baseRect.left < WIDTH + GAP + EDGE + MIN_READING) { compact = true; reason = 'Widen the browser to keep both conversations readable.'; }
        else if (natural.right > limit + 1) {
          const baselineOverflow = Math.max(width, document.documentElement.scrollWidth);
          const baselineInner = [...new Set([main, shell])].map(node => [node, Math.max(0, node.scrollWidth - node.clientWidth)]);
          const margin = number(getComputedStyle(shell).marginInlineEnd);
          let previousRight = natural.right, previousReserve = 0;
          reserved = Math.min(maxReserve, Math.max(1, Math.ceil(natural.right - limit)));
          let fits = false;
          for (let attempt = 0; reserved > 0 && attempt < 4; attempt++) {
            reserve(baseWidth, reserved, margin);
            const placed = measure();
            const actual = shell.getBoundingClientRect();
            const overflow = document.documentElement.scrollWidth > baselineOverflow + 1 || baselineInner.some(([node, amount]) => node.scrollWidth - node.clientWidth > amount + 1);
            if (!overflow && actual.width >= MIN_READING - 1 && placed.right <= limit + 1) { fits = true; break; }
            const moved = previousRight - placed.right;
            const slope = moved / Math.max(1, reserved - previousReserve);
            if (overflow || actual.width < MIN_READING - 1 || slope < .05 || reserved >= maxReserve) break;
            const additional = Math.max(1, Math.ceil((placed.right - limit + 1) / Math.min(1, slope)));
            previousRight = placed.right; previousReserve = reserved;
            reserved = Math.min(maxReserve, reserved + additional);
          }
          if (!fits) { restore(); reserved = 0; compact = true; reason = 'Widen the browser to open tmp.chat without covering the conversation.'; }
        }
      }
      if (minimized || compact) { restore(); reserved = 0; }
      const panelHeight = Math.min(610, Math.max(280, height - 136));
      const top = minimized || compact ? dockTop(natural.rects, width, height) : Math.max(64, Math.min(lastOptions.anchorTop || 104, height - panelHeight - 24));
      current = { compact, minimized, width: minimized || compact ? DOCK : WIDTH, top, reason, reserved };
      updateObservers();
      onChange({ ...current });
      return current;
    }

    function schedule() {
      if (!active || destroyed || frame !== null || timer !== null) return;
      const delay = Math.max(0, 100 - (performance.now() - lastRun));
      const queue = () => { timer = null; frame = requestAnimationFrame(() => { frame = null; run(); }); };
      if (delay) timer = setTimeout(queue, delay); else queue();
    }

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const mutationObserver = new MutationObserver(records => {
      if (!active) return;
      let relevant = false;
      for (const record of records) {
        const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!node || isOwn(node)) continue;
        if (record.type === 'attributes' && node === shell && ((record.attributeName === 'style' && node.getAttribute('style') === ownStyle) || (record.attributeName === 'class' && node.getAttribute('class') === ownClass))) continue;
        if (record.type === 'childList') {
          if ([...record.addedNodes, ...record.removedNodes].every(isOwn)) continue;
          dirty = true;
        }
        if (record.type !== 'characterData' || main?.contains(node)) relevant = true;
      }
      if (relevant) schedule();
    });
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'src', 'width', 'height'] });
    const resized = () => { dirty = true; schedule(); };
    const loaded = event => { if (main?.contains(event.target)) { dirty = true; schedule(); } };
    window.addEventListener('resize', resized, { passive: true });
    document.addEventListener('load', loaded, true);
    document.addEventListener('scroll', schedule, { passive: true, capture: true });

    function release() {
      active = false; dirty = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = null; timer = null;
      restore(); resizeObserver?.disconnect(); observed = [];
    }

    return {
      place(options = {}) { lastOptions = { ...options }; active = true; return run(); },
      schedule,
      release,
      getState() { return current ? { ...current } : null; },
      destroy() {
        release(); destroyed = true; mutationObserver.disconnect();
        window.removeEventListener('resize', resized);
        document.removeEventListener('load', loaded, true);
        document.removeEventListener('scroll', schedule, true);
      }
    };
  }

  const api = Object.freeze({ create });
  root.TmpLayout = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
