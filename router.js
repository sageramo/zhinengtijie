// One page per function, addressed by hash: #/ (landing), #/import, #/review, #/time, #/plan.
// The current page is html[data-current]; CSS shows only that page, so back/forward and reload all work.
(() => {
  const root = document.documentElement;
  const titles = { home: '司序·知所先后', import: '导入通知 · 司序', review: '核对事项 · 司序', time: '空闲时间 · 司序', plan: '生成安排 · 司序' };
  const routeOf = hash => {
    if (!hash.startsWith('#/')) return hash && root.dataset.current ? root.dataset.current : 'home';
    const name = hash.slice(2);
    return Object.hasOwn(titles, name) && name ? name : 'home';
  };

  function apply(route, { focus = false } = {}) {
    const changed = root.dataset.current !== route;
    root.dataset.current = route;
    document.title = titles[route];
    for (const tab of document.querySelectorAll('[data-tab]')) {
      if (tab.dataset.tab === route) tab.setAttribute('aria-current', 'page');
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
