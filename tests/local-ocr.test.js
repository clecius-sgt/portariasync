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

test('fast mobile OCR performs one local pass without expensive detail passes', async () => {
  let recognitions = 0;
  const context = vm.createContext({ setTimeout, clearTimeout, Tesseract: {
    async createWorker() {
      return {
        setParameters: async () => {},
        recognize: async () => {
          recognitions++;
          return { data: { text: 'Lucimara\nRua Brasilia 311', confidence: 52 } };
        }
      };
    }
  } });
  vm.runInContext(source, context);
  const result = await context.LocalOCR.recognizeFast('photo');
  assert.equal(recognitions, 1);
  assert.equal(result.engine, 'tesseract-mobile');
  assert.equal(result.mode, 'fast');
});

test('mobile OCR is the primary route when local reading is sufficient', async () => {
  let serverCalls = 0;
  let received;
  const context = vm.createContext({ setTimeout, clearTimeout, console, Tesseract: {
    async createWorker() {
      return {
        setParameters: async () => {},
        recognize: async () => ({ data: { text: 'Lucimara Gonçalves Salomé\nRua Brasilia 311', confidence: 92 } })
      };
    }
  } });
  vm.runInContext(source, context);
  const host = {
    console,
    LabelCapture: { recognizeWithPaddle: async () => { serverCalls++; throw new Error('server should not run'); } },
    enviarParaOCR: async (...args) => { received = args; return 'ok'; }
  };
  assert.equal(context.LocalOCR.installMobileFirstFallback(host), true);
  const value = await host.enviarParaOCR('data:image/jpeg;base64,ZmFrZQ==', { textContent: '' }, null, '', 11);
  assert.equal(value, 'ok');
  assert.equal(serverCalls, 0);
  assert.equal(received[4], 11);
  assert.equal(received[5].engine, 'tesseract-mobile');
  assert.equal(received[5].route, 'mobile');
});

test('low-confidence mobile OCR automatically falls back to PaddleOCR server', async () => {
  let serverCalls = 0;
  let received;
  const context = vm.createContext({ setTimeout, clearTimeout, console, Tesseract: {
    async createWorker() {
      return {
        setParameters: async () => {},
        recognize: async () => ({ data: { text: 'Lucimara\nRua Brasilia 311', confidence: 54 } })
      };
    }
  } });
  vm.runInContext(source, context);
  const host = {
    console,
    LabelCapture: {
      recognizeWithPaddle: async () => {
        serverCalls++;
        return { text: 'Lucimara Gonçalves Salomé\nRua Brasilia 311', confidence: 96, lines: [] };
      }
    },
    enviarParaOCR: async (...args) => { received = args; return 'ok'; }
  };
  context.LocalOCR.installMobileFirstFallback(host);
  await host.enviarParaOCR('data:image/jpeg;base64,ZmFrZQ==', { textContent: '' }, null, '', 12);
  assert.equal(serverCalls, 1);
  assert.equal(received[5].engine, 'paddleocr');
  assert.equal(received[5].route, 'server-fallback');
  assert.equal(received[5].fallbackUsed, true);
  assert.equal(received[5].mobileConfidence, 54);
});

test('if server fallback fails, usable mobile text is retained for manual confirmation', async () => {
  let received;
  const context = vm.createContext({ setTimeout, clearTimeout, console, Tesseract: {
    async createWorker() {
      return {
        setParameters: async () => {},
        recognize: async () => ({ data: { text: 'Lucimara\nRua Brasilia 311', confidence: 54 } })
      };
    }
  } });
  vm.runInContext(source, context);
  const host = {
    console,
    LabelCapture: { recognizeWithPaddle: async () => { throw new Error('offline'); } },
    enviarParaOCR: async (...args) => { received = args; return 'ok'; }
  };
  context.LocalOCR.installMobileFirstFallback(host);
  await host.enviarParaOCR('data:image/jpeg;base64,ZmFrZQ==', { textContent: '' }, null, '', 13);
  assert.equal(received[5].engine, 'tesseract-mobile');
  assert.equal(received[5].route, 'mobile-degraded');
  assert.equal(received[5].confidence, 54);
});
