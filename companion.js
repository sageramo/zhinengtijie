/**
 * 案头伴读 · 焚香专注台（依隙定香 + 书房声景 Web Audio 合成 + 晴昼/夜雨双境伴读界面）。
 * 纯状态与界面渲染脱离 DOM 依赖，可独立单测；音频能力在不支持 Web Audio 的环境中安全降级。
 */
const HOUR = 3600000;
const MINUTE = 60000;
const OFFSET = 8 * HOUR;

export const COMPANION_PRESETS = {
  study: [15, 25, 45, 60],
  leisure: [10, 20, 30, 45],
};

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const localDateObj = ms => new Date(ms + OFFSET);
const clockText = ms => localDateObj(ms).toISOString().slice(11, 16);
const clampStep5 = (mins, lo = 10, hi = 90) => Math.max(lo, Math.min(hi, Math.floor(mins / 5) * 5));

export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function resolveScene(preference = 'auto', nowMs = Date.now()) {
  if (preference === 'day' || preference === 'dusk' || preference === 'night') return preference;
  const d = localDateObj(nowMs);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (hour >= 16 && hour < 18.75) return 'dusk';
  if (hour < 5.75 || hour >= 18.75) return 'night';
  return 'day';
}

export function companionWhisper({ mode = 'study', progress = 0, running = false, finished = false } = {}) {
  if (finished) {
    return mode === 'study'
      ? '这一炷香已尽，笔落纸静；记得饮水舒肩，已为你自动记入今日砚耕。'
      : '这一段听雨休歇刚好收尾，神思清明些了，可回到画卷看看下一件。';
  }
  if (!running && progress <= 0.001) {
    return mode === 'study'
      ? '竹影临窗，案头已为你备好纸墨。择一件事或一炷时长，按下便开香。'
      : '忙里偷闲不是虚度，坦荡歇一会，到点微磬轻响再回正轨。';
  }
  if (!running) {
    return '暂歇片刻也无妨，案前灯火与这一炷余香都还留在这里。';
  }
  if (mode === 'leisure') {
    if (progress < 0.5) return '檐雨敲竹，安心小憩或听曲，这段留白只归你自己。';
    if (progress < 0.85) return '半盏茶凉，微风刚好；再歇一会儿便轻身收心。';
    return '余香将尽，待清磬一声后，从容接回下一段日程。';
  }
  if (progress < 0.25) return '初香乍起，先写清最前头的两行，心自然就静下来了。';
  if (progress < 0.6) return '窗外山静竹微摇，我在案旁陪着你，一页一页慢慢推进。';
  if (progress < 0.9) return '香已燃过半，渐入佳境时最忌分神，一口气把这一块啃下来。';
  return '香将及末，正好收住当前这一个小节，不必匆忙赶工。';
}

/**
 * 依隙定香：结合当前时刻与画卷四层排程，为使用者推算最合适的一炷时长与转场余量。
 */
