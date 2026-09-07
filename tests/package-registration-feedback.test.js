'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Trecho não encontrado: ${start}`);
  return source.slice(from, to);
}

test('primeiro clique confirma o cadastro, bloqueia clique duplicado e informa o WhatsApp', async () => {
  const elements = {
    inputCodigo: { value:'46573699051' },
    searchMorador: { value:'Lucimara' },
    inputTransportadora: { value:'Mercado Livre' },
    inputObs: { value:'Frágil' },
    moradorSelecionado: { style:{ display:'block' } },
    btnRegistrarEncomenda: { disabled:false, textContent:'' },
    resultadoRegistro: { className:'registro-resultado', textContent:'' }
  };
  let liberarWhatsApp;
  let renders = 0;
  const context = {
    console,
    document: { getElementById:id => elements[id] },
    exigirPerfil: () => true,
    _registroEncomendaEmAndamento: false,
    _leituraEtiquetaPendente: false,
    _fotoEtiquetaBase64: 'data:image/jpeg;base64,FOTO',
    moradorSelecionadoId: 'm1',
    moradores: [{ id:'m1', nome:'Lucimara Gonçalves Salomé', casa:'Rua Brasília, 311', whats:'119948427617' }],
    encomendas: [],
    config: { whatsAuto:true },
    codigoDigitadoNormalizado: () => '46573699051',
    verificarDuplicidade: codigo => context.encomendas.find(item => item.codigo === codigo && item.status === 'pendente'),
    limparMoradorSelecionado() {},
    invalidarLeituraEtiqueta() {},
    salvarEncomendas() {},
    salvarEncomendasSupabase() {},
    registrarAuditoria() {},
    atualizarCadastroEncomenda() {},
    renderDashboard() { renders += 1; },
    mostrarResultadoRegistro(tipo, mensagem) {
      elements.resultadoRegistro.className = 'registro-resultado ' + tipo;
      elements.resultadoRegistro.textContent = mensagem;
    },
    atualizarBotaoRegistro(processando, texto = '') {
      elements.btnRegistrarEncomenda.disabled = !!processando;
      elements.btnRegistrarEncomenda.textContent = texto || (processando ? 'Registrando' : 'Registrar');
    },
    toast() {},
    enviarWhatsApp: () => new Promise(resolve => { liberarWhatsApp = resolve; })
  };
  vm.createContext(context);
  vm.runInContext(between('async function registrarEncomenda()', '// ========== ENCOMENDAS =========='), context);

  const primeiroClique = context.registrarEncomenda();
  await Promise.resolve();
  assert.equal(context.encomendas.length, 1);
  assert.equal(elements.btnRegistrarEncomenda.disabled, true);
  assert.match(elements.resultadoRegistro.textContent, /registrada para Lucimara.*Enviando WhatsApp/);

  await context.registrarEncomenda();
  assert.equal(context.encomendas.length, 1);
  assert.match(elements.resultadoRegistro.textContent, /Registro em andamento/);

  liberarWhatsApp(true);
  await primeiroClique;
  assert.equal(elements.btnRegistrarEncomenda.disabled, false);
  assert.match(elements.resultadoRegistro.textContent, /WhatsApp enviado com sucesso/);
  assert.equal(elements.inputCodigo.value, '');
  assert.equal(renders, 1);
});

test('falha de quota salva cache sem imagens e não interrompe o registro', () => {
  let attempts = 0;
  let cached = '';
  const context = {
    console,
    encomendas: [{
      id:'e1', codigo:'46573699051',
      fotoEtiqueta:'data:image/jpeg;base64,ETIQUETA',
      fotoRetirante:'data:image/jpeg;base64,RETIRANTE',
      assinatura:'data:image/jpeg;base64,ASSINATURA'
    }],
    localStorage: {
      setItem(key, value) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('quota');
          error.name = 'QuotaExceededError';
          throw error;
        }
        assert.equal(key, 'encomendas');
        cached = value;
      }
    },
    agendarSyncEstadoServidor() {}
  };
  vm.createContext(context);
  vm.runInContext(between('function salvarEncomendas()', 'function salvarMoradores()'), context);
  assert.doesNotThrow(() => context.salvarEncomendas());
  const stored = JSON.parse(cached)[0];
  assert.equal(stored.codigo, '46573699051');
  assert.equal(Object.hasOwn(stored, 'fotoEtiqueta'), false);
  assert.equal(Object.hasOwn(stored, 'fotoRetirante'), false);
  assert.equal(Object.hasOwn(stored, 'assinatura'), false);
});

test('resultado do registro é visível, persistente e acessível no formulário', () => {
  assert.match(source, /id="btnRegistrarEncomenda"/);
  assert.match(source, /id="resultadoRegistro"[^>]+role="status"[^>]+aria-live="assertive"/);
  assert.match(source, /_registroEncomendaEmAndamento/);
  assert.match(source, /Encomenda \$\{codigo\} registrada para \$\{morador\.nome\}/);
  assert.match(source, /return ok;/);
});
