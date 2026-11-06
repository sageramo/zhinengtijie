// Background for the 《大学》 card: a star chart after the old stone-engraved charts — the inner circle,
// the equator and the outer circle, twenty-eight radial divisions with a mansion of stars in each,
// a degree scale round the rim and an off-centre ecliptic. The first time the card comes into view the
// circles draw themselves in and the mansions light one after another, in order; after that the chart
// turns slowly (a little faster as the page scrolls), and a gold sun travels the ecliptic, waking the
// mansion it passes. Reduced motion draws the finished chart once.
(() => {
  const TAU = Math.PI * 2;
  const MANSIONS = 28;
  // Warm-paper palette (暮光暖纸): amber-brown linework, ink stars, grass green for the mansion the sun wakes.
  const GOLD = '128, 76, 22';
  const CYAN = '70, 110, 48';
  const MOON = '40, 30, 20';

  // A fixed seed, so the mansions keep their shapes from visit to visit.
  function seeded(seed) {
    let s = seed;
    return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  }
  const rand = seeded(20261103);
  const mansions = Array.from({ length: MANSIONS }, (_, m) => {
    const count = 3 + Math.floor(rand() * 4);
    const from = (m + 0.18) / MANSIONS * TAU;
    const span = 0.64 / MANSIONS * TAU;
    const stars = Array.from({ length: count }, (_, i) => ({
      a: from + span * (i + rand() * 0.6) / count,
      r: 0.62 + rand() * 0.3,
      size: 0.9 + rand() * 1.3,
    }));
    return { stars, centre: (m + 0.5) / MANSIONS * TAU };
  });
  const dust = Array.from({ length: 170 }, () => ({ a: rand() * TAU, r: Math.sqrt(rand()) * 1.15, size: rand() * 0.8 + 0.3, phase: rand() * TAU, base: rand() * 0.3 + 0.1 }));

  window.SixuAboutSky = canvas => {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let raf = 0;
    let running = false;
    let visible = false;
    let bornAt = 0;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (calm.matches || !running) draw(performance.now());
    }

    const clamp = x => Math.min(1, Math.max(0, x));
    const angleGap = (a, b) => { const d = Math.abs(((a - b) % TAU + TAU) % TAU); return Math.min(d, TAU - d); };

    function draw(time) {
      const still = calm.matches;
      // Intro progress: circles over the first 1.8s, then the mansions one by one.
      const age = still ? 1e9 : bornAt ? time - bornAt : 0;
      const R = Math.max(height * 0.56, Math.min(width, height * 1.3) * 0.5);
      const cx = width / 2;
      const cy = height * 0.52;
      const scroll = clamp(1 - canvas.getBoundingClientRect().top / (window.innerHeight || 1));
      const turn = still ? 0 : time / 360000 * TAU + scroll * 0.5;
      const sun = still ? 0.9 : time / 42000 * TAU;

      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';

      for (const d of dust) {
        const x = cx + Math.cos(d.a + turn * 0.5) * d.r * R;
        const y = cy + Math.sin(d.a + turn * 0.5) * d.r * R;
        if (x < 0 || x > width || y < 0 || y > height) continue;
        ctx.fillStyle = `rgba(${MOON}, ${still ? d.base : d.base + 0.12 * Math.sin(time / 1100 + d.phase)})`;
        ctx.beginPath(); ctx.arc(x, y, d.size, 0, TAU); ctx.fill();
      }

      // The three circles of the chart, each drawn in from the top.
      [[0.3, 0.24], [0.58, 0.3], [1, 0.38]].forEach(([k, alpha], i) => {
        const p = clamp((age - i * 220) / 1400);
        if (!p) return;
        ctx.strokeStyle = `rgba(${GOLD}, ${alpha})`;
        ctx.lineWidth = i === 2 ? 1.2 : 0.8;
        ctx.beginPath(); ctx.arc(cx, cy, k * R, -Math.PI / 2 + turn, -Math.PI / 2 + turn + TAU * p); ctx.stroke();
      });
      // The ecliptic: an off-centre circle crossing the equator.
      const ex = cx + R * 0.1;
      const ey = cy - R * 0.08;
      const er = R * 0.62;
      const pe = clamp((age - 700) / 1400);
      if (pe) {
        ctx.strokeStyle = `rgba(${GOLD}, 0.24)`;
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(ex, ey, er, turn, turn + TAU * pe); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Degree scale on the rim and the twenty-eight divisions.
      const ps = clamp((age - 900) / 900);
      if (ps) {
        ctx.strokeStyle = `rgba(${GOLD}, ${0.34 * ps})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (let i = 0; i < 180; i += 1) {
          const a = i / 180 * TAU + turn;
          const len = i % 15 ? 0.018 : 0.04;
          ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx.lineTo(cx + Math.cos(a) * R * (1 + len), cy + Math.sin(a) * R * (1 + len));
        }
        ctx.stroke();
        ctx.strokeStyle = `rgba(${GOLD}, ${0.13 * ps})`;
        ctx.beginPath();
        for (let m = 0; m < MANSIONS; m += 1) {
          const a = m / MANSIONS * TAU + turn;
          ctx.moveTo(cx + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3);
          ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        }
        ctx.stroke();
      }

      // The sun on the ecliptic, and the mansion it is passing through.
      const sx = ex + Math.cos(sun + turn) * er;
      const sy = ey + Math.sin(sun + turn) * er;
      const sunAngle = Math.atan2(sy - cy, sx - cx) - turn;
      mansions.forEach((mansion, m) => {
        const p = clamp((age - 1600 - m * 90) / 500);
        if (!p) return;
        const wake = still ? 0 : clamp(1 - angleGap(sunAngle, mansion.centre) / (TAU / MANSIONS * 1.6));
        const points = mansion.stars.map(s => [cx + Math.cos(s.a + turn) * s.r * R, cy + Math.sin(s.a + turn) * s.r * R]);
        ctx.strokeStyle = wake > 0 ? `rgba(${CYAN}, ${(0.18 + 0.4 * wake) * p})` : `rgba(${GOLD}, ${0.32 * p})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        points.forEach(([x, y], i) => {
          const size = mansion.stars[i].size;
          if (wake > 0) {
            const g = ctx.createRadialGradient(x, y, 0, x, y, size * 7);
            g.addColorStop(0, `rgba(${CYAN}, ${0.5 * wake * p})`);
            g.addColorStop(1, `rgba(${CYAN}, 0)`);
            ctx.fillStyle = g;
            ctx.fillRect(x - size * 7, y - size * 7, size * 14, size * 14);
          }
          ctx.fillStyle = `rgba(${MOON}, ${(0.45 + 0.5 * wake) * p})`;
          ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fill();
        });
      });
      if (pe >= 1) {
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 26);
        g.addColorStop(0, `rgba(${GOLD}, 0.75)`);
        g.addColorStop(0.25, `rgba(${GOLD}, 0.25)`);
        g.addColorStop(1, `rgba(${GOLD}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(sx - 26, sy - 26, 52, 52);
        ctx.fillStyle = `rgba(${MOON}, 0.95)`;
        ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, TAU); ctx.fill();
      }

      // Keep the words readable: the chart sinks back behind the title and the paragraph.
      const veil = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.48);
      veil.addColorStop(0, 'rgba(255, 251, 244, 0.82)');
      veil.addColorStop(0.5, 'rgba(255, 251, 244, 0.45)');
      veil.addColorStop(1, 'rgba(255, 251, 244, 0)');
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, width, height);

      if (running && visible && !still && !document.hidden) raf = requestAnimationFrame(draw);
    }

    function loop() { cancelAnimationFrame(raf); if (running && visible && !calm.matches && !document.hidden) raf = requestAnimationFrame(draw); }
    const viewObserver = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !bornAt) bornAt = performance.now();
      loop();
    }, { rootMargin: '0px 0px -15% 0px' }) : null;
    if (viewObserver) viewObserver.observe(canvas);
    else { visible = true; bornAt = performance.now(); }
    const sizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
    sizeObserver?.observe(canvas);
    document.addEventListener('visibilitychange', loop);
    calm.addEventListener?.('change', () => { resize(); loop(); });

    return {
      start() { running = true; resize(); loop(); },
      stop() { running = false; cancelAnimationFrame(raf); },
    };
  };
})();

// The air around the card: three depths of amber dust that drift past at different speeds as the page
// scrolls, soft clouds of sunlight and grass-green light wandering slowly behind them, and now and then a
// shooting spark. Reduced motion draws the dust and clouds once.
(() => {
  const TAU = Math.PI * 2;
  window.SixuSectionSky = canvas => {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let raf = 0;
    let running = false;
    let visible = false;
    let lastTime = 0;
    let stars = [];
    let meteor = null;
    let nextMeteor = 1500;
    const clouds = [
      { rgb: '226, 181, 106', x: 0.18, y: 0.3, r: 0.55, a: 0.34, speed: 0.00005, phase: 0 },
      { rgb: '95, 122, 74', x: 0.85, y: 0.75, r: 0.5, a: 0.14, speed: 0.00004, phase: 2.1 },
      { rgb: '240, 200, 140', x: 0.7, y: 0.2, r: 0.38, a: 0.3, speed: 0.00006, phase: 4.2 },
    ];

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round(Math.min(320, (width * height) / 3600));
      stars = Array.from({ length: count }, () => {
        const depth = Math.random();
        return { x: Math.random(), y: Math.random(), depth, r: 0.3 + depth * 1.2, base: 0.15 + depth * 0.45, phase: Math.random() * TAU, rate: 0.0008 + Math.random() * 0.0015 };
      });
      if (calm.matches || !running) draw(performance.now());
    }

    function draw(time) {
      const still = calm.matches;
      const dt = lastTime ? Math.min(64, time - lastTime) : 16;
      lastTime = time;
      const box = canvas.getBoundingClientRect();
      const scroll = box.top / (window.innerHeight || 1);
      ctx.clearRect(0, 0, width, height);

      ctx.globalCompositeOperation = 'lighter';
      for (const cloud of clouds) {
        const t = still ? 0 : time * cloud.speed;
        const x = (cloud.x + 0.08 * Math.sin(t * TAU + cloud.phase)) * width;
        const y = (cloud.y + 0.1 * Math.cos(t * TAU * 0.7 + cloud.phase) + scroll * 0.08) * height;
        const r = cloud.r * Math.max(width, height) * (1 + 0.08 * Math.sin(t * TAU * 1.3 + cloud.phase));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${cloud.rgb}, ${cloud.a})`);
        g.addColorStop(0.5, `rgba(${cloud.rgb}, ${cloud.a * 0.35})`);
        g.addColorStop(1, `rgba(${cloud.rgb}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      ctx.fillStyle = '#a8661f';
      for (const star of stars) {
        // Nearer stars slide further with the scroll and drift faster sideways.
        const x = ((star.x + (still ? 0 : time * 0.000004 * (0.3 + star.depth))) % 1) * width;
        const y = (((star.y + scroll * 0.25 * (0.2 + star.depth)) % 1) + 1) % 1 * height;
        ctx.globalAlpha = Math.max(0, still ? star.base : star.base + 0.25 * Math.sin(time * star.rate + star.phase));
        ctx.beginPath(); ctx.arc(x, y, star.r, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!still) {
        nextMeteor -= dt;
        if (!meteor && nextMeteor <= 0) {
          meteor = { x: width * (0.3 + Math.random() * 0.7), y: height * Math.random() * 0.5, life: 0, len: 90 + Math.random() * 80 };
          nextMeteor = 4000 + Math.random() * 5000;
        }
        if (meteor) {
          meteor.life += dt / 900;
          const p = meteor.life;
          const hx = meteor.x - p * width * 0.25;
          const hy = meteor.y + p * width * 0.12;
          const tail = ctx.createLinearGradient(hx, hy, hx + meteor.len, hy - meteor.len * 0.48);
          tail.addColorStop(0, `rgba(192, 122, 44, ${0.85 * Math.sin(Math.min(1, p) * Math.PI)})`);
          tail.addColorStop(1, 'rgba(192, 122, 44, 0)');
          ctx.strokeStyle = tail;
          ctx.lineWidth = 1.3;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + meteor.len, hy - meteor.len * 0.48); ctx.stroke();
          if (p >= 1) meteor = null;
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      if (running && visible && !still && !document.hidden) raf = requestAnimationFrame(draw);
    }

    function loop() { cancelAnimationFrame(raf); lastTime = 0; if (running && visible && !calm.matches && !document.hidden) raf = requestAnimationFrame(draw); }
    const viewObserver = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; loop(); }) : null;
    if (viewObserver) viewObserver.observe(canvas);
    else visible = true;
    const sizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
    sizeObserver?.observe(canvas);
    document.addEventListener('visibilitychange', loop);
    calm.addEventListener?.('change', () => { resize(); loop(); });
    // Scrolling moves the stars even when nothing else asks for a frame (reduced motion).
    window.addEventListener('scroll', () => { if (calm.matches && running && visible) draw(performance.now()); }, { passive: true });

    return {
      start() { running = true; resize(); loop(); },
      stop() { running = false; cancelAnimationFrame(raf); },
    };
  };
})();
