// Landing background: the astrolabe painting (assets/hero-astrolabe.webp), brought to life on one canvas.
// Light beads run along the cyan constellation needle from the left orb to the guiding star, which flares
// as each one arrives; the orbs' eyes breathe, stars twinkle, a gold meteor crosses now and then, and the
// whole picture leans slightly toward the pointer. Every so often (and on a click) the needle sweeps once
// round the dial and settles back like a compass: for those seconds the painting crossfades to a copy
// with the needle erased (hero-astrolabe-clean.webp) and the needle is drawn, turning in the dial's
// tilted plane. The painting itself is drawn by WebGL where available, so its nebula can flow: a slowly
// travelling warp field stirs the clouds (only where hero-astrolabe-flow.webp allows, never the instrument
// or the orbits) and faint veils of light drift through them; the overlays stay on the 2D canvas above.
// Reduced motion draws one still frame. Points are in the painting's pixels (1672 × 941).
(() => {
  const IW = 1672;
  const IH = 941;
  const PIVOT = [838, 276];
    const PATH = [[573, 384], [653, 376], [695, 345], [763, 306], [798, 291], [838, 276], [878, 260], [910, 245], [951, 223], [997, 194], [1034, 169], [1063, 140]];
  const EYES = [[573, 384, 26, 0], [1097, 280, 20, 1.7], [838, 276, 16, 3.1], [838, 50, 11, 4.4]];
  // The dial is a circle seen at a tilt: an ellipse with these half-axes around the pivot. Each needle
  // point is kept as (radius, angle) in that circle so the whole needle can turn in the dial's plane.
  const DIAL = [237, 175];
  const POLAR = PATH.map(([x, y]) => { const u = (x - PIVOT[0]) / DIAL[0]; const w = (y - PIVOT[1]) / DIAL[1]; return [Math.hypot(u, w), Math.atan2(w, u)]; });
  const SPIN_MS = 4200;
  const FADE_MS = 400;
  const CYAN = '120, 228, 255';
  const GOLD = '231, 199, 125';

  const VERTEX = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const FRAGMENT = `
precision mediump float;
uniform sampler2D uImg, uClean, uFlow;
uniform vec4 uRect;
uniform vec2 uView;
uniform float uRatio, uTime, uMix, uAlpha, uMotion;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
void main() {
  vec3 ground = vec3(3.0, 18.0, 24.0) / 255.0;
  vec2 px = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y) / uRatio;
  vec2 uv = (px - uRect.xy) / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(ground, 1.0); return; }
  float m = texture2D(uFlow, uv).r * uMotion;
  float t = uTime;
  // Two layers of warp, both travelling slowly to the left: the clouds churn and seem to stream.
  vec2 q = uv * vec2(3.2, 5.0);
  vec2 w = vec2(fbm(q + vec2(t * 0.18, 0.0)), fbm(q + vec2(4.7, 1.9) + vec2(t * 0.18, t * 0.04))) - 0.5;
  vec2 w2 = vec2(fbm(q * 1.7 + w * 1.6 + vec2(t * 0.28, 0.0)), fbm(q * 1.7 + w * 1.6 + vec2(2.3, 6.1) + vec2(t * 0.28, 0.0))) - 0.5;
  vec2 suv = uv + (w + w2 * 0.6) * m * vec2(0.034, 0.05);
  vec3 col = mix(texture2D(uImg, suv).rgb, texture2D(uClean, suv).rgb, uMix);
  // Mist: two veils of teal light at different depths, drifting left through the cloud and the dark
  // sky around it, thinner where it passes in front of the instrument.
  float haze = (0.35 + 0.65 * smoothstep(0.03, 0.45, texture2D(uFlow, uv).r)) * uMotion;
  float near = fbm(uv * vec2(2.4, 6.0) + w2 * 2.0 + vec2(t * 0.22, 0.0));
  float far = fbm(uv * vec2(1.2, 2.6) + w * 1.2 + vec2(t * 0.12, t * 0.02) + 9.0);
  col += vec3(0.22, 0.6, 0.68) * smoothstep(0.4, 0.82, near) * haze * 0.48;
  col += vec3(0.16, 0.42, 0.5) * smoothstep(0.35, 0.8, far) * haze * 0.4;
  gl_FragColor = vec4(mix(ground, col, uAlpha), 1.0);
}`;

  // The painting on a WebGL canvas, or null where WebGL is missing (the 2D canvas then draws it still).
  function painter(glCanvas) {
    const gl = glCanvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) return null;
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = name => gl.getUniformLocation(program, name);
    const textures = {};
    ['uImg', 'uClean', 'uFlow'].forEach((name, unit) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(u(name), unit);
      textures[name] = { tex, unit };
    });
    let ratio = 1;
    return {
      upload(name, img) {
        const { tex, unit } = textures[name];
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      },
      resize(width, height, r) {
        ratio = r;
        glCanvas.width = Math.round(width * r);
        glCanvas.height = Math.round(height * r);
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      },
      render(rect, { mix, alpha, time, motion }) {
        gl.uniform4f(u('uRect'), rect[0], rect[1], rect[2], rect[3]);
        gl.uniform2f(u('uView'), glCanvas.width, glCanvas.height);
        gl.uniform1f(u('uRatio'), ratio);
        gl.uniform1f(u('uTime'), (time / 1000) % 1000);
        gl.uniform1f(u('uMix'), mix);
        gl.uniform1f(u('uAlpha'), alpha);
        gl.uniform1f(u('uMotion'), motion);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  window.SixuHeroScene = (canvas, { src, cleanSrc, flowSrc } = {}) => {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    const glCanvas = document.createElement('canvas');
    glCanvas.className = canvas.className;
    glCanvas.setAttribute('aria-hidden', 'true');
    canvas.before(glCanvas);
    const paint = painter(glCanvas);
    if (!paint) glCanvas.remove();
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const frame = canvas.parentElement;
    const image = new Image();
    const clean = new Image();
    let cleanReady = false;
    let loadedAt = 0;
    let width = 0;
    let height = 0;
    let base = { s: 1, cx: 0, cy: 0 };
    let raf = 0;
    let running = false;
    let visible = true;
    let lastTime = 0;
    let lastSpawn = 0;
    let nextMeteor = 3000;
    let flare = 0;
    const lean = { x: 0, y: 0, tx: 0, ty: 0 };
    const beads = [];
    let meteor = null;
    let spinAt = 0;
    let nextSpin = 0;

    // The needle turned by `turn` radians in the dial's plane, with its running lengths for `along`.
    function needle(turn) {
      const points = POLAR.map(([rho, phi]) => [PIVOT[0] + DIAL[0] * rho * Math.cos(phi + turn), PIVOT[1] + DIAL[1] * rho * Math.sin(phi + turn)]);
      const lengths = [0];
      for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
      return { points, lengths, total: lengths[lengths.length - 1] };
    }
    const REST = needle(0);
    function along({ points, lengths, total }, d) {
      const at = Math.min(total, Math.max(0, d));
      let i = 1;
      while (i < lengths.length - 1 && lengths[i] < at) i += 1;
      const f = (at - lengths[i - 1]) / (lengths[i] - lengths[i - 1]);
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f];
    }

    // One full turn: ease out of rest, overshoot a little, then swing back and settle like a compass.
    // `mix` is how far the painting has crossfaded to the needle-less copy.
    function spinState(time) {
      if (!spinAt) return { turn: 0, mix: 0 };
      const age = time - spinAt;
      if (age >= SPIN_MS + FADE_MS) { spinAt = 0; nextSpin = time + 9000 + Math.random() * 4000; return { turn: 0, mix: 0 }; }
      const p = Math.min(1, age / SPIN_MS);
      const ease = q => (q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2);
      const turn = p < 0.7 ? Math.PI * 2 * 1.035 * ease(p / 0.7) : Math.PI * 2 * (1 + 0.035 * Math.cos(((p - 0.7) / 0.3) * Math.PI * 2.5) * (1 - (p - 0.7) / 0.3));
      const mix = Math.min(1, age / FADE_MS, Math.max(0, (SPIN_MS + FADE_MS - age) / FADE_MS));
      return { turn: p >= 1 ? 0 : turn, mix };
    }
    function spin(time) { if (!spinAt && cleanReady && !calm.matches) spinAt = time; }

    const stars = Array.from({ length: 150 }, () => ({
      x: Math.random() * IW, y: Math.random() * 640, r: Math.random() * 0.9 + 0.35,
      base: Math.random() * 0.4 + 0.15, phase: Math.random() * Math.PI * 2, speed: Math.random() * 0.0015 + 0.0006,
    }));

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint?.resize(width, height, ratio);
      // Fill the width, but on tall screens keep the instrument large enough to read and let the
      // painting's own dark ground continue below it; the spare height sits partly above, clear of the nav.
      const s = Math.max(width / IW, (height * 0.62) / IH);
      const top = Math.max(0, height - IH * s) * (width < 640 ? 0.42 : 0.6);
      base = { s, cx: width / 2 + (PIVOT[0] - IW / 2) * s, cy: top + PIVOT[1] * s };
      if (!running) draw(performance.now());
    }

    // The painting's scale this frame: a slow breath around the instrument, plus the pointer lean.
    function view(time) {
      const breath = calm.matches ? 1 : 1.012 + 0.012 * Math.sin(time / 7000);
      const s = base.s * breath;
      return { s, x: base.cx + lean.x * 14, y: base.cy + lean.y * 10 };
    }
    const at = (v, [x, y]) => [v.x + (x - PIVOT[0]) * v.s, v.y + (y - PIVOT[1]) * v.s];

    function glow(x, y, radius, rgb, alpha) {
      if (alpha <= 0.01 || radius <= 0) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      g.addColorStop(0.35, `rgba(${rgb}, ${alpha * 0.35})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    function draw(time) {
      const dt = lastTime ? Math.min(64, time - lastTime) : 16;
      lastTime = time;
      const still = calm.matches;
      lean.x += (lean.tx - lean.x) * 0.04;
      lean.y += (lean.ty - lean.y) * 0.04;
      const v = view(time);
      if (!still && loadedAt && !spinAt && nextSpin && time >= nextSpin) spin(time);
      const turning = still ? { turn: 0, mix: 0 } : spinState(time);
      const n = turning.mix > 0 ? needle(turning.turn) : REST;

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const [x0, y0] = at(v, [0, 0]);
      const shown = loadedAt ? (still ? 1 : Math.min(1, (time - loadedAt) / 1200)) : 0;
      if (paint) {
        ctx.clearRect(0, 0, width, height);
        paint.render([x0, y0, IW * v.s, IH * v.s], { mix: turning.mix, alpha: shown, time, motion: still ? 0 : 1 });
      } else {
        ctx.fillStyle = '#031218';
        ctx.fillRect(0, 0, width, height);
      }
      if (loadedAt) {
        ctx.globalAlpha = shown;
        if (!paint) ctx.drawImage(image, x0, y0, IW * v.s, IH * v.s);
        if (!paint && turning.mix > 0) {
          ctx.globalAlpha *= turning.mix;
          ctx.drawImage(clean, x0, y0, IW * v.s, IH * v.s);
          ctx.globalAlpha = 1;
        }
        // Soften the painting's top edge where the spare height shows above it.
        if (y0 > 0) {
          const fade = ctx.createLinearGradient(0, y0, 0, y0 + 60);
          fade.addColorStop(0, 'rgba(3, 18, 24, 1)');
          fade.addColorStop(1, 'rgba(3, 18, 24, 0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = fade;
          ctx.fillRect(0, y0 - 1, width, 61);
        }
      }
      ctx.globalCompositeOperation = 'lighter';

      for (const star of stars) {
        const [x, y] = at(v, [star.x, star.y]);
        if (x < -4 || x > width + 4 || y < -4 || y > height + 4) continue;
        ctx.globalAlpha = Math.max(0, still ? star.base : star.base + Math.sin(time * star.speed + star.phase) * 0.22);
        ctx.fillStyle = '#e8f4f6';
        ctx.beginPath();
        ctx.arc(x, y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!still) {
        if (time - lastSpawn > 2600) { beads.push({ d: 0, speed: 0.11 }); lastSpawn = time; }
        for (const bead of beads) bead.d += bead.speed * dt * (0.6 + 0.8 * Math.sin(Math.min(1, bead.d / REST.total) * Math.PI) + 0.3);
        for (let i = beads.length - 1; i >= 0; i -= 1) if (beads[i].d >= REST.total) { beads.splice(i, 1); flare = 1; }
      }
      flare = Math.max(0, flare - dt / 1400);

      // While the needle turns, the painted one is faded out and this drawn one takes its place:
      // a faint thread through the beads, each bead a bright point.
      if (turning.mix > 0) {
        const alpha = turning.mix * shown;
        ctx.globalAlpha = alpha * 0.45;
        ctx.strokeStyle = `rgb(${CYAN})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        n.points.forEach((point, i) => { const [x, y] = at(v, point); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        ctx.globalAlpha = 1;
        for (let i = 1; i < n.points.length - 1; i += 1) {
          if (i === 5) continue;
          const [x, y] = at(v, n.points[i]);
          glow(x, y, 9 * v.s + 3, CYAN, 0.75 * alpha);
          glow(x, y, 2.4 * v.s + 1, '235, 252, 255', 0.9 * alpha);
        }
      }
      // The needle's beads catch the light as a bead passes.
      for (let i = 1; i < n.points.length - 1; i += 1) {
        const near = beads.reduce((best, bead) => Math.max(best, 1 - Math.abs(bead.d - n.lengths[i]) / 60), 0);
        if (near > 0) { const [x, y] = at(v, n.points[i]); glow(x, y, 16 * v.s + 6, CYAN, 0.55 * near * shown); }
      }
      for (const bead of beads) {
        for (let k = 8; k >= 0; k -= 1) {
          const [x, y] = at(v, along(n, (bead.d - k * 9) * (n.total / REST.total)));
          glow(x, y, (k ? 7 : 12) * v.s + 3, CYAN, (k ? 0.22 * (1 - k / 9) : 0.9) * shown);
        }
      }

      for (const [ex, ey, r, phase] of EYES) {
        const [x, y] = at(v, [ex, ey]);
        const pulse = still ? 0.6 : 0.5 + 0.35 * Math.sin(time / 1300 + phase);
        glow(x, y, r * 2.2 * v.s + 4, CYAN, 0.5 * pulse * shown);
      }

      const [sx, sy] = at(v, n.points[n.points.length - 1]);
      const breathe = still ? 0.6 : 0.55 + 0.2 * Math.sin(time / 900);
      const power = (breathe + flare * 0.9) * shown;
      glow(sx, sy, (34 + flare * 40) * v.s + 8, CYAN, 0.65 * power);
      glow(sx, sy, 10 * v.s + 3, '235, 252, 255', Math.min(1, power));
      ctx.globalAlpha = Math.min(1, power * 0.8);
      const spike = (70 + flare * 90) * v.s;
      for (const [dx, dy, len] of [[1, 0, spike], [0, 1, spike * 0.8]]) {
        const g = ctx.createLinearGradient(sx - dx * len, sy - dy * len, sx + dx * len, sy + dy * len);
        g.addColorStop(0, `rgba(${CYAN}, 0)`);
        g.addColorStop(0.5, `rgba(${CYAN}, 0.9)`);
        g.addColorStop(1, `rgba(${CYAN}, 0)`);
        ctx.fillStyle = g;
        if (dx) ctx.fillRect(sx - len, sy - 0.75, len * 2, 1.5);
        else ctx.fillRect(sx - 0.75, sy - len, 1.5, len * 2);
      }
      ctx.globalAlpha = 1;

      if (!still) {
        nextMeteor -= dt;
        if (!meteor && nextMeteor <= 0) {
          meteor = { x: width * (0.35 + Math.random() * 0.6), y: height * (0.02 + Math.random() * 0.2), life: 0 };
          nextMeteor = 7000 + Math.random() * 6000;
        }
        if (meteor) {
          meteor.life += dt / 1100;
          const p = meteor.life;
          const hx = meteor.x - p * width * 0.22;
          const hy = meteor.y + p * width * 0.09;
          const g = ctx.createLinearGradient(hx, hy, hx + 120, hy - 49);
          g.addColorStop(0, `rgba(${GOLD}, ${0.8 * Math.sin(Math.min(1, p) * Math.PI)})`);
          g.addColorStop(1, `rgba(${GOLD}, 0)`);
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx + 120, hy - 49);
          ctx.stroke();
          if (p >= 1) meteor = null;
        }
      }
      ctx.globalCompositeOperation = 'source-over';

      if (running && !still && visible && !document.hidden) raf = requestAnimationFrame(draw);
    }

    function start() {
      if (running) return;
      running = true;
      lastTime = 0;
      resize();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }
    function wake() { if (running && visible && !document.hidden && !calm.matches) { cancelAnimationFrame(raf); lastTime = 0; raf = requestAnimationFrame(draw); } }

    image.onload = () => { paint?.upload('uImg', image); loadedAt = performance.now(); nextSpin = loadedAt + (document.documentElement.classList.contains('intro') ? 2800 : 2200); if (!running || calm.matches) draw(loadedAt); };
    image.src = src || canvas.dataset.src;
    clean.onload = () => { paint?.upload('uClean', clean); cleanReady = true; };
    clean.src = cleanSrc || canvas.dataset.cleanSrc;
    if (paint) {
      const flow = new Image();
      flow.onload = () => { paint.upload('uFlow', flow); if (!running || calm.matches) draw(performance.now()); };
      flow.src = flowSrc || canvas.dataset.flowSrc;
    }

    function onMove(event) {
      const box = frame.getBoundingClientRect();
      lean.tx = ((event.clientX - box.left) / box.width - 0.5) * -2;
      lean.ty = ((event.clientY - box.top) / box.height - 0.5) * -2;
    }
    function onLeave() { lean.tx = 0; lean.ty = 0; }
    function onDown(event) {
      if (calm.matches || event.target.closest('a, button')) return;
      beads.push({ d: 0, speed: 0.26 }, { d: -40, speed: 0.26 }, { d: -80, speed: 0.26 });
      spin(performance.now());
    }
    frame.addEventListener('pointermove', onMove);
    frame.addEventListener('pointerleave', onLeave);
    frame.addEventListener('pointerdown', onDown);
    const sizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
    sizeObserver?.observe(canvas);
    const viewObserver = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; wake(); }) : null;
    viewObserver?.observe(canvas);
    document.addEventListener('visibilitychange', wake);
    calm.addEventListener?.('change', () => { resize(); wake(); });

    return {
      start,
      stop,
      destroy() {
        stop();
        frame.removeEventListener('pointermove', onMove);
        frame.removeEventListener('pointerleave', onLeave);
        frame.removeEventListener('pointerdown', onDown);
        sizeObserver?.disconnect();
        viewObserver?.disconnect();
        document.removeEventListener('visibilitychange', wake);
      },
    };
  };
})();
