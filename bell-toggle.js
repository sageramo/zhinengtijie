/**
 * Bell toggle, ported from React Bits' <BellToggle /> (JavaScript + CSS variant) to plain DOM:
 * the workbench has no React. The original clips a fixed-width pill; ours has a hairline border that a
 * clip would cut off, so the label box itself animates between the two label widths instead, and
 * the ring stays a Web Animations keyframe run with the same curve (SEG_EASE, WARP, decaying
 * passes, sound waves on each swing, a smaller wobble when the count rises). The bell is drawn
 * inline (no icon package). Props keep the original names where they still apply.
 */
const SEG_EASE = 'cubic-bezier(0.77, 0, 0.175, 1)';
const WARP = 0.6;
const WOBBLE = { amplitude: 0.4, passes: 3, duration: 420 };
const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.5V10a6 6 0 0 1 12 0v6.5l1.6 2.3H4.4L6 16.5z"/><path d="M12 2.5V4"/></svg>';
const CLAPPER = '<svg viewBox="0 0 24 24"><circle cx="12" cy="20.4" r="1.7" fill="currentColor"/></svg>';

export const passOffset = (k, passes) => 1 - Math.pow(1 - (k + 2 / 3) / (passes + 1), WARP);
export function ringKeyframes(from, amplitude, passes, decay) {
  const frames = [{ transform: `rotate(${from}deg)`, offset: 0, easing: SEG_EASE }];
  for (let k = 0; k < passes; k += 1) {
    const angle = amplitude * Math.pow(1 - k / passes, decay) * (k % 2 ? 1 : -1);
    frames.push({ transform: `rotate(${angle.toFixed(2)}deg)`, offset: passOffset(k, passes), easing: SEG_EASE });
  }
  frames.push({ transform: 'rotate(0deg)', offset: 1 });
  return frames;
}
function liveAngle(element) {
  const transform = window.getComputedStyle(element).transform;
  if (!transform || transform === 'none' || typeof window.DOMMatrix !== 'function') return 0;
  const matrix = new window.DOMMatrix(transform);
  return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
}

/** Returns { element, setPressed, setCount, pressed() }. onChange(pressed) runs on every user toggle. */
export function createBellToggle({
  offLabel = '提醒我', onLabel = '已开启提醒', label, ringAmplitude = 17, ringPasses = 5, ringDecay = 1, ringDuration = 820,
  waves = true, clapper = true, count = 0, defaultPressed = false, onChange = () => {}, className = '',
} = {}) {
  const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('span');
  root.className = `bell-toggle${className ? ` ${className}` : ''}`;
  root.innerHTML = `<button type="button" class="bell-toggle__button" aria-pressed="false">
      <span class="bell-toggle__bell" aria-hidden="true"><span class="bell-toggle__glyph">${BELL}</span>${clapper ? `<span class="bell-toggle__clapper">${CLAPPER}</span>` : ''}
        ${waves ? '<svg class="bell-toggle__wave bell-toggle__wave--left" viewBox="0 0 14 14"><path d="M14 8a6 6 0 0 0-6 6"/><path d="M14 4A10 10 0 0 0 4 14"/></svg><svg class="bell-toggle__wave bell-toggle__wave--right" viewBox="0 0 14 14"><path d="M0 8a6 6 0 0 1 6 6"/><path d="M0 4a10 10 0 0 1 10 10"/></svg>' : ''}
        <span class="bell-toggle__badge"><span class="bell-toggle__digit"></span></span></span>
      <span class="bell-toggle__say" aria-hidden="true"><span class="bell-toggle__face bell-toggle__face--off"></span><span class="bell-toggle__face bell-toggle__face--on"></span></span>
    </button>`;
  const button = root.querySelector('button');
  const glyph = root.querySelector('.bell-toggle__glyph');
  const clap = root.querySelector('.bell-toggle__clapper');
  const [waveLeft, waveRight] = root.querySelectorAll('.bell-toggle__wave');
  const badge = root.querySelector('.bell-toggle__badge');
  const digit = root.querySelector('.bell-toggle__digit');
  const offFace = root.querySelector('.bell-toggle__face--off');
  const onFace = root.querySelector('.bell-toggle__face--on');
  offFace.textContent = offLabel;
  onFace.textContent = onLabel;
  button.setAttribute('aria-label', label || offLabel);
  let on = defaultPressed;
  let current = count;

  // The label box takes the width of the visible face and animates to the other one, border intact.
  function clip() {
    const width = (on ? onFace : offFace).offsetWidth;
    if (width) root.style.setProperty('--bt-say', `${width}px`);
  }
  function swing(amplitude, passes, duration) {
    if (calm() || typeof glyph.animate !== 'function') return;
    glyph.getAnimations?.().forEach(animation => animation.cancel());
    glyph.animate(ringKeyframes(liveAngle(glyph), amplitude, passes, ringDecay), { duration, easing: 'linear' });
    if (clap) {
      clap.getAnimations?.().forEach(animation => animation.cancel());
      clap.animate(ringKeyframes(liveAngle(clap), amplitude * 1.6, passes, ringDecay), { duration, delay: 70, easing: 'linear' });
    }
    if (!waves) return;
    for (let k = 0; k < passes; k += 1) {
      const side = k % 2 ? waveRight : waveLeft;
      const strength = Math.pow(1 - k / passes, ringDecay);
      side.animate([{ opacity: 0, transform: 'scale(0.55)' }, { opacity: 0.9 * strength, offset: 0.3 }, { opacity: 0, transform: 'scale(1.25)' }],
        { duration: 380, delay: passOffset(k, passes) * duration, easing: 'ease-out' });
    }
  }
  function paint() {
    root.dataset.on = on ? 'true' : 'false';
    button.setAttribute('aria-pressed', String(on));
    digit.textContent = current > 9 ? '9+' : String(current);
    badge.toggleAttribute('data-show', on && current > 0);
    clip();
  }
  button.addEventListener('pointerdown', event => { if (event.button === 0 && !button.disabled) root.dataset.pressed = ''; });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, () => delete root.dataset.pressed);
  button.addEventListener('click', () => {
    on = !on;
    paint();
    if (on) swing(ringAmplitude, ringPasses, ringDuration);
    onChange(on);
  });
  if (typeof window.ResizeObserver === 'function') { const observer = new window.ResizeObserver(clip); observer.observe(onFace); observer.observe(offFace); }
  document.fonts?.ready.then(clip);
  paint();
  return {
    element: root,
    pressed: () => on,
    /** Outside changes only crossfade; they never ring. */
    setPressed(value) { on = Boolean(value); paint(); },
    setCount(value) {
      const rose = value > current;
      current = Math.max(0, value | 0);
      paint();
      if (rose && on) swing(ringAmplitude * WOBBLE.amplitude, WOBBLE.passes, WOBBLE.duration);
    },
    ring() { swing(ringAmplitude, ringPasses, ringDuration); },
  };
}
