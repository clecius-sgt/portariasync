const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const matching = require('../recipient-matching');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const defaults = JSON.parse(html.match(/let _moradores_default = (\[.*\]);/)[1]);
const carlos = { id: 'test-carlos', nome: 'Carlos Augusto', casa: 'QD06LT04 - Rua Londres, 160' };
const label = 'Carlos Augusto\nRua Londres 160';

test('example label is not silently assigned to a different resident at the same home', () => {
  const result = matching.match(label, defaults);
  assert.equal(result.nomeExtraido, 'Carlos Augusto');
  assert.equal(result.confiavel, false);
  assert.equal(result.morador, null);
  assert.equal(result.candidatos[0].morador.id, '1087');
  assert.match(result.motivo, /nome lido n/);
});

test('same label identifies Carlos only when his own matching record exists', () => {
  assert.equal(matching.match(label, [...defaults, carlos]).morador.id, carlos.id);
});

test('name and address from a hub cannot override recipient block', () => {
  const text = 'Avenida Arthur Antonio Sendas, 6A\nPredio 500\nBR\n1 tentativa de entrega\n' + label + '\nRes D italia Colina Sul\nBady Bassitt SP 15115000 Brazil\nTBR123456789';
  assert.equal(matching.match(text, [carlos]).morador.id, carlos.id);
});

for (const [name, text] of Object.entries({
  'partial name': 'Carlos Augusto\nRua Londres 160',
  'OCR typo': 'Carlos Auguslo\nRua Londres 160',
  'only address': 'Rua Londres 160',
  'only name': 'Carlos Augusto Silva',
  'wrong number': 'Carlos Augusto Silva\nRua Londres 161',
  'wrong street': 'Carlos Augusto Silva\nRua Lisboa 160',
  'single name': 'Carlos\nRua Londres 160',
  'barcode only': 'TBR123456789',
  'empty text': '',
  'sender only': 'Remetente: Carlos Augusto Silva\nRua Londres 160',
  'different recipient': 'Remetente: Carlos Augusto Silva\nRua Londres 160\nDestinatario: Maria Oliveira\nRua Madri 12'
})) {
  test(name + ' requires confirmation', () => {
    assert.equal(matching.match(text, [{ ...carlos, nome: 'Carlos Augusto Silva' }]).confiavel, false);
  });
}

test('typo can suggest a candidate without auto-selecting', () => {
  const result = matching.match('Carlos Auguslo\nRua Londres 160', [carlos]);
  assert.equal(result.confiavel, false);
  assert.equal(result.candidatos[0].morador.id, carlos.id);
});

test('same-name records at the same address require confirmation', () => {
  assert.equal(matching.match(label, [carlos, { ...carlos, id: 'duplicate' }]).confiavel, false);
});

test('same-name records at different addresses can be disambiguated', () => {
  assert.equal(matching.match(label, [carlos, { ...carlos, id: 'other', casa: 'Rua Londres 161' }]).morador.id, carlos.id);
});

test('very similar names at the same address require confirmation', () => {
  assert.equal(matching.match(label, [carlos, { ...carlos, id: 'other', nome: 'Carlos Augusta' }]).confiavel, false);
});

test('short names and accents are retained', () => {
  const m = { id: 'ana', nome: 'Ana Lu\u00edsa', casa: 'Rua Roma 7' };
  assert.equal(matching.match('ANA LUISA\nR. Roma, 7', [m]).morador.id, 'ana');
});

test('name wrapping is supported without scanning arbitrary label tokens', () => {
  const m = { ...carlos, nome: 'Carlos Augusto Silva Oliveira' };
  assert.equal(matching.match('Destinatario:\nCarlos Augusto\nSilva Oliveira\nRua Londres 160', [m]).morador.id, m.id);
});

test('sender block following recipient is excluded', () => {
  const text = label + '\nRemetente: Joao Ribeiro\nRua Roma 7';
  assert.equal(matching.match(text, [carlos, { id: 'sender', nome: 'Joao Ribeiro', casa: 'Rua Roma 7' }]).morador.id, carlos.id);
});

test('two distinct recipient blocks do not silently select either person', () => {
  const text = label + '\nDestinatario: Joao Ribeiro\nRua Roma 7\nDestinatario: Carlos Augusto\nRua Londres 160';
  assert.equal(matching.match(text, [carlos, { id: 'other', nome: 'Joao Ribeiro', casa: 'Rua Roma 7' }]).confiavel, false);
});

test('unmarked sender matching database cannot override an unknown recipient', () => {
  assert.equal(matching.match(label + '\nMaria Oliveira\nRua Roma 7', [carlos]).confiavel, false);
});

for (const value of ['Rua Londres, 160', 'QD06LT04 - Rua Londres, 160', 'Rua Londres n 160', 'R. Londres 160']) {
  test('street number is parsed after street: ' + value, () => {
    assert.equal(matching.address(value).number, '160');
    assert.equal(matching.address(value).street, 'rua londres');
  });
}

test('compound streets, avenue abbreviations, and numeric streets', () => {
  assert.equal(matching.address('Av. Arthur Antonio Sendas, 6A').number, '6a');
  assert.equal(matching.address('Av Arthur Antonio Sendas, 6A').street, 'avenida arthur antonio sendas');
  assert.equal(matching.address('Rua 15 de Novembro, 12').number, '12');
});

