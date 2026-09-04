'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssociationManager } = require('../association-manager');
const {
  WithdrawalReceiptService,
  maskDocument,
  buildReceipt,
  verifyReceipt,
  receiptForPackage,
  receiptCount,
  RECEIPT_EVENT
} = require('../withdrawal-receipt');

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-receipt-'));
  return new AssociationManager({ dataDir: dir, defaultName: 'Associação Teste' });
}

function withdrawnState(overrides = {}) {
  return {
    version: Date.now(),
    updatedAt: new Date().toISOString(),
    moradores: [{ id:'m1', nome:'Ana Teste', casa:'Rua A, 10', whats:'17999999999' }],
    encomendas: [{
      id:'p1', codigo:'AB123456789BR', transportadora:'Correios', status:'retirado',
      moradorId:'m1', moradorNome:'Ana Teste', moradorCasa:'Rua A, 10', moradorWhats:'17999999999',
      dataEntrada:'03/09/2026, 10:00:00', dataRetirada:'04/09/2026, 15:30:00',
      retiradoPor:'João Teste', retiranteTipo:'outro', retiranteRg:'12.345.678-9',
      fotoRetirante:'data:image/jpeg;base64,FOTO', assinatura:'data:image/png;base64,ASSINATURA',
      pinRetiradaEnviado:true, pinRetiradaMetodo:'autorizacao-digital', pinRetiradaValidadoEm:'2026-09-04T18:30:00.000Z',
      ...overrides
    }],
    retirantesRelacionados: [],
    auditoria: [{ acao:'Retirada confirmada', usuario:'Porteiro Teste', detalhes:{ encomendaId:'p1' } }],
    detalhesRetirada:{}, memoriaRemetentes:{}, configPublica:{}, resetEncomendasAt:null
  };
}

test('documento é mascarado e comprovante não contém PIN, foto ou assinatura em bruto', () => {
  assert.equal(maskDocument('12.345.678-9'), '***78-9');
  const pkg = withdrawnState().encomendas[0];
  pkg.cadeiaCustodia = [];
  const receipt = buildReceipt({
    association:{id:'principal', name:'Associação Teste'}, pkg,
    state:withdrawnState(), receiptNumber:'RET-2026-000001', issuedAt:'2026-09-04T18:31:00.000Z'
  });
  assert.equal(receipt.withdrawal.documentMasked, '***78-9');
  assert.equal(receipt.withdrawal.validationCode, 'autorizacao-digital');
  assert.equal(receipt.withdrawal.signaturePresent, true);
  assert.equal(receipt.withdrawal.photoEvidencePresent, true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /ASSINATURA|FOTO|pinRetirada|12\.345\.678-9|data:image/i);
  assert.equal(verifyReceipt(receipt).ok, true);
});

test('alteração em dado protegido quebra o hash do comprovante', () => {
  const pkg = withdrawnState({ pinRetiradaEnviado:false, pinRetiradaMetodo:'' }).encomendas[0];
  pkg.cadeiaCustodia = [];
  const receipt = buildReceipt({
    association:{id:'principal', name:'Associação Teste'}, pkg,
    state:withdrawnState(), receiptNumber:'RET-2026-000002', issuedAt:'2026-09-04T18:31:00.000Z'
  });
  assert.equal(verifyReceipt(receipt).ok, true);
  receipt.package.code = 'ALTERADO';
  assert.equal(verifyReceipt(receipt).ok, false);
});

test('serviço gera número sequencial por associação, grava tabela append-only e vincula à cadeia', () => {
  const manager = tempManager();
  manager.writeState('principal', withdrawnState());
  const service = new WithdrawalReceiptService({ associations:manager, now:()=>new Date('2026-09-04T18:31:00.000Z') });
  const first = service.ensureAssociation('principal');
  assert.equal(first.created, 1);
  assert.equal(first.totalReceipts, 1);

  const db = manager.database('principal');
  const receipt = receiptForPackage(db, 'p1');
  assert.equal(receipt.receiptNumber, 'RET-2026-000001');
  assert.equal(receipt.integrity, 'ok');

  const stored = manager.readState('principal').encomendas[0];
  assert.equal(stored.comprovanteRetirada.receiptNumber, 'RET-2026-000001');
  assert.ok(stored.cadeiaCustodia.some(event => event.type === RECEIPT_EVENT && event.metadata.receiptHash === receipt.receiptHash));

  const second = service.ensureAssociation('principal');
  assert.equal(second.created, 0);
  assert.equal(receiptCount(db), 1);

  assert.throws(() => db.db.prepare('UPDATE withdrawal_receipts SET receipt_hash = ? WHERE package_id = ?').run('x', 'p1'), /append-only/);
  assert.throws(() => db.db.prepare('DELETE FROM withdrawal_receipts WHERE package_id = ?').run('p1'), /append-only/);
  manager.closeAll();
});

test('comprovante aguarda finalização do método quando PIN foi enviado', () => {
  const manager = tempManager();
  manager.writeState('principal', withdrawnState({ pinRetiradaMetodo:'' }));
  const service = new WithdrawalReceiptService({ associations:manager, now:()=>new Date('2026-09-04T18:31:00.000Z') });
  const result = service.ensureAssociation('principal');
  assert.equal(result.created, 0);
  assert.equal(result.waiting, 1);
  assert.equal(result.totalReceipts, 0);
  manager.closeAll();
});

test('interface imprimível e daemon do comprovante estão integrados ao cliente da cadeia', () => {
  const root = path.join(__dirname, '..');
  const client = fs.readFileSync(path.join(root, 'withdrawal-receipt-client.js'), 'utf8');
  const custody = fs.readFileSync(path.join(root, 'custody-chain-client.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(root, 'scripts', 'withdrawal-receipt-daemon.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /gerarComprovanteRetirada/);
  assert.match(client, /COMPROVANTE DIGITAL DE RETIRADA/);
  assert.match(client, /window\.print/);
  assert.match(client, /O PIN utilizado nunca é exibido/);
  assert.match(custody, /withdrawal-receipt-client\.js/);
  assert.match(daemon, /WithdrawalReceiptService/);
  assert.match(sw, /withdrawal-receipt-client\.js/);
});
