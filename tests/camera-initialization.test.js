const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const source = html.slice(html.indexOf('let uniStream ='), html.indexOf("window.addEventListener('pagehide'"));

function harness() {
  const elements = new Map();
  let resolve, reject, captures = 0, stopped = 0, nativePhotos = 0;
  const readiness = new Promise((yes, no) => { resolve = yes; reject = no; });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, textContent: '', value: '', remove() {}, click() { nativePhotos++; },
      videoWidth: 1280, videoHeight: 720, readyState: 4, play: async () => {}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) } },
    document: { getElementById: element, createElement: () => ({ getContext: () => ({}) }) },
    LocalOCR: { prepare: () => readiness, progressText: () => 'Preparando leitor' },
    LabelCapture: { create() { captures++; return { stop() {} }; } },
    limparMoradorSelecionado() {}, atualizarCadastroEncomenda() {}, toast() {},
    mensagemFalhaOCR: error => String(error?.message || error)
  });
  vm.runInContext(source, context);
  return { context, element, resolve, reject, captures: () => captures, stopped: () => stopped,
    nativePhotos: () => nativePhotos, run: code => vm.runInContext(code, context) };
}

test('camera displays preparation before starting automatic recognition', async () => {
  const h = harness();
  const opening = h.run('abrirCameraUnificada()');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.element('uniStatus').textContent, /Preparando o leitor/);
  assert.equal(h.captures(), 0);
  h.resolve(); await opening;
  assert.equal(h.captures(), 1);
});

test('initialization failure remains in camera instead of silently opening native photo', async () => {
  const h = harness();
  const opening = h.run('abrirCameraUnificada()');
  await new Promise(resolve => setImmediate(resolve));
  h.reject('Failed to construct Worker'); await opening;
  assert.match(h.element('uniStatus').textContent, /Failed to construct Worker/);
  assert.equal(h.element('modalUnificado').style.display, 'flex');
  assert.equal(h.captures(), 0);
  assert.equal(h.nativePhotos(), 0);
});

test('closing camera during preparation never starts a stale capture session', async () => {
  const h = harness();
  const opening = h.run('abrirCameraUnificada()');
  await new Promise(resolve => setImmediate(resolve));
  h.run('fecharCameraUnificada()');
  h.resolve(); await opening;
  assert.equal(h.captures(), 0);
  assert.equal(h.stopped(), 1);
  assert.equal(h.element('modalUnificado').style.display, 'none');
});
