// Landing page motion: the looping hero film (assets/hero-campus.mp4, made in ../landing-video), words that
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
  for (const block of document.querySelectorAll('[data-pull], [data-rise]')) {
    if (block.closest('.hero')) heroBlocks.push(block);
    else if (calm.matches || !pullObserver) block.classList.add('is-in');
    else pullObserver.observe(block);
  }
  // The hero is the opening frame: it plays as soon as the intro opens onto it (or at once without one).
  // Timers, not requestAnimationFrame: background tabs never run rAF, and the text must not wait on it.
  const playHero = () => heroBlocks.forEach(block => block.classList.add('is-in'));

  // Intro (index.html, html.intro): plays for 2.3s, then the iris opens; any click, key or scroll skips it.
  const intro = root.classList.contains('intro') ? document.getElementById('intro') : null;
  let introOut = false;
  function endIntro() {
    if (introOut) return;
    introOut = true;
    root.classList.add('intro-out');
    window.setTimeout(playHero, 250);
    window.setTimeout(() => { root.classList.remove('intro', 'intro-out'); intro.remove(); }, 850);
  }
  if (intro) {
    window.setTimeout(endIntro, 2300);
    intro.addEventListener('pointerdown', endIntro);
    window.addEventListener('keydown', endIntro, { once: true });
    window.addEventListener('wheel', endIntro, { once: true, passive: true });
  } else window.setTimeout(playHero, calm.matches ? 0 : 60);

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

  window.addEventListener('scroll', updateReveal, { passive: true });
  window.addEventListener('resize', updateReveal);
  document.addEventListener('sixu:route', event => { if (event.detail === 'home') { startSky(); updateReveal(); } else { pauseFilm(); chart?.stop(); night?.stop(); } });
  startSky();
  updateReveal();
})();
