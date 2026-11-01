import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOcrText, imageProblem, createRecognizer, OCR_PATHS, MAX_IMAGE_BYTES } from '../screenshot-ocr.js';

function fakeEngine(text = '报 名 截 止 ： 3 月 26 日', calls = []) {
  return {
    async createWorker(lang, oem, options) {
      calls.push({ lang, oem, options });
      return {
        async recognize(image) { calls.push({ image }); options.logger({ status: 'recognizing text', progress: 0.5 }); return { data: { text } }; },
        async terminate() { calls.push('terminate'); },
      };
    },
  };
}

test('OCR spacing between Chinese characters and blank layout lines are removed; line breaks and Latin words stay', () => {
  assert.equal(normalizeOcrText('报 名 截 止 ： 3 月 26 日 下 午 3:00 前\n\n\n地 点 ： M234 教 室 \n'), '报名截止：3月26日下午3:00前\n地点：M234教室');
  assert.equal(normalizeOcrText('APP 报 名'), 'APP报名');
  assert.equal(normalizeOcrText('Hello world'), 'Hello world');
});

test('only bounded image files are accepted', () => {
  assert.equal(imageProblem({ type: 'image/png', size: 1000 }), null);
  assert.match(imageProblem({ type: 'application/pdf', size: 1000 }), /图片/);
  assert.match(imageProblem({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), /10MB/);
  assert.match(imageProblem({ type: 'image/png', size: 0 }), /空/);
});

test('the recognizer uses only local paths, reports progress and reuses one worker', async () => {
  const calls = [];
  const progress = [];
  const recognize = createRecognizer(async () => fakeEngine(undefined, calls));
  assert.equal(await recognize({ type: 'image/png', size: 10 }, value => progress.push(value)), '报名截止：3月26日');
  await recognize({ type: 'image/png', size: 10 }, () => {});
  const created = calls.filter(call => call.lang);
  assert.equal(created.length, 1);
  assert.equal(created[0].lang, 'chi_sim');
  for (const key of ['workerPath', 'corePath', 'langPath']) {
    assert.equal(created[0].options[key], OCR_PATHS[key]);
    assert.doesNotMatch(created[0].options[key], /^https?:|cdn|jsdelivr|unpkg/);
  }
  assert.match(OCR_PATHS.corePath, /simd-lstm\.wasm\.js$/);
  assert.ok(progress.some(value => value > 0 && value <= 1));
});

test('a failed engine load is reported and the next attempt can retry', async () => {
  let attempts = 0;
  const recognize = createRecognizer(async () => { attempts += 1; if (attempts === 1) throw new Error('load failed'); return fakeEngine('好'); });
  await assert.rejects(recognize({ type: 'image/png', size: 10 }, () => {}), /load failed/);
  assert.equal(await recognize({ type: 'image/png', size: 10 }, () => {}), '好');
});

test('an invalid image is rejected before the engine is loaded', async () => {
  let loaded = false;
  const recognize = createRecognizer(async () => { loaded = true; return fakeEngine(); });
  await assert.rejects(recognize({ type: 'text/plain', size: 10 }, () => {}), /图片/);
  assert.equal(loaded, false);
});
