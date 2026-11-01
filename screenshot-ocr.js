/** Local screenshot OCR. Images never leave the browser; the text is only a draft for the user to correct. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const base = new URL('./vendor/tesseract/', import.meta.url);
// corePath names one build directly: the bundled engine is SIMD+LSTM only (see vendor/tesseract/VENDOR.md).
export const OCR_PATHS = {
  workerPath: new URL('worker.min.js', base).pathname,
  corePath: new URL('tesseract-core-simd-lstm.wasm.js', base).pathname,
  langPath: new URL('lang', base).pathname,
};
const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t]+|[ \\t]+(?=[${CJK}])`, 'g');

/** Tesseract separates Chinese characters with spaces and paragraphs with blank lines; Latin words keep their spaces. */
export function normalizeOcrText(text) {
  return String(text).split('\n').map(line => line.replace(CJK_GAP, '').trim()).filter(Boolean).join('\n');
}

export function imageProblem(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) return '请选择PNG、JPG、WebP、GIF或BMP格式的图片。';
  if (!file.size) return '图片是空文件，请重新截图。';
  if (file.size > MAX_IMAGE_BYTES) return '图片超过10MB，请裁剪到通知部分后再试。';
  return null;
}

const loadBundledEngine = () => import('./vendor/tesseract/tesseract.esm.min.js').then(module => module.default || module);

/** One worker is created on first use and reused; a failed load is not cached so the user can retry. */
export function createRecognizer(loadEngine = loadBundledEngine) {
  let workerPromise = null;
  let report = () => {};
  return async function recognize(image, onProgress) {
    const problem = imageProblem(image);
    if (problem) throw new Error(problem);
    report = onProgress;
    workerPromise ||= (async () => {
      const engine = await loadEngine();
      return engine.createWorker('chi_sim', 1, {
        ...OCR_PATHS, workerBlobURL: false,
        logger: message => { if (typeof message.progress === 'number') report(Math.min(1, Math.max(0, message.progress)), message.status); },
      });
    })().catch(error => { workerPromise = null; throw error; });
    const worker = await workerPromise;
    const { data } = await worker.recognize(image);
    return normalizeOcrText(data?.text ?? '');
  };
}
