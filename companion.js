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
  if (preference === 'day' || preference === 'night') return preference;
  const hour = localDateObj(nowMs).getUTCHours();
  return hour < 6 || hour >= 18 ? 'night' : 'day';
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
 * 渲染沉浸式「案头伴读 · 焚香专注台」弹窗画板。
 */
export function companionMarkup({
  mode = 'study',
  scenePref = 'auto',
  resolvedScene = 'day',
  durationMinutes = 45,
  remainingSeconds = 2700,
  running = false,
  finished = false,
  elapsedSeconds = 0,
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
} = {}) {
  const totalSec = Math.max(60, durationMinutes * 60);
  const progress = finished ? 1 : Math.max(0, Math.min(1, 1 - remainingSeconds / totalSec));
  const remainPct = Math.max(0, Math.min(100, (1 - progress) * 100));
  const isNight = resolvedScene === 'night';
  const whisper = companionWhisper({ mode, progress, running, finished });
  const presets = COMPANION_PRESETS[mode] || COMPANION_PRESETS.study;

  const taskOptions = [
    '<option value="">不绑定特定落笔（自由陪伴）</option>',
    ...activeTasks.map(t => `<option value="task:${escapeHTML(t.id)}"${selectedTaskId === `task:${t.id}` ? ' selected' : ''}>落笔 · ${escapeHTML(t.title)}${t.estimate_minutes ? `（${t.estimate_minutes}分）` : ''}</option>`),
    ...todayNotes.map(n => `<option value="note:${escapeHTML(n.id)}"${selectedTaskId === `note:${n.id}` ? ' selected' : ''}>手卷 · ${escapeHTML(n.title)}</option>`),
  ].join('');

  const gapBanner = suggestion
    ? `<div class="cmp-gap" role="status">
        <span class="cmp-gap-badge">依隙定香</span>
        <p>${escapeHTML(suggestion.reason)}</p>
        ${suggestion.minutes !== durationMinutes ? `<button type="button" class="cmp-gap-adopt" data-cmp-adopt-gap="${suggestion.minutes}">改用 ${suggestion.minutes} 分钟</button>` : ''}
      </div>`
    : '';

  const finishActionLabel = mode === 'study' ? '收香记账' : '结束休歇并记账';
  const settlementBox = settlement
    ? `<div class="cmp-settlement" role="status">
        <strong>已收入学休账卷</strong>
        <p>${escapeHTML(settlement.summary)}</p>
        <div class="cmp-settle-actions">
          ${settlement.mode === 'study'
            ? '<button type="button" data-cmp-switch-rest="10">转入 10 分钟听雨休歇</button>'
            : '<button type="button" data-cmp-switch-study="45">切回焚香砚耕</button>'}
          <button type="button" data-cmp-again>再启一轮</button>
        </div>
      </div>`
    : '';

  const soundMixer = soundSupported
    ? `<section class="cmp-sound" aria-label="书房声景">
        <div class="cmp-sound-head">
          <span>书房声景</span>
          <label class="cmp-chime-opt"><input type="checkbox" data-cmp-chime${chimeOn ? ' checked' : ''}><span>收香清磬提示</span></label>
        </div>
        <div class="cmp-sliders">
          <label><span>檐雨</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.rain || 0) * 100)}" data-cmp-sound="rain" aria-label="檐雨音量"></label>
          <label><span>松风</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.wind || 0) * 100)}" data-cmp-sound="wind" aria-label="松风音量"></label>
          <label><span>炉火</span><input type="range" min="0" max="100" value="${Math.round((audioLevels.hearth || 0) * 100)}" data-cmp-sound="hearth" aria-label="炉火音量"></label>
        </div>
      </section>`
    : `<section class="cmp-sound is-fallback"><p>当前环境暂不支持在线合成白噪音，专注计时与自动记账仍正常生效。</p></section>`;

  return `<div class="cmp-card${isNight ? ' is-night' : ' is-day'}${running ? ' is-running' : ''}" data-active-mode="${mode}">
    <div class="cmp-backdrop" aria-hidden="true">
      <img class="cmp-art cmp-art-day" src="./assets/study-desk-day.webp" alt="" width="1024" height="576">
      <img class="cmp-art cmp-art-night" src="./assets/study-desk-night.webp" alt="" width="1024" height="576">
      <div class="cmp-lamp-glow"></div>
      <svg class="cmp-smoke" viewBox="0 0 60 120" fill="none">
        <path class="s1" d="M30 112 C22 88, 40 68, 28 42 C20 24, 34 12, 26 2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
        <path class="s2" d="M32 110 C42 86, 22 62, 35 38 C42 22, 26 10, 34 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="cmp-panel">
      <header class="cmp-head">
        <div class="cmp-switch" role="group" aria-label="伴读状态">
          <button type="button" data-cmp-mode="study" aria-pressed="${mode === 'study'}">焚香砚耕</button>
          <button type="button" data-cmp-mode="leisure" aria-pressed="${mode === 'leisure'}">听雨休歇</button>
        </div>
        <div class="cmp-scene-switch" role="group" aria-label="景致">
          <button type="button" data-cmp-scene="auto" aria-pressed="${scenePref === 'auto'}">随天时</button>
          <button type="button" data-cmp-scene="day" aria-pressed="${scenePref === 'day'}">晴昼</button>
          <button type="button" data-cmp-scene="night" aria-pressed="${scenePref === 'night'}">夜雨</button>
        </div>
        <div class="cmp-win-actions">
          <button type="button" class="cmp-icon-btn" data-cmp-fullscreen title="全屏沉浸">全屏</button>
          <button type="button" class="cmp-icon-btn" data-cmp-close aria-label="关闭案头伴读">收卷</button>
        </div>
      </header>
      ${gapBanner}
      <div class="cmp-bind">
        <select id="cmpTaskSelect" aria-label="关联当前事项">${taskOptions}</select>
        <input id="cmpTitleInput" type="text" maxlength="80" value="${escapeHTML(customTitle)}" placeholder="${mode === 'study' ? '手写此刻专注之事（可选）' : '休歇消遣（如：听曲 / 散步 / 小憩）'}">
      </div>
      <div class="cmp-timer-stage">
        <div class="cmp-clock" id="cmpClock" aria-live="off">${formatClock(remainingSeconds)}</div>
        <div class="cmp-incense" aria-label="一炷香进度">
          <span class="cmp-incense-tip"></span>
          <div class="cmp-incense-track"><i id="cmpIncenseFill" style="width:${remainPct.toFixed(2)}%"></i></div>
        </div>
        <p class="cmp-whisper" id="cmpWhisper">${escapeHTML(whisper)}</p>
      </div>
      <div class="cmp-presets" role="group" aria-label="时长选择">
        ${presets.map(m => `<button type="button" data-cmp-minutes="${m}" aria-pressed="${durationMinutes === m}">${m} 分钟</button>`).join('')}
      </div>
      <div class="cmp-controls">
        <button type="button" class="primary-button cmp-start" data-cmp-toggle>${running ? '暂歇一会' : (elapsedSeconds > 0 && !finished ? '继续燃香' : (mode === 'study' ? '燃香开始' : '开始休歇'))}</button>
        <button type="button" data-cmp-finish${elapsedSeconds > 0 || finished ? '' : ' disabled'}>${finishActionLabel}</button>
        <button type="button" class="text-button" data-cmp-reset>重整</button>
      </div>
      ${settlementBox}
      ${soundMixer}
      <footer class="cmp-foot">
        <span>今日砚耕 <b>${todayStats.study}</b> 分 · 今日闲暇 <b>${todayStats.leisure}</b> 分</span>
      </footer>
    </div>
  </div>`;
}
