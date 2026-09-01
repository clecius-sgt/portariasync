const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../local-ocr.js'), 'utf8');

test('local worker is reused and OCR requests never overlap', async () => {
  let created = 0, active = 0, peak = 0;
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker(lang, engine, options) {
      created++;
      assert.equal(lang, 'por');
      for (const key of ['workerPath', 'corePath', 'langPath']) assert.ok(options[key].startsWith('/vendor/ocr/'));
      return { setParameters: async () => {}, async recognize(image) {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setImmediate(r)); active--;
        return { data: { text: image, confidence: 90 } };
      } };
    }
  } });
  vm.runInContext(source, context);
  const results = await Promise.all(['first', 'second'].map(i => context.LocalOCR.recognize(i)));
  assert.deepEqual(results.map(r => r.text), ['first', 'second']);
  assert.equal(created, 1); assert.equal(peak, 1);
});

test('failed OCR terminates worker, releases queue and permits a fresh attempt', async () => {
  let created = 0, terminated = 0;
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker() {
      const id = ++created;
      return { setParameters: async () => {}, terminate: async () => { terminated++; },
        recognize: async () => { if (id === 1) throw new Error('bad image'); return { data: { text: 'ok', confidence: 90 } }; }
      };
    }
  } });
  vm.runInContext(source, context);
  await assert.rejects(context.LocalOCR.recognize('bad'), /bad image/);
  assert.equal((await context.LocalOCR.recognize('good')).text, 'ok');
  assert.equal(created, 2); assert.equal(terminated, 1);
});

test('a hung recognition times out and a new attempt can recover', async () => {
  let timeout, terminated = false, created = 0;
  const context = vm.createContext({ setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {}, Tesseract: {
    async createWorker() {
      const id = ++created;
      return { setParameters: async () => {}, terminate: async () => { terminated = true; },
        recognize: async () => id === 1 ? new Promise(() => {}) : { data: { text: 'recovered', confidence: 90 } }
      };
    }
  } });
  vm.runInContext(source, context);
  const pending = context.LocalOCR.recognize('hung');
  const rejection = assert.rejects(pending, /Tempo de leitura/);
  await new Promise(r => setImmediate(r)); timeout(); await rejection;
  assert.equal((await context.LocalOCR.recognize('next')).text, 'recovered');
  assert.equal(terminated, true);
});

test('initialization rejects with the real string error and phase, then can recover', async () => {
  let created = 0;
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker() {
      if (++created === 1) throw 'Network error while fetching language. Response code: 404';
      return { setParameters: async () => {}, recognize: async () => ({ data: { text: 'ok', confidence: 90 } }) };
    }
  } });
  vm.runInContext(source, context);
  await assert.rejects(context.LocalOCR.prepare(), error => {
    assert.equal(error.ocrPhase, 'inicialização');
    assert.match(context.LocalOCR.formatError(error), /inicialização.*Response code: 404/);
    return true;
  });
  assert.equal((await context.LocalOCR.recognize('next')).text, 'ok');
});

test('preparation and immediate manual photo share one worker and forward loading progress', async () => {
  let created = 0;
  const progress = [];
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker(lang, engine, options) {
      created++;
      options.logger({ status: 'loading language traineddata', progress: 0.5 });
      return { setParameters: async () => {}, recognize: async () => ({ data: { text: 'ok', confidence: 90 } }) };
    }
  } });
  vm.runInContext(source, context);
  const ready = context.LocalOCR.prepare(event => progress.push(context.LocalOCR.progressText(event)));
  const photo = context.LocalOCR.recognize('photo');
  await ready;
  assert.equal((await photo).text, 'ok');
  assert.equal(created, 1);
  assert.match(progress[0], /idioma português \(50%\)/);
});

test('a worker that fails parameter initialization is terminated', async () => {
  let terminated = 0;
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker() {
      return { setParameters: async () => { throw new Error('initialization failed'); }, terminate: async () => { terminated++; } };
    }
  } });
  vm.runInContext(source, context);
  await assert.rejects(context.LocalOCR.prepare(), /initialization failed/);
  assert.equal(terminated, 1);
});
