'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssociationManager } = require('../association-manager');
const { OccurrenceService } = require('../occurrence-service');
const { ResidentOccurrenceService } = require('../resident-occurrence-service');

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-resident-occ-'));
  return new AssociationManager({ dataDir:dir, defaultName:'Associação Teste' });
}

function state(overrides = {}) {
  return {
    version:Date.now(), updatedAt:new Date().toISOString(),
    moradores:[
      {id:'m1',nome:'Ana Teste',casa:'Rua A, 10',whats:'17999999999'},
      {id:'m2',nome:'Bruno Teste',casa:'Rua B, 20',whats:'17888888888'}
    ],
    encomendas:[
      {
        id:'p1',codigo:'AB123456789BR',transportadora:'Correios',status:'retirado',
        moradorId:'m1',moradorNome:'Ana Teste',moradorCasa:'Rua A, 10',moradorWhats:'17999999999',
        dataEntrada:'04/09/2026, 10:00:00',dataRetirada:'04/09/2026, 15:00:00',retiradoPor:'Ana Teste',assinatura:'data:image/png;base64,ASS'
      },
      {
        id:'p2',codigo:'CD987654321BR',transportadora:'Mercado Livre',status:'pendente',
        moradorId:'m2',moradorNome:'Bruno Teste',moradorCasa:'Rua B, 20',moradorWhats:'17888888888',dataEntrada:'04/09/2026, 11:00:00'
      }
    ],
    retirantesRelacionados:[],auditoria:[],detalhesRetirada:{},memoriaRemetentes:{},configPublica:{},resetEncomendasAt:null,
    ...overrides
  };
}

const resident = {id:'portal-morador',name:'Morador pelo Portal',role:'morador',ip:'127.0.0.9'};
const admin = {id:'u1',name:'Administrador',role:'admin',ip:'127.0.0.1'};

test('morador abre contestação somente para sua própria encomenda e prioridade é definida pelo sistema', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const service = new ResidentOccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:00:00.000Z')});

  const created = service.create('principal',['m1'],'p1',{
    type:'contestacao_retirada',
    priority:'baixa',
    description:'Não reconheço a retirada registrada e solicito uma apuração formal.'
  },resident);

  assert.equal(created.occurrence.occurrenceNumber,'OC-2026-000001');
  assert.equal(created.occurrence.priority,'alta');
  assert.equal(created.occurrence.status,'aberta');
  assert.equal(created.integrity.status,'ok');
  assert.throws(() => service.create('principal',['m1'],'p2',{type:'encomenda_nao_localizada',description:'A encomenda não foi localizada no momento em que tentei retirá-la.'},resident),/não encontrada para este morador/);

  const pkg = manager.readState('principal').encomendas.find(item => item.id === 'p1');
  assert.ok(pkg.cadeiaCustodia.some(event => event.type === 'occurrence_opened' && event.actorRole === 'morador'));
  manager.closeAll();
});

test('portal impede duplicidade ativa e valida tipo conforme status da encomenda', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const service = new ResidentOccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:00:00.000Z')});
  service.create('principal',['m1'],'p1',{type:'contestacao_retirada',description:'Não reconheço a retirada registrada e preciso que o caso seja apurado.'},resident);
  assert.throws(() => service.create('principal',['m1'],'p1',{type:'outro',description:'Tenho outro problema relacionado com a mesma encomenda que está em apuração.'},resident),/Já existe a ocorrência OC-2026-000001/);
  assert.throws(() => service.create('principal',['m2'],'p2',{type:'contestacao_retirada',description:'Estou contestando uma retirada que ainda não ocorreu no sistema.'},resident),/somente pode ser aberta após a retirada/);
  manager.closeAll();
});