export function suggestGapSession(calendarResult, nowMs = Date.now()) {
  if (calendarResult?.layers) {
    for (const block of calendarResult.layers.work || []) {
      const s = Date.parse(block.start);
      const e = Date.parse(block.end);
      if (Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && nowMs < e) {
        const left = Math.floor((e - nowMs) / MINUTE);
        if (left >= 10) {
          const rec = clampStep5(left, 10, 90);
          return {
            kind: 'active_work',
            minutes: rec,
            gapMinutes: left,
            cushion: left - rec,
            taskId: block.task_id || null,
            taskTitle: block.title || '落笔事项',
            nextTitle: block.title || '落笔事项',
            nextClock: clockText(e),
            reason: `当前正处「${block.title || '落笔'}」排期窗口内（至 ${clockText(e)} 尚余 ${left} 分钟），建议直接燃一炷 ${rec} 分钟专注香。`,
          };
        }
      }
    }
    const fixedUpcoming = [];
    for (const layer of ['routine', 'temporary', 'appointment']) {
      for (const item of calendarResult.layers[layer] || []) {
        const s = Date.parse(item.start);
        if (Number.isFinite(s) && s > nowMs && s <= nowMs + 6 * HOUR) {
          fixedUpcoming.push({ start: s, title: item.title || '既定事项' });
        }
      }
    }
    fixedUpcoming.sort((a, b) => a.start - b.start);
    if (fixedUpcoming.length) {
      const next = fixedUpcoming[0];
      const gap = Math.floor((next.start - nowMs) / MINUTE);
      if (gap >= 15 && gap <= 120) {
        const cushion = gap < 25 ? 5 : 8;
        const rec = clampStep5(gap - cushion, 10, 90);
        return {
          kind: 'before_fixed',
          minutes: rec,
          gapMinutes: gap,
          cushion: gap - rec,
          taskId: null,
          taskTitle: null,
          nextTitle: next.title,
          nextClock: clockText(next.start),
          reason: `距「${next.title}」（${clockText(next.start)}）尚余 ${gap} 分钟，宜燃一炷 ${rec} 分钟专注香，预留 ${gap - rec} 分钟收书转场。`,
        };
      }
    }
  }
  return {
    kind: 'open',
    minutes: 45,
    gapMinutes: null,
    cushion: 0,
    taskId: null,
    taskTitle: null,
    nextTitle: null,
    nextClock: null,
    reason: '此刻留白充裕，可择一炷 45 分钟专注香，或按心境自选时长与待做事项。',
  };
}

/**
 * 零外部音频文件的 Web Audio 书房声景合成器：檐雨、松风、炉火三路混音 + 结束清磬。
 */
export function createSoundscape(win = globalThis.window) {
  let ctx = null;
  let noiseBuf = null;
  const channels = new Map();
  const levels = { rain: 0, wind: 0, hearth: 0 };

  const AudioCtor = win?.AudioContext || win?.webkitAudioContext || null;

  function ensureContext() {
    if (!AudioCtor) return null;
    if (!ctx) {
      ctx = new AudioCtor();
      const sampleRate = ctx.sampleRate || 44100;
      const len = sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, len, sampleRate);
      const data = noiseBuf.getChannelData(0);
      let b0 = 0; let b1 = 0; let b2 = 0;
      for (let i = 0; i < len; i += 1) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.0990460;
        b1 = 0.96300 * b1 + white * 0.2965164;
        b2 = 0.57000 * b2 + white * 1.0526913;
        data[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.1848) * 0.14));
      }
    }
    if (ctx.state === 'suspended') ctx.resume?.().catch(() => {});
    return ctx;
  }

  function ensureChannel(name) {
    if (channels.has(name)) return channels.get(name);
    const ac = ensureContext();
    if (!ac || !noiseBuf) return null;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const filter = ac.createBiquadFilter();
    const gain = ac.createGain();
    gain.gain.value = 0;

    if (name === 'rain') {
      filter.type = 'bandpass';
      filter.frequency.value = 1150;
      filter.Q.value = 0.65;
    } else if (name === 'wind') {
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      const lfo = ac.createOscillator();
      const lfoGain = ac.createGain();
      lfo.frequency.value = 0.16;
      lfoGain.gain.value = 170;
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start();
    } else {
      filter.type = 'lowpass';
      filter.frequency.value = 210;
    }

    src.connect(filter).connect(gain).connect(ac.destination);
    src.start();
    const entry = { src, gain, ac };
    channels.set(name, entry);
    return entry;
  }

  return {
    isSupported: () => Boolean(AudioCtor),
    setChannel(name, value01) {
      if (!(name in levels)) return;
      const clamped = Math.max(0, Math.min(1, Number(value01) || 0));
      levels[name] = clamped;
      if (clamped === 0 && !channels.has(name)) return;
      const ch = ensureChannel(name);
      if (!ch) return;
      const scale = name === 'hearth' ? 0.36 : name === 'wind' ? 0.3 : 0.28;
      ch.gain.gain.setTargetAtTime(clamped * scale, ch.ac.currentTime, 0.08);
    },
    stopAll() {
      for (const name of Object.keys(levels)) levels[name] = 0;
      for (const ch of channels.values()) {
        try { ch.gain.gain.setTargetAtTime(0, ch.ac.currentTime, 0.04); } catch { /* ignore */ }
      }
    },
    playChime() {
      const ac = ensureContext();
      if (!ac) return;
      const now = ac.currentTime;
      for (const [freq, amp] of [[528, 0.11], [792, 0.055], [1056, 0.028]]) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(amp, now + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
        osc.connect(g).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 2.45);
      }
    },
  };
}

