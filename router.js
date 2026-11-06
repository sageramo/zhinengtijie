// One page per function, addressed by hash: #/ (landing), #/import, #/items, #/time, #/calendar.
// Old links #/review and #/plan open their replacements.
// The current page is html[data-current]; CSS shows only that page, so back/forward and reload all work.
(() => {
  const root = document.documentElement;
  const titles = { home: '司序·知所先后', import: '导入 · 司序', items: '事项 · 司序', time: '时间 · 司序', calendar: '日历 · 司序' };
  const aliases = { review: 'items', plan: 'calendar' };
  const routeOf = hash => {
    if (!hash.startsWith('#/')) return hash && root.dataset.current ? root.dataset.current : 'home';
    const name = aliases[hash.slice(2)] || hash.slice(2);
    return Object.hasOwn(titles, name) && name ? name : 'home';
  };

  const veil = document.getElementById('routeVeil');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let pointer = null;
  let ready = false;
  document.addEventListener('pointerdown', event => { pointer = [event.clientX, event.clientY]; }, true);

  // Timers rather than animationend: the page must switch even if the veil's animation never runs.
  function playVeil(done) {
    veil.style.setProperty('--x', pointer ? `${pointer[0]}px` : '50%');
    veil.style.setProperty('--y', pointer ? `${pointer[1]}px` : '50%');
    veil.className = 'route-veil is-on';
    window.setTimeout(done, 450);
    window.setTimeout(() => { veil.className = 'route-veil is-on is-out'; }, 1000);
    window.setTimeout(() => { veil.className = 'route-veil'; }, 1540);
  }

  // A link click fires both hashchange and popstate; the veil already on its way absorbs the second.
  let pending = null;
  function apply(route, options = {}) {
    if (pending === route) return;
    if (ready && veil && !calm.matches && root.dataset.current === 'home' && route !== 'home') {
      pending = route;
      playVeil(() => { pending = null; show(route, options); });
    } else show(route, options);
    ready = true;
  }

  function show(route, { focus = false } = {}) {
    const changed = root.dataset.current !== route;
    root.dataset.current = route;
    document.title = titles[route];
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
