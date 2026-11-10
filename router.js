// One page per function, addressed by hash: #/ (landing), #/import, #/items, #/time, #/calendar.
// Old links #/review and #/plan open their replacements.
// The current page is html[data-current]; CSS shows only that page, so back/forward and reload all work.
(() => {
  const root = document.documentElement;
  const titles = { home: '司序 Marshal · 知所先后', time: '铺纸 · 司序', import: '研墨 · 司序', items: '笔墨 · 司序', calendar: '画卷 · 司序' };
  const aliases = { review: 'items', plan: 'calendar' };
  const routeOf = hash => {
    if (!hash.startsWith('#/')) return hash && root.dataset.current ? root.dataset.current : 'home';
    // #/import?text=… (from an iPhone shortcut) and #/import?shared=1 (from the share sheet) open 研墨.
    const raw = hash.slice(2).split('?')[0];
    const name = aliases[raw] || raw;
    return Object.hasOwn(titles, name) && name ? name : 'home';
  };

  const veil = document.getElementById('routeVeil');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let pointer = null;
  let ready = false;
  document.addEventListener('pointerdown', event => { pointer = [event.clientX, event.clientY]; }, true);

  // 墨韵: three ink washes bloom from the click, deep blue, sky blue, then paper white, and the
  // white settles into the workbench. The ragged blot is drawn once on a canvas and used as a mask,
  // so the animation itself is only a transform. Fixed seeds keep every bloom the same.
  let blots = null;
  function blot(seed) {
    const size = 384;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return '';
    let state = seed;
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    // Rounded lobes, a few mid ripples and a fine fringe: ink bleeding into paper, not a starburst.
    const waves = [
      ...[3, 4, 5, 7].map(k => ({ k, amp: 0.035 + random() * 0.025 })),
      ...[9, 11, 13, 17, 19].map(k => ({ k, amp: 0.008 + random() * 0.008 })),
      ...[29, 37, 43, 53, 61, 71].map(k => ({ k, amp: 0.002 + random() * 0.003 })),
    ].map(wave => ({ ...wave, phase: random() * Math.PI * 2 }));
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x / size * 2 - 1;
        const dy = y / size * 2 - 1;
        const radius = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        let edge = 0.62;
        for (const wave of waves) edge += wave.amp * Math.sin(wave.k * angle + wave.phase);
        // Feathered, fibrous rim: the outer band thins out like ink soaking into paper.
        const t = (edge - radius) / 0.11;
        const fibre = 0.5 + 0.5 * Math.sin(angle * 151 + radius * 70 + waves[0].phase) * Math.sin(angle * 37 + waves[1].phase);
        const alpha = t >= 1 ? 1 : t <= 0 ? 0 : Math.pow(t, 1.4) * (0.7 + 0.3 * fibre);
        image.data[(y * size + x) * 4 + 3] = Math.round(alpha * 255);
      }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Three uses of the same veil, all on timers rather than animationend so the page switches even if
  // an animation never runs; each run invalidates the timers of the one before it.
  //   playVeil   landing -> workbench: ink blooms from the click, then melts onto the workbench.
  //   playIntro  opening the site: ink blooms from the centre over paper, the mark and name appear,
  //              then it melts onto the landing. Returns a skip function (click, key or wheel).
  //   playRecede workbench -> landing: the veil gathers, then the washes shrink back into the click
  //              in reverse order, white first, deep blue last.
  let run = 0;
  function prepare(at) {
    if (!blots) {
      blots = [blot(7), blot(23), blot(51)];
      veil.querySelectorAll('.ink').forEach((ink, index) => { if (blots[index]) ink.style.setProperty('--blot', `url("${blots[index]}")`); });
    }
    veil.style.setProperty('--x', at ? `${at[0]}px` : '50%');
    veil.style.setProperty('--y', at ? `${at[1]}px` : '50%');
    return ++run;
  }
  const later = (ticket, ms, step) => window.setTimeout(() => { if (ticket === run) step(); }, ms);
  function playVeil(done) {
    const ticket = prepare(pointer);
    veil.className = 'route-veil is-on';
    later(ticket, 700, done);
    later(ticket, 1250, () => { veil.className = 'route-veil is-on is-out'; });
    later(ticket, 1850, () => { veil.className = 'route-veil'; });
  }
  function playIntro(done) {
    const ticket = prepare(null);
    let finished = false;
    const melt = () => {
      if (finished || ticket !== run) return;
      finished = true;
      veil.className = 'route-veil is-on is-intro is-out';
      done();
      later(ticket, 650, () => { veil.className = 'route-veil'; });
    };
    veil.className = 'route-veil is-on is-intro';
    later(ticket, 1900, melt);
    return melt;
  }
  function playRecede(done) {
    const ticket = prepare(pointer);
    veil.className = 'route-veil is-back';
    later(ticket, 270, done);
    later(ticket, 300, () => { veil.className = 'route-veil is-back is-recede'; });
    later(ticket, 1020, () => { veil.className = 'route-veil'; });
  }
  window.SixuVeil = { intro: done => (veil && !calm.matches ? playIntro(done) : (done(), () => {})) };

  // The four workbench pages in painting order; arrows and the arrow keys step through them.
  const ORDER = ['time', 'import', 'items', 'calendar'];
  const NAMES = { time: '铺纸', import: '研墨', items: '笔墨', calendar: '画卷' };

  // A link click fires both hashchange and popstate; the veil already on its way absorbs the second.
  let pending = null;
  let turn = 0;
  function apply(route, options = {}) {
    if (pending === route) return;
    const from = root.dataset.current;
    if (ready && veil && !calm.matches && from === 'home' && route !== 'home') {
      pending = route;
      playVeil(() => { pending = null; show(route, options); });
    } else if (ready && veil && !calm.matches && ORDER.includes(from) && route === 'home') {
      pending = route;
      playRecede(() => { pending = null; show(route, options); });
    } else if (ready && !calm.matches && from !== route && ORDER.includes(from) && ORDER.includes(route) && document.startViewTransition) {
      // 下一页: the page leaves to the left and the next comes in from the right; 上一页 mirrors it.
      // Only the latest turn may clear the direction, so a quick second turn keeps its own.
      const ticket = ++turn;
      root.dataset.dir = ORDER.indexOf(route) > ORDER.indexOf(from) ? 'next' : 'prev';
      const transition = document.startViewTransition(() => show(route, options));
      transition.ready.catch(() => { /* a skipped transition (a newer route won) is not an error */ });
      transition.finished.finally(() => { if (ticket === turn) delete root.dataset.dir; });
    } else show(route, options);
    ready = true;
  }

  function updateArrows(route) {
    const index = ORDER.indexOf(route);
    for (const button of document.querySelectorAll('[data-page-step]')) {
      const target = index < 0 ? null : ORDER[index + Number(button.dataset.pageStep)];
      button.hidden = !target;
      if (!target) continue;
      button.dataset.target = target;
      button.querySelector('.page-arrow-label').textContent = NAMES[target];
      button.setAttribute('aria-label', `${Number(button.dataset.pageStep) < 0 ? '上一页' : '下一页'}：${NAMES[target]}`);
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-page-step]');
    if (button?.dataset.target) window.SixuRouter.go(button.dataset.target);
  });
  document.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
    const index = ORDER.indexOf(root.dataset.current);
    const next = index < 0 ? null : ORDER[index + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    window.SixuRouter.go(next);
  });

  function show(route, { focus = false } = {}) {
    const changed = root.dataset.current !== route;
    root.dataset.current = route;
    document.title = titles[route];
    updateArrows(route);
    for (const tab of document.querySelectorAll('[data-tab]')) {
      // On phones the tab strip scrolls sideways; bring the current tab into it.
      if (tab.dataset.tab === route) { tab.setAttribute('aria-current', 'page'); tab.parentElement.scrollLeft = Math.max(0, tab.offsetLeft - (tab.parentElement.clientWidth - tab.offsetWidth) / 2); }
      else tab.removeAttribute('aria-current');
    }
    if (!changed) return;
    window.scrollTo(0, 0);
    if (focus) {
      const heading = document.querySelector(`[data-page="${route}"] h1, [data-page="${route}"] h2`);
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    document.dispatchEvent(new CustomEvent('sixu:route', { detail: route }));
  }

  window.SixuRouter = {
    go(route) {
      if (routeOf(location.hash) !== route) history.pushState(null, '', route === 'home' ? location.pathname + location.search : `#/${route}`);
      apply(route, { focus: true });
    },
    current: () => root.dataset.current,
  };
  window.addEventListener('hashchange', () => apply(routeOf(location.hash), { focus: true }));
  window.addEventListener('popstate', () => apply(routeOf(location.hash), { focus: true }));
  apply(routeOf(location.hash));
})();
