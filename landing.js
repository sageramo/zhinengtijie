// Landing page motion: a slow starfield with the Big Dipper behind the hero, words that pull up into
// place once, and an about paragraph whose characters brighten as it scrolls through. Reduced motion
// draws one still frame and shows all text at full strength.
(() => {
  const root = document.documentElement;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The light tunnel (light-tunnel.js) is the hero's background; the starfield is the fallback
  // for browsers without WebGL2.
  const tunnelBox = document.getElementById('heroTunnel');
  const tunnel = window.SixuLightTunnel && tunnelBox ? window.SixuLightTunnel(tunnelBox, {
    cableColor: '#eef3f2', pulseColor: '#e7c77d', tunnelColor: '#2f6f73', tunnelOpacity: 0.3,
    cableCount: 56, pulseDensity: 0.5, flowDirection: 'inward', centerX: 0.22, centerY: 0.12,
    brightness: 0.9, mouseInteraction: true, clickSurge: true,
  }) : null;
  const canvas = document.getElementById('heroSky');
  if (tunnel) canvas.hidden = true;
  const ctx = tunnel ? null : canvas?.getContext('2d');
  let stars = [];
  let frame = 0;
  let started = 0;
  let width = 0;
  let height = 0;
  const dipper = [[0.6, 0.2], [0.66, 0.15], [0.7, 0.23], [0.64, 0.28], [0.76, 0.32], [0.82, 0.35], [0.88, 0.43]];
  const links = [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 5], [5, 6]];

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(280, (width * height) / 4800));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * width, y: Math.random() * height, r: Math.random() * 1.1 + 0.25,
      base: Math.random() * 0.5 + 0.2, phase: Math.random() * Math.PI * 2, drift: Math.random() * 0.012 + 0.004,
    }));
  }

  function draw(time) {
    const t = calm.matches ? 99999 : time - started;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#e8eef0';
    for (const star of stars) {
      ctx.globalAlpha = Math.max(0.05, calm.matches ? star.base : star.base + Math.sin(t / 900 + star.phase) * 0.18);
      ctx.beginPath();
      ctx.arc(calm.matches ? star.x : (star.x + t * star.drift) % width, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const narrow = width < 640;
    const points = dipper.map(([x, y]) => [width * (narrow ? x * 0.9 + 0.05 : x), height * (narrow ? y * 0.6 + 0.04 : y)]);
    ctx.strokeStyle = '#e7c77d';
    ctx.lineWidth = 1;
    links.forEach(([a, b], index) => {
      const p = Math.min(1, Math.max(0, (t - 1100 - index * 160) / 420));
      if (!p) return;
      ctx.globalAlpha = 0.45 * p;
      ctx.beginPath();
      ctx.moveTo(...points[a]);
      ctx.lineTo(points[a][0] + (points[b][0] - points[a][0]) * p, points[a][1] + (points[b][1] - points[a][1]) * p);
      ctx.stroke();
    });
    ctx.fillStyle = '#e7c77d';
    points.forEach(([x, y], index) => {
      const p = Math.min(1, Math.max(0, (t - 200 - index * 140) / 380));
      if (!p) return;
      ctx.globalAlpha = p;
      ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.18 * p;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (!calm.matches && root.dataset.current === 'home' && !document.hidden) frame = requestAnimationFrame(draw);
  }

  function startSky() {
    if (!ctx || root.dataset.current !== 'home') return;
    cancelAnimationFrame(frame);
    resize();
    started = performance.now();
    frame = requestAnimationFrame(draw);
  }

  // Pull-up: each word slides up once, staggered, when its block first enters the viewport.
  const pullObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-in'); pullObserver.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -10% 0px' }) : null;
  for (const block of document.querySelectorAll('[data-pull], [data-rise]')) {
    // The hero is the opening frame: it plays at once rather than waiting to scroll into view.
    // A timer, not requestAnimationFrame: background tabs never run rAF, and the text must not wait on it.
    if (block.closest('.hero')) window.setTimeout(() => block.classList.add('is-in'), calm.matches ? 0 : 60);
    else if (calm.matches || !pullObserver) block.classList.add('is-in');
    else pullObserver.observe(block);
  }

  // Scroll-linked reveal: characters go from 0.2 to full opacity as the paragraph crosses the viewport.
  const reveal = document.querySelector('[data-reveal]');
  let chars = [];
  if (reveal && !calm.matches) {
    const text = reveal.textContent;
    reveal.setAttribute('aria-label', text);
    reveal.textContent = '';
    chars = [...text].map(ch => { const span = document.createElement('span'); span.textContent = ch; span.setAttribute('aria-hidden', 'true'); reveal.append(span); return span; });
  }
  function updateReveal() {
    if (!chars.length || root.dataset.current !== 'home') return;
    const box = reveal.getBoundingClientRect();
    const view = window.innerHeight;
    const progress = Math.min(1, Math.max(0, (view * 0.8 - box.top) / (box.height + view * 0.6)));
    chars.forEach((span, index) => {
      const at = index / chars.length;
      const local = Math.min(1, Math.max(0, (progress - (at - 0.1)) / 0.15));
      span.style.opacity = String(0.2 + local * 0.8);
    });
  }

  window.addEventListener('scroll', updateReveal, { passive: true });
  window.addEventListener('resize', () => { if (root.dataset.current !== 'home') return; if (ctx) { resize(); if (calm.matches) draw(0); } updateReveal(); });
  document.addEventListener('visibilitychange', () => { if (ctx && !document.hidden && !calm.matches && root.dataset.current === 'home') frame = requestAnimationFrame(draw); });
  document.addEventListener('sixu:route', event => { if (event.detail === 'home') { startSky(); updateReveal(); } else cancelAnimationFrame(frame); });
  calm.addEventListener?.('change', startSky);
  startSky();
  updateReveal();
})();
