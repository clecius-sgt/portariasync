const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const metrics = require('../ocr-metrics');

function storageMock() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('evento OCR guarda apenas metadados técnicos e descarta dados pessoais', () => {
  const event = metrics.createEvent({
    id: 'evt-1',
    at: '2026-09-02T20:00:00Z',
    route: 'mobile',
    elapsedMs: 1200,
    addressResolved: true,
    candidateFound: true,
    nome: 'Lucimara Gonçalves Salomé',
    endereco: 'Rua Brasilia 311',
    texto: 'conteúdo OCR',
    foto: 'data:image/jpeg;base64,AAA'
  }, null, new Date('2026-09-02T20:00:00Z'));

  assert.equal(event.route, 'mobile');
  assert.equal(event.addressResolved, true);
  assert.equal(event.candidateFound, true);
  assert.equal('nome' in event, false);
  assert.equal('endereco' in event, false);
  assert.equal('texto' in event, false);
  assert.equal('foto' in event, false);
});

test('resumo de 30 dias calcula uso do celular, fallback, falhas e tempo médio', () => {
  const store = {
    events: [
      { id: '1', at: '2026-09-02T10:00:00Z', route: 'mobile', elapsedMs: 1000, addressResolved: true, candidateFound: true },
      { id: '2', at: '2026-09-02T11:00:00Z', route: 'server-fallback', elapsedMs: 3000, serverElapsedMs: 1800, fallbackUsed: true, addressResolved: true, candidateFound: true },
      { id: '3', at: '2026-09-02T12:00:00Z', route: 'mobile-degraded', elapsedMs: 2000, addressResolved: false, candidateFound: true },
      { id: '4', at: '2026-09-02T13:00:00Z', route: 'failed', elapsedMs: 4000, failed: true }
    ]
  };
  const summary = metrics.summarize(store, 30, new Date('2026-09-03T00:00:00Z'));
  assert.equal(summary.total, 4);
  assert.equal(summary.mobile, 1);
  assert.equal(summary.serverFallback, 1);
  assert.equal(summary.degraded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.addressRate, 50);
  assert.equal(summary.candidateRate, 75);
  assert.equal(summary.fallbackRate, 25);
  assert.equal(summary.avgElapsedMs, 2500);
  assert.equal(summary.avgServerElapsedMs, 1800);
});

test('sincronização une eventos por id sem duplicar leituras', () => {
  const now = new Date('2026-09-03T00:00:00Z');
  const local = { events: [
    { id: 'a', at: '2026-09-02T10:00:00Z', route: 'mobile' },
    { id: 'b', at: '2026-09-02T11:00:00Z', route: 'mobile' }
  ] };
  const remote = { events: [
    { id: 'b', at: '2026-09-02T11:00:00Z', route: 'mobile' },
    { id: 'c', at: '2026-09-02T12:00:00Z', route: 'server-fallback', fallbackUsed: true }
  ] };
  const merged = metrics.merge(local, remote, now);
  assert.deepEqual(merged.events.map(event => event.id), ['c', 'b', 'a']);
});

test('instrumentação contabiliza leitura mobile com endereço reconhecido', async () => {
  const localStorage = storageMock();
  let syncs = 0;
  const host = {
    localStorage,
    RecipientMatching: {
      match() { return { enderecoExtraido: 'Rua Brasilia 311', candidatoPrincipal: { id: '1' }, candidatos: [{ morador: { id: '1' } }] }; }
    },
    LabelCapture: { recognizeWithPaddle: async () => ({ text: 'servidor' }) },
    enviarParaOCR: async function() {
      this.RecipientMatching.match('Lucimara Rua Brasilia 311', []);
      return 'ok';
    },
    montarEstadoApp() { return { configPublica: {} }; },
    aplicarEstadoApp() {},
    agendarSyncEstadoServidor() { syncs++; }
  };

  assert.equal(metrics.install(host), true);
  await host.enviarParaOCR('imagem', {}, null, '', 1);
  const summary = host.OcrMetricsRuntime.summarize(30);
  assert.equal(summary.total, 1);
  assert.equal(summary.mobile, 1);
  assert.equal(summary.addressRate, 100);
  assert.equal(summary.candidateRate, 100);
  assert.ok(syncs >= 1);
  assert.ok(host.montarEstadoApp().configPublica.metricasOcr.events.length >= 1);
});

test('instrumentação identifica fallback PaddleOCR sem guardar o conteúdo reconhecido', async () => {
  const host = {
    localStorage: storageMock(),
    RecipientMatching: {
      match() { return { enderecoExtraido: 'Rua Brasilia 311', candidatoPrincipal: { id: '1' }, candidatos: [] }; }
    },
    LabelCapture: { recognizeWithPaddle: async () => ({ text: 'Lucimara Gonçalves Salomé', confidence: 96 }) },
    enviarParaOCR: async function() {
      await this.LabelCapture.recognizeWithPaddle('imagem');
      this.RecipientMatching.match('texto final', []);
      return 'ok';
    },
    montarEstadoApp() { return { configPublica: {} }; },
    aplicarEstadoApp() {},
    agendarSyncEstadoServidor() {}
  };

  metrics.install(host);
  await host.enviarParaOCR('imagem', {}, null, '', 2);
  const store = host.OcrMetricsRuntime.get();
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].route, 'server-fallback');
  assert.equal(store.events[0].fallbackUsed, true);
  assert.equal('text' in store.events[0], false);
});

test('aplicação carrega coletor e painel administrativo expõe métricas de 30 dias', () => {
  const localOcr = fs.readFileSync(path.join(__dirname, '..', 'local-ocr.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  assert.match(localOcr, /ocr-metrics\.js\?v=20260902-1/);
  assert.match(localOcr, /ocrMetricsLoader:\s*true/);
  assert.match(localOcr, /version:\s*'2026-09-02\.7'/);
  assert.match(adminHtml, /Métricas do OCR/);
  assert.match(adminHtml, /ocrMetricAddressRate/);
  assert.match(adminHtml, /sem foto da etiqueta, nome, endereço ou texto reconhecido/i);
  assert.match(adminJs, /configPublica\?\.metricasOcr/);
  assert.match(adminJs, /summarizeOcrMetrics\(metrics, 30\)/);
});