for (const [suffix, confident] of [['', false], [' Apto 91', false], [' Apto 92', true], ['\nApartamento 92', true]]) {
  test('apartment validation ' + JSON.stringify(suffix), () => {
    assert.equal(matching.match(label + suffix, [{ ...carlos, casa: 'Rua Londres 160 Apto 92' }]).confiavel, confident);
  });
}

test('empty resident database fails closed', () => {
  const result = matching.match(label, []);
  assert.equal(result.morador, null);
  assert.match(result.motivo, /vazio/);
});

test('scripts compile and matcher is loaded before inline application', () => {
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  assert.ok(html.indexOf('src="recipient-matching.js"') < html.indexOf('// ========== BACKEND'));
});

test('all repository residents match their own complete name and address, never another record', () => {
  for (const resident of defaults) {
    const result = matching.match(resident.nome + '\n' + resident.casa, defaults);
    assert.equal(result.morador?.id, resident.id);
  }
});

function workflow() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, textContent: '', innerHTML: '', remove() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, AbortSignal, FormData, RecipientMatching: matching,
    document: { getElementById: element },
    moradores: [carlos], authToken: 'test', backendAuthDisponivel: true,
    moradorSelecionadoId: carlos.id, encomendas: [],
    atualizarCadastroEncomenda() {},
    limparMoradorSelecionado() { context.moradorSelecionadoId = null; },
    selecionarMorador(id) { context.moradorSelecionadoId = id; },
    extrairCodigoEtiquetaOCR() { return 'TBR123456789'; },
    detectarTransportadoraOCR() { return 'Amazon'; },
    detectarTransportadora() { return 'Amazon'; },
    abrirModalSugestaoMorador(...args) { context.modal = args; },
    apiFetch: async () => ({ ParsedResults: [{ ParsedText: label }] })
  });
  vm.runInContext(html.slice(html.indexOf('let _fotoEtiquetaBase64'), html.indexOf('function fotografarEtiqueta()')), context);
  vm.runInContext(html.slice(html.indexOf('async function enviarParaOCR('), html.indexOf('function detectarTransportadoraOCR(', html.indexOf('async function enviarParaOCR('))), context);
  vm.runInContext('function identificarMoradorOCR(text) { return RecipientMatching.match(text, moradores); }', context);
  return { context, element, run: code => vm.runInContext(code, context) };
}

test('OCR clears previous selection and fills only an exact new match', async () => {
  const { run, context } = workflow();
  const promise = run('enviarParaOCR("image", document.getElementById("ocrStatus"))');
  assert.equal(context.moradorSelecionadoId, null);
  await promise;
  assert.equal(context.moradorSelecionadoId, carlos.id);
  assert.equal(run('_leituraEtiquetaPendente'), false);
});

test('unknown recipient opens confirmation and does not reuse previous resident', async () => {
  const { run, context } = workflow();
  context.moradores = [{ id: 'other', nome: 'Maria Oliveira', casa: carlos.casa }];
  await run('enviarParaOCR("image", document.getElementById("ocrStatus"))');
  assert.equal(context.moradorSelecionadoId, null);
  assert.ok(context.modal);
});

for (const [name, response] of [['empty OCR', { ParsedResults: [{ ParsedText: '' }] }], ['provider error with partial text', { IsErroredOnProcessing: true, ParsedResults: [{ ParsedText: label }] }], ['partial page', { ParsedResults: [{ ParsedText: label, FileParseExitCode: 0 }] }]]) {
  test(name + ' leaves no resident selected', async () => {
    const { run, context } = workflow();
    context.apiFetch = async () => response;
    await run('enviarParaOCR("image", document.getElementById("ocrStatus"))');
    assert.equal(context.moradorSelecionadoId, null);
    assert.equal(run('_leituraEtiquetaPendente'), false);
  });
}

test('late OCR response cannot overwrite the next label', async () => {
  const { run, context, element } = workflow();
  let resolve;
  context.apiFetch = () => new Promise(r => { resolve = r; });
  const pending = run('enviarParaOCR("old", document.getElementById("ocrStatus"))');
  run('iniciarLeituraEtiqueta()');
  element('inputCodigo').value = 'NEW-CODE';
  resolve({ ParsedResults: [{ ParsedText: label }] });
  await pending;
  assert.equal(context.moradorSelecionadoId, null);
  assert.equal(element('inputCodigo').value, 'NEW-CODE');
  assert.equal(run('_leituraEtiquetaPendente'), true);
});

test('clearing form invalidates pending OCR', async () => {
  const { run, context } = workflow();
  let resolve;
  context.apiFetch = () => new Promise(r => { resolve = r; });
  const pending = run('enviarParaOCR("old", document.getElementById("ocrStatus"))');
  run('invalidarLeituraEtiqueta()');
  resolve({ ParsedResults: [{ ParsedText: label }] });
  await pending;
  assert.equal(context.moradorSelecionadoId, null);
  assert.equal(run('_leituraEtiquetaPendente'), false);
});

test('all OCR results are considered, not just the first empty result', async () => {
  const { run, context } = workflow();
  context.apiFetch = async () => ({ ParsedResults: [{ ParsedText: '' }, { ParsedText: label }] });
  await run('enviarParaOCR("image", document.getElementById("ocrStatus"))');
  assert.equal(context.moradorSelecionadoId, carlos.id);
});