/**
 * 随天时的连续昼夜混合：返回 dusk（暮色叠层 0..1）与 night（夜雨叠层 0..1），
 * 让西湖书房实景按北京时间从白昼缓缓溶入黄昏、夜晚与黎明。
 */
export function sceneMix(preference = 'auto', nowMs = Date.now()) {
  if (preference === 'day') return { night: 0, dusk: 0 };
  if (preference === 'dusk') return { night: 0, dusk: 1 };
  if (preference === 'night') return { night: 1, dusk: 0 };
  const d = localDateObj(nowMs);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const ramp = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
  // 白昼 07:00-16:00 -> 黄昏 16:00-17:45 渐浓 -> 入夜 17:45-19:30 -> 黎明 04:45-06:15 -> 清晨 06:15-07:00
  let dusk = 0;
  let night = 0;
  if (h >= 16 && h < 17.75) {
    dusk = ramp(h, 16, 17.75);
  } else if (h >= 17.75 && h < 19.5) {
    dusk = 1;
    night = ramp(h, 17.75, 19.5);
  } else if (h >= 19.5 || h < 4.75) {
    night = 1;
  } else if (h >= 4.75 && h < 6.25) {
    dusk = 1;
    night = 1 - ramp(h, 4.75, 6.25);
  } else if (h >= 6.25 && h < 7) {
    dusk = 1 - ramp(h, 6.25, 7);
  }
  return { night: Number(night.toFixed(3)), dusk: Number(dusk.toFixed(3)) };
}

/**
 * 渲染极简动态「案头伴读」：三时西湖实景随天时流转，左下角只留一枚细字计时与一道香线，
 * 其余设置收进可折叠的小抽屉，专注时界面自动隐去，只剩画面与时间。
 */