test('morador acompanha somente suas ocorrências e notas internas não são expostas', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const residentService = new ResidentOccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:00:00.000Z')});
  const staffService = new OccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:10:00.000Z')});
  const created = residentService.create('principal',['m1'],'p1',{type:'contestacao_retirada',description:'Não reconheço a retirada e gostaria que a administração verificasse os registros.'},resident);
  staffService.addNote('principal',created.occurrence.id,{kind:'administrative_note',text:'Nota interna reservada para análise administrativa do caso.'},admin);
  staffService.setStatus('principal',created.occurrence.id,'em_apuracao','Equipe iniciou conferência interna.',admin);

  const view = residentService.get('principal',['m1'],created.occurrence.id);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized,/Nota interna reservada/);
  assert.doesNotMatch(serialized,/Equipe iniciou conferência interna/);
  assert.match(serialized,/Status: Em apuração/);
  assert.doesNotMatch(serialized,/127\.0\.0\.1|Administrador/);
  assert.throws(() => residentService.get('principal',['m2'],created.occurrence.id),/não encontrada para este morador/);
  manager.closeAll();
});

test('morador acrescenta manifestação somente enquanto ocorrência está ativa', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  const residentService = new ResidentOccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:00:00.000Z')});
  const staffService = new OccurrenceService({associations:manager,now:()=>new Date('2026-09-04T21:00:00.000Z')});
  const created = residentService.create('principal',['m1'],'p1',{type:'contestacao_retirada',description:'Não reconheço a retirada e solicito conferência do histórico da encomenda.'},resident);
  const updated = residentService.addStatement('principal',['m1'],created.occurrence.id,'Acrescento que nenhuma pessoa da minha residência realizou essa retirada.',resident);
  assert.ok(updated.timeline.some(event => event.type === 'resident_statement'));

  staffService.conclude('principal',created.occurrence.id,{
    outcome:'entrega_confirmada',
    conclusion:'A apuração administrativa confirmou a entrega com base nos registros disponíveis.'
  },admin);
  assert.throws(() => residentService.addStatement('principal',['m1'],created.occurrence.id,'Nova manifestação depois da conclusão.',resident),/não está aberta/);

  const finalView = residentService.get('principal',['m1'],created.occurrence.id);
  assert.equal(finalView.occurrence.status,'concluida');
  assert.equal(finalView.occurrence.outcome,'entrega_confirmada');
  assert.match(finalView.occurrence.conclusion,/confirmou a entrega/);
  manager.closeAll();
});

test('portal do morador mantém isolamento Multi-Associação', () => {
  const manager = tempManager();
  manager.writeState('principal', state());
  manager.create({id:'jardim-sul',nome:'Associação Jardim Sul'});
  manager.writeState('jardim-sul', state());
  const service = new ResidentOccurrenceService({associations:manager,now:()=>new Date('2026-09-04T20:00:00.000Z')});
  service.create('principal',['m1'],'p1',{type:'contestacao_retirada',description:'Contestação registrada na associação principal para verificar isolamento físico.'},resident);
  assert.equal(service.list('principal',['m1']).occurrences.length,1);
  assert.equal(service.list('jardim-sul',['m1']).occurrences.length,0);
  manager.closeAll();
});

test('rotas e interface do Item 20 estão instaladas sem expor notas internas', () => {
  const root = path.join(__dirname,'..');
  const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
  const page = fs.readFileSync(path.join(root,'morador.html'),'utf8');
  const client = fs.readFileSync(path.join(root,'morador-portal.js'),'utf8');
  const service = fs.readFileSync(path.join(root,'resident-occurrence-service.js'),'utf8');
  assert.match(server,/\/api\/morador\/ocorrencias/);
  assert.match(server,/ResidentOccurrenceService/);
  assert.match(page,/Minhas ocorrências/);
  assert.match(client,/Contestar ou informar problema/);
  assert.match(client,/Linha do tempo verificada por SHA-256/);
  assert.match(service,/internalNotesExposed:\s*false/);
  assert.match(service,/created_by_role = 'morador'/);
  assert.doesNotMatch(client,/occurrence_attachments|administrative_note/);
});
