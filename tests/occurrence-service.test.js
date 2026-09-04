'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssociationManager } = require('../association-manager');
const { WithdrawalReceiptService } = require('../withdrawal-receipt');
const {
  OccurrenceService,
  readOccurrenceEvents,
  verifyOccurrenceEvents,
  MAX_ATTACHMENT_BYTES
} = require('../occurrence-service');

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-occurrence-'));
  return new AssociationManager({ dataDir:dir, defaultName:'Associação Teste' });
}

function state(packageOverrides = {}) {
  return {
    version:Date.now(), updatedAt:new Date().toISOString(),
    moradores:[{id:'m1',nome:'Ana Teste',casa:'Rua A, 10',whats:'17999999999'}],
    encomendas:[{
      id:'p1', codigo:'AB123456789BR', transportadora:'Correios', status:'pendente',
      moradorId:'m1', moradorNome:'Ana Teste', moradorCasa:'Rua A, 10', moradorWhats:'17999999999',
      dataEntrada:'04/09/2026, 10:00:00', ...packageOverrides
    }],
    retirantesRelacionados:[], auditoria:[], detalhesRetirada:{}, memoriaRemetentes:{}, configPublica:{}, resetEncomendasAt:null
  };
}

const admin = {id:'u1',name:'Administrador',role:'admin',ip:'127.0.0.1'};
const supervisor = {id:'u2',name:'Supervisor',role:'supervisor',ip:'127.0.0.2'};
const porteiro = {id:'u3',name:'Porteiro',role:'porteiro',ip:'127.0.0.3'};

function createInput(overrides = {}) {
  return {
    packageId:'p1', type:'contestacao_retirada', priority:'alta',
    title:'Contestação da retirada',
    description:'Morador informa divergência e solicita apuração formal da encomenda.',
    ...overrides
  };
}

test('ocorrências recebem numeração sequencial e vinculam abertura à cadeia de custódia', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const service = new OccurrenceService({associations:manager, now:()=>new Date('2026-09-04T18:00:00.000Z')});

  const first = service.create('principal', createInput(), porteiro);
  const second = service.create('principal', createInput({type:'encomenda_danificada',title:'Dano relatado'}), admin);

  assert.equal(first.occurrence.occurrenceNumber, 'OC-2026-000001');
  assert.equal(second.occurrence.occurrenceNumber, 'OC-2026-000002');
  assert.equal(first.integrity.status, 'ok');

  const pkg = manager.readState('principal').encomendas[0];
  const events = pkg.cadeiaCustodia.filter(event => event.type === 'occurrence_opened');
  assert.equal(events.length, 2);
  assert.equal(events[0].metadata.occurrenceNumber, 'OC-2026-000001');
  manager.closeAll();
});

test('linha do tempo é append-only, registra manifestação e detecta integridade', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const service = new OccurrenceService({associations:manager, now:()=>new Date('2026-09-04T18:00:00.000Z')});
  const created = service.create('principal', createInput(), porteiro);
  const id = created.occurrence.id;
  service.addNote('principal', id, {kind:'resident_statement',text:'Morador declara que não reconhece a pessoa que realizou a retirada.'}, supervisor);

  const db = manager.database('principal');
  const timeline = readOccurrenceEvents(db, id);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].type, 'resident_statement');
  assert.equal(verifyOccurrenceEvents(timeline).ok, true);
  assert.throws(() => db.db.prepare('UPDATE occurrence_events SET event_hash = ? WHERE occurrence_id = ?').run('x', id), /append-only/);
  assert.throws(() => db.db.prepare('DELETE FROM occurrence_events WHERE occurrence_id = ?').run(id), /append-only/);
  assert.throws(() => db.db.prepare('DELETE FROM occurrences WHERE id = ?').run(id), /cannot be deleted/);
  manager.closeAll();
});

test('conclusão exige administrador e fundamentação, com reabertura sem apagar histórico', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  let now = new Date('2026-09-04T18:00:00.000Z');
  const service = new OccurrenceService({associations:manager, now:()=>new Date(now)});
  const created = service.create('principal', createInput(), porteiro);
  const id = created.occurrence.id;

  assert.throws(() => service.conclude('principal', id, {outcome:'entrega_confirmada',conclusion:'Conclusão suficientemente detalhada para encerrar a apuração.'}, supervisor), /Sem permissão/);
  assert.throws(() => service.conclude('principal', id, {outcome:'entrega_confirmada',conclusion:'curta'}, admin), /20 caracteres/);

  now = new Date('2026-09-04T19:00:00.000Z');
  const concluded = service.conclude('principal', id, {outcome:'entrega_confirmada',conclusion:'A conferência dos registros confirmou a entrega da encomenda ao destinatário.'}, admin);
  assert.equal(concluded.occurrence.status, 'concluida');
  assert.equal(concluded.occurrence.outcome, 'entrega_confirmada');

  now = new Date('2026-09-04T20:00:00.000Z');
  const reopened = service.reopen('principal', id, 'Nova informação documental foi apresentada e exige complementação da apuração.', admin);
  assert.equal(reopened.occurrence.status, 'em_apuracao');
  assert.ok(reopened.events.some(event => event.type === 'occurrence_concluded'));
  assert.ok(reopened.events.some(event => event.type === 'occurrence_reopened'));

  const pkg = manager.readState('principal').encomendas[0];
  assert.ok(pkg.cadeiaCustodia.some(event => event.type === 'occurrence_concluded'));
  assert.ok(pkg.cadeiaCustodia.some(event => event.type === 'occurrence_reopened'));
  manager.closeAll();
});