export function companionMarkup({
  mode = 'study',
  scenePref = 'auto',
  resolvedScene = 'day',
  mix = null,
  durationMinutes = 45,
  remainingSeconds = 2700,
  running = false,
  finished = false,
  elapsedSeconds = 0,
  round = 1,
  selectedTaskId = '',
  customTitle = '',
  suggestion = null,
  activeTasks = [],
  todayNotes = [],
  todayStats = { study: 0, leisure: 0 },
  audioLevels = { rain: 0, wind: 0, hearth: 0 },
  chimeOn = true,
  soundSupported = true,
  settlement = null,
  ledgerOpen = false,
  ledgerHtml = '',
  settingsOpen = false,
} = {}) {
  const totalSec = Math.max(60, durationMinutes * 60);
  const progress = finished ? 1 : Math.max(0, Math.min(1, 1 - remainingSeconds / totalSec));
  const remainPct = Math.max(0, Math.min(100, (1 - progress) * 100));
  const m = mix || (resolvedScene === 'night' ? { night: 1, dusk: 0 } : resolvedScene === 'dusk' ? { night: 0, dusk: 1 } : { night: 0, dusk: 0 });
  const sceneClass = resolvedScene === 'night' ? ' is-night' : resolvedScene === 'dusk' ? ' is-dusk' : ' is-day';
  const whisper = companionWhisper({ mode, progress, running, finished });
  const presets = COMPANION_PRESETS[mode] || COMPANION_PRESETS.study;
  const raining = (audioLevels.rain || 0) > 0.02 || m.night > 0.6;
  const phaseLabel = mode === 'study' ? `专注 · 第 ${round} 炷` : '休歇 · 听雨';
  const startLabel = running ? '暂歇' : (elapsedSeconds > 0 && !finished ? '继续' : '开始');

  const taskOptions = [
    '<option value="">自由陪伴（不绑定事项）</option>',
    ...activeTasks.map(t => `<option value="task:${escapeHTML(t.id)}"${selectedTaskId === `task:${t.id}` ? ' selected' : ''}>落笔 · ${escapeHTML(t.title)}${t.estimate_minutes ? `（${t.estimate_minutes}分）` : ''}</option>`),
    ...todayNotes.map(n => `<option value="note:${escapeHTML(n.id)}"${selectedTaskId === `note:${n.id}` ? ' selected' : ''}>手卷 · ${escapeHTML(n.title)}</option>`),
  ].join('');

  const gapLine = suggestion
    ? `<p class="cmp-gap" role="status"><span class="cmp-gap-badge">依隙定香</span><span>${escapeHTML(suggestion.reason)}</span>${suggestion.minutes !== durationMinutes ? `<button type="button" class="cmp-link" data-cmp-adopt-gap="${suggestion.minutes}">改用 ${suggestion.minutes} 分</button>` : ''}</p>`
    : '';

  const settlementBox = settlement
    ? `<div class="cmp-settlement" role="status">
        <strong>已收入学休账卷</strong><span>${escapeHTML(settlement.summary)}</span>
        <span class="cmp-settle-actions">
          ${settlement.mode === 'study'
            ? '<button type="button" class="cmp-link" data-cmp-switch-rest="10">歇 10 分钟</button>'
            : '<button type="button" class="cmp-link" data-cmp-switch-study="45">回到专注</button>'}
          <button type="button" class="cmp-link" data-cmp-again>再来一轮</button>
        </span>
      </div>`
    : '';

  const soundMixer = soundSupported
    ? `<div class="cmp-sliders" aria-label="书房声景">
        <label><span>檐雨</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.rain || 0) * 100)}" data-cmp-sound="rain" aria-label="檐雨音量"></label>
        <label><span>松风</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.wind || 0) * 100)}" data-cmp-sound="wind" aria-label="松风音量"></label>
        <label><span>炉火</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.hearth || 0) * 100)}" data-cmp-sound="hearth" aria-label="炉火音量"></label>
      </div>
      <label class="cmp-chime-opt"><input type="checkbox" data-cmp-chime${chimeOn ? ' checked' : ''}><i aria-hidden="true"></i><span>结束时一声清磬</span></label>`
    : '<p class="cmp-muted">当前浏览器不支持声景合成，计时与记账照常。</p>';

  return `<div class="cmp-card${sceneClass}${running ? ' is-running' : ''}${raining ? ' is-raining' : ''}" data-active-mode="${mode}" style="--night:${m.night};--dusk:${m.dusk}">
    <div class="cmp-backdrop" aria-hidden="true">
      <div class="cmp-scene">
        <img class="cmp-art cmp-art-day" src="./assets/study-desk-day.webp?v=2026.11.22.93" alt="" width="1024" height="576">
        <img class="cmp-art cmp-art-dusk" src="./assets/study-desk-dusk.webp?v=2026.11.22.93" alt="" width="1024" height="576">
        <img class="cmp-art cmp-art-night" src="./assets/study-desk-night.webp?v=2026.11.22.93" alt="" width="1024" height="576">
      </div>
      <div class="cmp-light"></div>
      <div class="cmp-rain"></div>
      <div class="cmp-lamp-glow"></div>
      <svg class="cmp-smoke" viewBox="0 0 60 120" fill="none">
        <path class="s1" d="M30 112 C22 88, 40 68, 28 42 C20 24, 34 12, 26 2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
        <path class="s2" d="M32 110 C42 86, 22 62, 35 38 C42 22, 26 10, 34 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <div class="cmp-vignette"></div>
    </div>

    <header class="cmp-top">
      <div class="cmp-seg" role="group" aria-label="伴读状态">
        <button type="button" data-cmp-mode="study" aria-pressed="${mode === 'study'}">专注</button>
        <button type="button" data-cmp-mode="leisure" aria-pressed="${mode === 'leisure'}">休歇</button>
      </div>
      <div class="cmp-top-right">
        <div class="cmp-seg is-quiet" role="group" aria-label="景致">
          <button type="button" data-cmp-scene="auto" aria-pressed="${scenePref === 'auto'}">随天时</button>
          <button type="button" data-cmp-scene="day" aria-pressed="${scenePref === 'day'}">昼</button>
          <button type="button" data-cmp-scene="dusk" aria-pressed="${scenePref === 'dusk'}">暮</button>
          <button type="button" data-cmp-scene="night" aria-pressed="${scenePref === 'night'}">夜</button>
        </div>
        <button type="button" class="cmp-icon" data-cmp-settings aria-expanded="${settingsOpen}" title="事项与声景">设置</button>
        <button type="button" class="cmp-icon" data-cmp-fullscreen title="全屏沉浸">全屏</button>
        <button type="button" class="cmp-icon" data-cmp-close aria-label="关闭案头伴读">收起</button>
      </div>
    </header>

    <aside class="cmp-drawer${settingsOpen ? ' is-open' : ''}" aria-label="事项与声景">
      ${gapLine}
      <div class="cmp-bind">
        <select id="cmpTaskSelect" aria-label="关联当前事项">${taskOptions}</select>
        <input id="cmpTitleInput" type="text" maxlength="80" value="${escapeHTML(customTitle)}" placeholder="${mode === 'study' ? '此刻专注之事（可选）' : '休歇做什么（可选）'}">
      </div>
      ${soundMixer}
    </aside>

    <section class="cmp-hud">
      <p class="cmp-phase">${phaseLabel}</p>
      <div class="cmp-clock" id="cmpClock" aria-live="off">${formatClock(remainingSeconds)}</div>
      <div class="cmp-incense" aria-label="一炷香进度"><div class="cmp-incense-track"><i id="cmpIncenseFill" style="width:${remainPct.toFixed(2)}%"></i></div></div>
      <p class="cmp-whisper" id="cmpWhisper">${escapeHTML(whisper)}</p>
      <div class="cmp-controls">
        <button type="button" class="cmp-primary" data-cmp-toggle>${startLabel}</button>
        <button type="button" class="cmp-link" data-cmp-finish${elapsedSeconds > 0 || finished ? '' : ' disabled'}>${mode === 'study' ? '收香记账' : '结束记账'}</button>
        <button type="button" class="cmp-link" data-cmp-reset>重来</button>
        <span class="cmp-presets" role="group" aria-label="时长">${presets.map(min => `<button type="button" data-cmp-minutes="${min}" aria-pressed="${durationMinutes === min}">${min}</button>`).join('')}<em>分</em></span>
      </div>
      ${settlementBox}
    </section>

    <footer class="cmp-foot">
      <span>今日砚耕 <b>${todayStats.study}</b> 分 · 今日闲暇 <b>${todayStats.leisure}</b> 分</span>
      <button type="button" class="cmp-link cmp-ledger-toggle" data-cmp-ledger-toggle aria-expanded="${ledgerOpen}">${ledgerOpen ? '收起账卷' : '本周学休账卷'}</button>
    </footer>
    ${ledgerOpen && ledgerHtml ? `<div class="cmp-ledger-drawer">${ledgerHtml}</div>` : ''}
  </div>`;
}
