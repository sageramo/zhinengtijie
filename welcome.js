// Welcome screen: a slow starfield where the Big Dipper lights up star by star, then the compass needle settles on north.
// Shown once per browser session; the brand link (#welcome) brings it back. Reduced motion draws one still frame.
(() => {
  const root = document.documentElement;
  const welcome = document.getElementById('welcome');
  const canvas = document.getElementById('welcomeSky');
  if (!welcome || !canvas) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let frame = 0;
  let started = 0;
  let width = 0;
  let height = 0;
  const behind = [document.querySelector('.site-header'), document.querySelector('main')].filter(Boolean);
  const setInert = value => { for (const node of behind) node.inert = value; };

  // Big Dipper, bowl first then handle; coordinates relative to the dial centre, in dial radii.
  const dipper = [[1.75, -1.25], [2.22, -1.48], [2.48, -1.12], [2.02, -0.9], [2.85, -0.72], [3.32, -0.62], [3.7, -0.32]];
  const links = [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 5], [5, 6]];

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = welcome.clientWidth;
    height = welcome.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(260, (width * height) / 5200));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.1 + 0.25,
      base: Math.random() * 0.5 + 0.2,
      phase: Math.random() * Math.PI * 2,
      drift: Math.random() * 0.012 + 0.004,
    }));
  }

  function anchor() {
    const dial = document.getElementById('enterWorkbench').getBoundingClientRect();
    const box = welcome.getBoundingClientRect();
    const unit = Math.max(70, Math.min(dial.width * 0.5, width / 7));
    return { cx: dial.left - box.left + dial.width / 2, cy: dial.top - box.top + dial.height / 2, unit };
  }

  function draw(time) {
    const t = calm.matches ? 99999 : time - started;
    ctx.clearRect(0, 0, width, height);
    for (const star of stars) {
      const x = calm.matches ? star.x : (star.x + t * star.drift) % width;
      const glow = calm.matches ? star.base : star.base + Math.sin(t / 900 + star.phase) * 0.18;
      ctx.globalAlpha = Math.max(0.05, glow);
      ctx.fillStyle = '#e8eef0';
      ctx.beginPath();
      ctx.arc(x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const { cx, cy, unit } = anchor();
    // Narrow screens have no room beside the dial: the Dipper moves into the empty band above the title.
    const points = width < 640
      ? dipper.map(([dx, dy]) => [width * (0.2 + ((dx - 1.75) / 1.95) * 0.62), height * (0.07 + ((dy + 1.48) / 1.16) * 0.11)])
      : dipper.map(([dx, dy]) => [cx + dx * unit, cy + dy * unit]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#e7c77d';
    links.forEach(([a, b], index) => {
      const p = Math.min(1, Math.max(0, (t - 1100 - index * 160) / 420));
      if (!p) return;
      ctx.globalAlpha = 0.45 * p;
      ctx.beginPath();
      ctx.moveTo(points[a][0], points[a][1]);
      ctx.lineTo(points[a][0] + (points[b][0] - points[a][0]) * p, points[a][1] + (points[b][1] - points[a][1]) * p);
      ctx.stroke();
    });
    points.forEach(([x, y], index) => {
      const p = Math.min(1, Math.max(0, (t - 200 - index * 140) / 380));
      if (!p) return;
      ctx.globalAlpha = p;
      ctx.fillStyle = '#e7c77d';
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.18 * p;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (!calm.matches && !welcome.hidden && !document.hidden) frame = requestAnimationFrame(draw);
  }

  function start() {
    cancelAnimationFrame(frame);
    resize();
    started = performance.now();
    welcome.classList.add('is-playing');
    setInert(true);
    frame = requestAnimationFrame(draw);
  }

  function enter({ focus = true } = {}) {
    try { sessionStorage.setItem('sixu-entered', '1'); } catch { /* Storage blocked: welcome shows again next visit. */ }
    cancelAnimationFrame(frame);
    const finish = () => {
      root.dataset.entered = '1';
      setInert(false);
      welcome.classList.remove('is-leaving');
      if (location.hash === '#welcome') history.replaceState(null, '', location.pathname + location.search);
      if (focus) document.getElementById('workbenchHeading')?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
    if (calm.matches) return finish();
    welcome.classList.add('is-leaving');
    window.setTimeout(finish, 420);
  }

  function show() {
    delete root.dataset.entered;
    window.scrollTo(0, 0);
    start();
    document.getElementById('enterWorkbench').focus({ preventScroll: true });
  }

  document.getElementById('enterWorkbench').addEventListener('click', () => enter());
  document.querySelector('.skip-link')?.addEventListener('click', () => { if (!root.dataset.entered) enter({ focus: false }); });
  window.addEventListener('hashchange', () => { if (location.hash === '#welcome') show(); });
  window.addEventListener('resize', () => { if (!root.dataset.entered) { resize(); if (calm.matches) draw(0); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !root.dataset.entered && !calm.matches) frame = requestAnimationFrame(draw); });
  calm.addEventListener?.('change', () => { if (!root.dataset.entered) start(); });
  if (!root.dataset.entered) start();
})();