test('anexos são limitados, protegidos por SHA-256 e imutáveis', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const service = new OccurrenceService({associations:manager, now:()=>new Date('2026-09-04T18:00:00.000Z')});
  const created = service.create('principal', createInput(), porteiro);
  const id = created.occurrence.id;
  const content = Buffer.from('evidência de teste', 'utf8');
  const updated = service.addAttachment('principal', id, {
    fileName:'manifestacao.txt', mimeType:'text/plain', base64:content.toString('base64')
  }, porteiro);
  assert.equal(updated.attachments.length, 1);
  assert.match(updated.attachments[0].sha256, /^[a-f0-9]{64}$/);

  const downloaded = service.getAttachment('principal', id, updated.attachments[0].id);
  assert.equal(downloaded.integrity, 'ok');
  assert.equal(downloaded.content.toString('utf8'), 'evidência de teste');

  const db = manager.database('principal');
  assert.throws(() => db.db.prepare('DELETE FROM occurrence_attachments WHERE occurrence_id = ?').run(id), /append-only/);
  const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString('base64');
  assert.throws(() => service.addAttachment('principal', id, {fileName:'grande.txt',mimeType:'text/plain',base64:huge}, admin), /2 MB/);
  manager.closeAll();
});

test('ocorrência vincula comprovante de retirada sem expor PIN', () => {
  const manager = tempManager();
  manager.writeState('principal', state({
    status:'retirado', dataRetirada:'04/09/2026, 15:30:00', retiradoPor:'Ana Teste', retiranteTipo:'proprio',
    assinatura:'data:image/png;base64,ASSINATURA', pinRetiradaEnviado:false
  }));
  const receipts = new WithdrawalReceiptService({associations:manager, now:()=>new Date('2026-09-04T18:10:00.000Z')});
  const receiptSummary = receipts.ensureAssociation('principal');
  assert.equal(receiptSummary.created, 1);

  const service = new OccurrenceService({associations:manager, now:()=>new Date('2026-09-04T18:20:00.000Z')});
  const created = service.create('principal', createInput(), admin);
  assert.equal(created.occurrence.receiptNumber, 'RET-2026-000001');
  assert.match(created.occurrence.receiptHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(created), /pinRetirada|ASSINATURA/);
  manager.closeAll();
});

test('Multi-Associação mantém ocorrências fisicamente isoladas', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  manager.create({id:'jardim-sul',nome:'Associação Jardim Sul'});
  manager.writeState('jardim-sul', state({codigo:'JS987654321BR'}));
  const service = new OccurrenceService({associations:manager, now:()=>new Date('2026-09-04T18:00:00.000Z')});
  service.create('principal', createInput(), admin);
  service.create('jardim-sul', createInput({type:'divergencia_transportadora'}), admin);

  assert.equal(service.list('principal').occurrences.length, 1);
  assert.equal(service.list('jardim-sul').occurrences.length, 1);
  assert.equal(service.list('principal').occurrences[0].packageCode, 'AB123456789BR');
  assert.equal(service.list('jardim-sul').occurrences[0].packageCode, 'JS987654321BR');
  assert.equal(service.list('principal').occurrences[0].occurrenceNumber, 'OC-2026-000001');
  assert.equal(service.list('jardim-sul').occurrences[0].occurrenceNumber, 'OC-2026-000001');
  manager.closeAll();
});

test('Central de Ocorrências, APIs e atalhos de interface estão instalados', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'ocorrencias.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'ocorrencias.js'), 'utf8');
  const shortcut = fs.readFileSync(path.join(root, 'occurrence-client.js'), 'utf8');
  const custody = fs.readFileSync(path.join(root, 'custody-chain-client.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(server, /\/api\/occurrences/);
  assert.match(server, /OccurrenceService/);
  assert.match(page, /Central de Ocorrências/);
  assert.match(page, /Ocorrências e contestações/);
  assert.match(client, /Manifestação do morador/);
  assert.match(client, /SHA-256/);
  assert.match(shortcut, /Abrir ocorrência/);
  assert.match(custody, /occurrence-client\.js/);
  assert.match(sw, /ocorrencias\.html/);
  assert.match(sw, /occurrence-client\.js/);
});
