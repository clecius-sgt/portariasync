'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendEvent,
  verifyChain,
  reconcileState,
  backfillState,
  sanitizeMetadata
} = require('../custody-chain');
const { StructuredDatabase } = require('../structured-database');

function stateWithPackage(overrides = {}) {
  return {
    exists: true,
    version: 1,
    updatedAt: '2026-09-03T20:00:00.000Z',
    moradores: [{ id:'m1', nome:'Ana Silva', casa:'Rua A, 1', whats:'17999998888' }],
    encomendas: [{
      id:'p1', codigo:'TBR123456789', transportadora:'Correios', status:'pendente',
      moradorId:'m1', moradorNome:'Ana Silva', moradorCasa:'Rua A, 1', moradorWhats:'17999998888',
      dataEntrada:'03/09/2026 17:00', ...overrides
    }],
    retirantesRelacionados: [],
    auditoria: [{
      id:'a1', acao:'Encomenda registrada', data:'03/09/2026 17:00', usuarioNome:'Porteiro 01', usuarioPerfil:'porteiro',
      detalhes:{ encomendaId:'p1', codigo:'TBR123456789', moradorNome:'Ana Silva' }
    }],
    detalhesRetirada:{}, memoriaRemetentes:{}, configPublica:{}, resetEncomendasAt:null
  };
}

test('eventos são encadeados por SHA-256 e qualquer alteração quebra a integridade', () => {
  const pkg = { id:'p1' };
  appendEvent(pkg, { type:'package_received', title:'Encomenda recebida', occurredAt:'2026-09-03T20:00:00Z' });
  appendEvent(pkg, { type:'recipient_confirmed', title:'Destinatário confirmado', occurredAt:'2026-09-03T20:01:00Z' });
  assert.equal(verifyChain(pkg).ok, true);
  assert.equal(pkg.cadeiaCustodiaMeta.algorithm, 'sha256');
  assert.equal(pkg.cadeiaCustodiaMeta.appendOnly, true);
  assert.equal(pkg.cadeiaCustodia.length, 2);

  pkg.cadeiaCustodia[0].title = 'Evento adulterado';
  const integrity = verifyChain(pkg);
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, 'hash');
});

test('reconciliação ignora cadeia enviada pelo navegador e preserva a cadeia armazenada', () => {
  const initial = reconcileState({ exists:false, encomendas:[] }, stateWithPackage(), { now:new Date('2026-09-03T20:00:00Z') });
  const originalHash = initial.encomendas[0].cadeiaCustodia[0].hash;
  const incoming = JSON.parse(JSON.stringify(initial));
  incoming.encomendas[0].cadeiaCustodia[0].title = 'Tentativa de sobrescrita';
  incoming.encomendas[0].pinRetiradaEnviado = true;
  incoming.encomendas[0].pinRetiradaEnviadoEm = '2026-09-03T20:05:00Z';

  const result = reconcileState(initial, incoming, { now:new Date('2026-09-03T20:05:00Z') });
  const pkg = result.encomendas[0];
  assert.equal(pkg.cadeiaCustodia[0].hash, originalHash);
  assert.notEqual(pkg.cadeiaCustodia[0].title, 'Tentativa de sobrescrita');
  assert.ok(pkg.cadeiaCustodia.some(event => event.type === 'resident_notified'));
  assert.equal(verifyChain(pkg).ok, true);
});

