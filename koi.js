// 墨鱼入砚: entering the workbench from the landing.
// The scroll painting comes up clear over everything and the view drifts in towards the lake. Behind it
// 研墨 is switched in and measured, so the fish has a real destination: the inkstone above the greeting
// (or, mid-conversation, the composer — the 砚池). Rings spread on the water, an ink fish leaps out and
// swims an S towards it, leaving a trail, and dives in: the stone splashes, ink blooms out of the pool,
// and the painting fades into the faint copy of itself that 研墨 keeps as its background, while 研墨's
// parts come up in turn (stone, greeting, suggestions, composer, rail, header). Played on every entry
// from the landing; a click or key skips to the end; reduced motion and browsers without CSS motion
// paths switch at once.
(() => {
  const root = document.documentElement;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const supported = () => !calm.matches && typeof CSS !== 'undefined' && CSS.supports?.('offset-path', 'path("M0 0L1 1")') && typeof Element.prototype.animate === 'function';
  const PAINTING = './assets/hero-scroll.webp';

  // A koi facing +x (offset-rotate: auto turns it along the path): a soft wash halo under a graded body,
  // a darker back stroke, a forked tail, flowing fins and a pale eye.
  const FISH = `<svg viewBox="-90 -40 180 80" width="210" height="94" aria-hidden="true">
    <defs>
      <linearGradient id="koiInk" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#0f1822"/><stop offset=".5" stop-color="#22344a" stop-opacity=".95"/><stop offset="1" stop-color="#4c6380" stop-opacity=".5"/></linearGradient>
      <linearGradient id="koiBelly" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1822" stop-opacity="0"/><stop offset="1" stop-color="#7c90a6" stop-opacity=".55"/></linearGradient>
      <filter id="koiWash" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
      <filter id="koiSoft" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation=".6"/></filter>
    </defs>
    <path d="M66 0C56-15 28-20 0-16C-20-13-36-8-46-3L-46 3C-36 8-20 13 0 16C28 20 56 15 66 0Z" fill="#16222f" opacity=".28" filter="url(#koiWash)"/>
    <g filter="url(#koiSoft)">
      <g class="koi-tail"><path d="M-44 0C-56-8-68-22-82-27C-76-13-74-5-74 0C-74 5-76 13-82 27C-68 22-56 8-44 0Z" fill="url(#koiInk)"/></g>
      <path d="M66 0C56-15 28-20 0-16C-20-13-36-8-46-3L-46 3C-36 8-20 13 0 16C28 20 56 15 66 0Z" fill="url(#koiInk)"/>
      <path d="M60-2C46-12 22-15 0-13C-16-11-30-7-40-3" fill="none" stroke="#0b121a" stroke-width="3.2" stroke-linecap="round" opacity=".55"/>
      <path d="M58 3C44 12 20 14 0 12C-14 10-28 7-38 3" fill="none" stroke="url(#koiBelly)" stroke-width="5" stroke-linecap="round"/>
      <path class="koi-fin" d="M10 12C6 22-4 30-16 32C-11 24-6 17-1 12Z" fill="#22344a" opacity=".7"/>
      <path class="koi-fin" d="M10-12C6-22-4-30-16-32C-11-24-6-17-1-12Z" fill="#22344a" opacity=".55"/>
      <path d="M26-15C18-24 6-28-6-28C0-22 6-18 12-15Z" fill="#22344a" opacity=".5"/>
      <circle cx="50" cy="-5" r="2.4" fill="#f3eee2" opacity=".9"/>
    </g></svg>`;

  let current = null;
  function cross(show) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const timers = [];
    const later = (ms, step) => timers.push(window.setTimeout(step, ms));
    // Where it rises: the open water right of the title, left of the reeds.
    const start = [vw * (vw < 760 ? 0.56 : 0.62), vh * 0.56];

    const layer = document.createElement('div');
    layer.className = 'koi-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = `<img class="kv-paint" src="${PAINTING}" alt="" style="transform-origin:${start[0]}px ${start[1]}px">
      <svg class="koi-trail" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}"><path d=""/></svg>
      <i class="koi-ring" style="left:${start[0]}px;top:${start[1]}px"></i><i class="koi-ring" style="left:${start[0]}px;top:${start[1]}px"></i><i class="koi-ring" style="left:${start[0]}px;top:${start[1]}px"></i>
      <div class="koi-fish">${FISH}</div>
      <i class="koi-splash"></i><i class="koi-splash"></i><i class="koi-splash"></i><i class="koi-bloom"></i>`;
    document.body.append(layer);
    const paint = layer.querySelector('.kv-paint');
    const fish = layer.querySelector('.koi-fish');
    const trail = layer.querySelector('.koi-trail path');
    root.classList.add('koi-run');

    let switched = false;
    let done = false;
    const switchIn = () => {
      if (switched) return;
      switched = true;
      root.classList.add('koi-arriving');
      show();
    };
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(window.clearTimeout);
      window.removeEventListener('pointerdown', skip, true);
      window.removeEventListener('keydown', skip, true);
      root.classList.remove('koi-run', 'koi-arriving', 'koi-landed');
      layer.remove();
      current = null;
    };
    // A click or a key: straight to the workbench, everything in place.
    const skip = () => { switchIn(); layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }); window.setTimeout(finish, 230); };
    window.addEventListener('pointerdown', skip, true);
    window.addEventListener('keydown', skip, true);
    current = { skip };

    // 1. The painting comes up clear and the view drifts in towards the lake for the whole crossing.
    paint.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out', fill: 'forwards' });
    paint.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.16)' }], { duration: 3400, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' });

    // 2. Behind it, 研墨 is switched in and measured: the fish swims to its inkstone (or its composer).
    later(320, () => {
      switchIn();
      // 研墨 opens at its top: measure only once the page has scrolled there and laid out.
      window.scrollTo(0, 0);
      window.requestAnimationFrame(() => window.requestAnimationFrame(aim));
    });
    function aim() {
      if (done) return;
      const stone = document.querySelector('.page-import .ink-hello .inkstone');
      const well = document.querySelector('.page-import .inkwell');
      const box = [stone, well].map(element => element?.getBoundingClientRect()).find(rect => rect && rect.width > 0 && rect.bottom > 0 && rect.top < vh);
      const end = box ? [box.left + box.width / 2, box.top + box.height / 2] : [vw / 2, vh * 0.3];
      const c1 = [start[0] + vw * 0.1, start[1] - vh * 0.24];
      const c2 = [end[0] + vw * 0.2, end[1] + vh * 0.16];
      const d = `M${start[0].toFixed(1)} ${start[1].toFixed(1)}C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`;
      fish.style.offsetPath = `path('${d}')`;
      trail.setAttribute('d', d);
      const length = trail.getTotalLength();
      trail.style.strokeDasharray = `${length}`;
      for (const splash of layer.querySelectorAll('.koi-splash, .koi-bloom')) { splash.style.left = `${end[0]}px`; splash.style.top = `${end[1]}px`; }
      run(length);
    }

    function run(length) {
      const SWIM = 1700;
      const RISE = 420;
      // Rings spread on the water; the fish comes up out of the ink.
      layer.querySelectorAll('.koi-ring').forEach((ring, index) => ring.animate(
        [{ transform: 'translate(-50%, -50%) scale(.2)', opacity: .8 }, { transform: 'translate(-50%, -50%) scale(3)', opacity: 0 }],
        { duration: 1500, delay: index * 220, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' }));
      fish.animate([{ opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0px)' }], { duration: RISE, easing: 'ease-out', fill: 'both' });
      fish.animate([{ offsetDistance: '0%', scale: .7 }, { offsetDistance: '100%', scale: 1.15 }], { duration: SWIM, delay: 120, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' });
      layer.querySelector('.koi-tail').animate([{ transform: 'rotate(-16deg)' }, { transform: 'rotate(16deg)' }], { duration: 240, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
      layer.querySelectorAll('.koi-fin').forEach(fin => fin.animate([{ transform: 'rotate(-8deg)' }, { transform: 'rotate(8deg)' }], { duration: 420, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }));
      trail.animate([{ strokeDashoffset: length, opacity: .9 }, { strokeDashoffset: 0, opacity: .6 }], { duration: SWIM, delay: 120, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' });
      // 3. It dives into the stone: the pool splashes, ink blooms, the painting fades into 研墨's own,
      //    and 研墨's parts come up in turn (CSS, html.koi-landed).
      later(120 + SWIM - 80, () => {
        fish.animate([{ opacity: 1, scale: 1.15 }, { opacity: 0, scale: .25 }], { duration: 300, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' });
        layer.querySelectorAll('.koi-splash').forEach((ring, index) => ring.animate(
          [{ transform: 'translate(-50%, -50%) scale(.15)', opacity: .9 }, { transform: 'translate(-50%, -50%) scale(2.4)', opacity: 0 }],
          { duration: 1000, delay: 180 + index * 160, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' }));
        layer.querySelector('.koi-bloom').animate(
          [{ transform: 'translate(-50%, -50%) scale(.1)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: .85, offset: .35 }, { transform: 'translate(-50%, -50%) scale(2.2)', opacity: 0 }],
          { duration: 1300, delay: 160, easing: 'ease-out', fill: 'both' });
        trail.animate([{ opacity: .6 }, { opacity: 0 }], { duration: 500, delay: 200, fill: 'forwards' });
        paint.animate([{ opacity: 1, filter: 'none' }, { opacity: 0, filter: 'grayscale(.5) brightness(1.3) blur(3px)' }], { duration: 1000, delay: 180, easing: 'ease-in-out', fill: 'forwards' });
        later(220, () => root.classList.add('koi-landed'));
        later(1500, finish);
      });
    }
  }

  window.SixuKoi = {
    supported,
    /** Plays the crossing; show() switches the route (called once, under the painting). */
    cross: show => { current?.skip(); cross(show); },
  };
})();
