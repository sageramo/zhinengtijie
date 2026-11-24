// Landing page motion: the looping hero film over its still (assets/hero-loop.webm / .mp4 over hero-poster.webp), words that
// pull up into place once, and an about paragraph whose characters brighten as it scrolls through. Reduced
// motion keeps the film on its poster frame and shows all text at full strength.
(() => {
  const root = document.documentElement;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The hero film plays only while the landing is open, on screen and in a visible tab.
  const video = document.getElementById('heroVideo');
  let heroInView = true;
  const playFilm = () => {
    if (!video || calm.matches || !heroInView || document.hidden || root.dataset.current !== 'home') return;
    video.play()?.catch(() => {});
  };
  const pauseFilm = () => video?.pause();
  if (video && 'IntersectionObserver' in window) new IntersectionObserver(([entry]) => { heroInView = entry.isIntersecting; if (heroInView) playFilm(); else pauseFilm(); }).observe(video);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseFilm(); else playFilm(); });
  calm.addEventListener?.('change', () => { if (calm.matches) pauseFilm(); else playFilm(); });
  // The star chart behind the 《大学》 card (about-sky.js).
  const chart = window.SixuAboutSky?.(document.getElementById('aboutSky'));
  const night = window.SixuSectionSky?.(document.getElementById('aboutNight'));
  const startSky = () => { if (root.dataset.current === 'home') { playFilm(); chart?.start(); night?.start(); } };

  // Pull-up: each word slides up once, staggered, when its block first enters the viewport.
  const pullObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-in'); pullObserver.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -10% 0px' }) : null;
  const heroBlocks = [];
  for (const block of document.querySelectorAll('[data-pull], [data-rise], [data-drop]')) {
    if (block.closest('.hero')) heroBlocks.push(block);
    else if (calm.matches || !pullObserver) block.classList.add('is-in');
    else pullObserver.observe(block);
  }
  // The hero is the opening frame: it plays as soon as the intro opens onto it (or at once without one).
  // Timers, not requestAnimationFrame: background tabs never run rAF, and the text must not wait on it.
  const playHero = () => heroBlocks.forEach(block => block.classList.add('is-in'));

  // Opening (html.intro, set before paint): the same 墨韵 veil as entering the workbench (router.js),
  // blooming from the centre over paper and melting onto the hero; any click, key or scroll skips it.
  document.getElementById('intro')?.remove();
  if (root.classList.contains('intro') && window.SixuVeil) {
    const skip = window.SixuVeil.intro(() => { root.classList.remove('intro'); window.setTimeout(playHero, 120); });
    window.addEventListener('pointerdown', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('wheel', skip, { once: true, passive: true });
  } else {
    root.classList.remove('intro');
    window.setTimeout(playHero, calm.matches ? 0 : 60);
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
    // 0 when the card's top is near the bottom of the screen, 1 when the card sits centred on it:
    // by then the last character is at full strength.
    const box = reveal.closest('.about-card').getBoundingClientRect();
    const view = window.innerHeight;
    const progress = Math.min(1, Math.max(0, (view * 0.9 - box.top) / (view * 0.4 + box.height / 2)));
    chars.forEach((span, index) => {
      const at = index / chars.length;
      const local = Math.min(1, Math.max(0, (progress - at * 0.85) / 0.15));
      span.style.opacity = String(0.2 + local * 0.8);
    });
  }

  // 泡泡展开 (after DeepMind's Genie page): the painting opens as a clear lens in the middle of a blurred
  // copy of itself; scrolling through the tall hero widens the lens to the whole screen, sharpens what is
  // around it, then brings in the words under the title. Reduced motion shows the opened state.
  const stage = document.querySelector('.hero.is-genie');
  const frame = stage?.querySelector('.hero-frame');
  const title = stage?.querySelector('.hero-title');
  const lensStart = (vw, vh) => Math.min(vw, vh) * (vw < 760 ? 0.38 : 0.28);
  function measureTitle() {
    if (!title) return;
    // Where the title sits once the words are in; at the start it is moved to the middle of the lens and
    // sized to fit inside it, and it travels back to that place as the words come in.
    title.style.transform = 'none';
    const box = title.getBoundingClientRect();
    const view = frame.getBoundingClientRect();
    title.style.transform = '';
    const fit = Math.min(1.1, (2 * lensStart(window.innerWidth, window.innerHeight) * 0.84) / Math.max(1, box.width));
    frame.style.setProperty('--title-x', `${(view.left + view.width / 2 - (box.left + box.width / 2)).toFixed(1)}px`);
    frame.style.setProperty('--title-shift', `${(view.top + view.height / 2 - (box.top + box.height / 2)).toFixed(1)}px`);
    frame.style.setProperty('--title-scale', fit.toFixed(3));
  }
  function updateLens() {
    if (!stage || root.dataset.current !== 'home') return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const travel = Math.max(1, stage.offsetHeight - vh);
    const p = calm.matches ? 1 : Math.min(1, Math.max(0, -stage.getBoundingClientRect().top / travel));
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const lens = Math.min(1, ease / 0.78);
    const r0 = lensStart(vw, vh);
    const r1 = Math.hypot(vw, vh) / 2 + 40;
    frame.style.setProperty('--r', `${(r0 + (r1 - r0) * lens).toFixed(1)}px`);
    frame.style.setProperty('--blur', `${(18 * (1 - lens)).toFixed(2)}px`);
    frame.style.setProperty('--lens', lens.toFixed(3));
    const words = Math.min(1, Math.max(0, (p - 0.5) / 0.38));
    frame.style.setProperty('--words', words.toFixed(3));
    frame.classList.toggle('is-words', words > 0.6);
    frame.classList.toggle('is-open', lens > 0.72);
  }
  // The living painting in the lens: plays only on the landing, never for reduced motion (the poster,
  // its first frame, stays), and pauses while the tab is hidden.
  // The film (0.7–1.3 MB) is not fetched until the page has loaded, so on a slow phone it never competes with the code and
  // the first screen; the poster is its first frame, so nothing jumps. With Save-Data on it stays a still.
  const loop = stage?.querySelector('.hg-video');
  let pageLoaded = document.readyState === 'complete';
  const saveData = Boolean(navigator.connection?.saveData);
  function runLoop() {
    if (!loop) return;
    const play = pageLoaded && !saveData && !calm.matches && root.dataset.current === 'home' && !document.hidden;
    if (play) loop.play()?.catch(() => { /* autoplay refused: the poster stays */ });
    else loop.pause();
  }
  document.addEventListener('visibilitychange', runLoop);
  calm.addEventListener?.('change', runLoop);
  measureTitle();
  window.addEventListener('scroll', () => { updateReveal(); updateLens(); }, { passive: true });
  window.addEventListener('resize', () => { updateReveal(); measureTitle(); updateLens(); });
  window.addEventListener('load', () => { pageLoaded = true; measureTitle(); updateLens(); runLoop(); });
  document.addEventListener('sixu:route', event => { runLoop(); if (event.detail === 'home') { startSky(); updateReveal(); measureTitle(); updateLens(); } else { pauseFilm(); chart?.stop(); night?.stop(); } });
  startSky();
  updateReveal();
  updateLens();
  runLoop();
})();