test('retirada acrescenta evidência, validação, assinatura e entrega sem apagar eventos anteriores', () => {
  const first = reconcileState({ exists:false, encomendas:[] }, stateWithPackage({ pinRetiradaEnviado:true }), { now:new Date('2026-09-03T20:00:00Z') });
  const before = first.encomendas[0].cadeiaCustodia.length;
  const next = JSON.parse(JSON.stringify(first));
  next.auditoria.unshift({
    acao:'Retirada confirmada', usuarioNome:'Porteiro 02', usuarioPerfil:'porteiro',
    detalhes:{ encomendaId:'p1', retiradoPor:'Carlos' }
  });
  Object.assign(next.encomendas[0], {
    status:'retirado', dataRetirada:'03/09/2026 18:30', retiradoPor:'Carlos', retiranteTipo:'outro',
    retiranteRg:'12.345.678-9', fotoRetirante:'data:image/jpeg;base64,SEGREDO', assinatura:'data:image/png;base64,SEGREDO',
    pinRetiradaMetodo:'autorizacao-digital', pinRetiradaValidadoEm:'2026-09-03T21:30:00Z'
  });
  const result = reconcileState(first, next, { now:new Date('2026-09-03T21:30:00Z') });
  const pkg = result.encomendas[0];
  const types = pkg.cadeiaCustodia.map(event => event.type);
  assert.ok(pkg.cadeiaCustodia.length > before);
  assert.ok(types.includes('third_party_evidence_collected'));
  assert.ok(types.includes('withdrawal_validation'));
  assert.ok(types.includes('signature_collected'));
  assert.ok(types.includes('package_withdrawn'));
  assert.equal(JSON.stringify(pkg.cadeiaCustodia).includes('base64'), false);
  assert.equal(JSON.stringify(pkg.cadeiaCustodia).includes('12.345.678-9'), false);
  assert.equal(verifyChain(pkg).ok, true);
});

test('backfill identifica claramente eventos reconstruídos de registros anteriores', () => {
  const source = stateWithPackage({ status:'retirado', dataRetirada:'02/09/2026 18:10', retiradoPor:'Ana Silva', assinatura:'data:image/png;base64,X' });
  const result = backfillState(source, { now:new Date('2026-09-03T22:00:00Z') });
  const pkg = result.state.encomendas[0];
  assert.equal(result.changed, true);
  assert.ok(pkg.cadeiaCustodia.length >= 4);
  assert.equal(pkg.cadeiaCustodia[0].metadata.reconstructed, true);
  assert.equal(pkg.cadeiaCustodia.at(-1).type, 'chain_enabled');
  assert.equal(verifyChain(pkg).ok, true);
});

test('SQLite rejeita sobrescrita da cadeia do servidor e acrescenta apenas transições legítimas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-custody-'));
  const db = new StructuredDatabase({ file:path.join(dir, 'state.sqlite') });
  const source = stateWithPackage();
  db.writeState(source);
  const stored = db.readState();
  const originalHash = stored.encomendas[0].cadeiaCustodia[0].hash;

  const malicious = JSON.parse(JSON.stringify(stored));
  malicious.encomendas[0].cadeiaCustodia[0].hash = 'f'.repeat(64);
  malicious.encomendas[0].pinRetiradaEnviado = true;
  db.writeState(malicious);
  const after = db.readState();
  assert.equal(after.encomendas[0].cadeiaCustodia[0].hash, originalHash);
  assert.equal(verifyChain(after.encomendas[0]).ok, true);
  assert.ok(after.encomendas[0].cadeiaCustodia.some(event => event.type === 'resident_notified'));
  db.close();
});

test('metadados da cadeia descartam PIN, assinatura, fotos e imagens', () => {
  const safe = sanitizeMetadata({
    pin:'123456', senha:'segredo', assinatura:'data:x', fotoDocumento:'data:y', imagem:'data:z',
    codigo:'ABC123', moradorNome:'Ana'
  });
  assert.equal(Object.hasOwn(safe, 'pin'), false);
  assert.equal(Object.hasOwn(safe, 'senha'), false);
  assert.equal(Object.hasOwn(safe, 'assinatura'), false);
  assert.equal(Object.hasOwn(safe, 'fotoDocumento'), false);
  assert.equal(Object.hasOwn(safe, 'imagem'), false);
  assert.equal(safe.codigo, 'ABC123');
});

test('interface oferece Histórico completo e evidencia integridade da cadeia', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'custody-chain-client.js'), 'utf8');
  assert.match(source, /Histórico completo/);
  assert.match(source, /Cadeia de Custódia Digital/);
  assert.match(source, /SHA-256/);
  assert.match(source, /Correções geram novos registros/);
});
