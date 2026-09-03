const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const memory = require('../recipient-memory');

const clecius = { id: '1006', nome: 'Clecius Eduardo Alves Salome', casa: 'QD01LT11 - Rua Brasilia, 311' };
const lucimara = { id: '1006b', nome: 'Lucimara Gonçalves Salomé', casa: 'QD01LT11 - Rua Brasilia, 311' };

test('confirmação explícita grava destinatário somente com endereço compatível', () => {
  const learned = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  }, new Date('2026-09-02T12:00:00Z'));

  assert.equal(learned.saved, true);
  assert.equal(learned.entry.residentId, '1006b');
  assert.equal(learned.entry.confirmations, 1);
  assert.equal(learned.entry.observedName, 'lucimara');
});

test('não aprende quando endereço não foi identificado ou diverge do morador', () => {
  const missing = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: ''
  });
  assert.equal(missing.saved, false);

  const conflict = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Londres 160'
  });
  assert.equal(conflict.saved, false);
  assert.equal(conflict.reason, 'address-mismatch');
});

test('memória confirmada prioriza o destinatário sem desativar a confirmação de segurança', () => {
  const learned = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  });
  const result = {
    confiavel: false,
    morador: null,
    candidatoPrincipal: clecius,
    nomeExtraido: 'Lucimara',
    enderecoExtraido: 'Rua Brasilia 311',
    candidatos: [
      { morador: clecius, score: 20 },
      { morador: lucimara, score: 18 }
    ]
  };

  memory.apply(learned.memory, result);
  assert.equal(result.candidatos[0].morador.id, '1006b');
  assert.equal(result.candidatoPrincipal.id, '1006b');
  assert.equal(result.memoriaConfirmada, true);
  assert.equal(result.confiavel, false);
  assert.equal(result.morador, null);
});

test('memória não é aplicada se o endereço atual do cadastro mudou', () => {
  const learned = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  });
  const moved = { ...lucimara, casa: 'Rua Lisboa, 45' };
  const result = {
    confiavel: false,
    morador: null,
    candidatoPrincipal: clecius,
    nomeExtraido: 'Lucimara',
    enderecoExtraido: 'Rua Brasilia 311',
    candidatos: [
      { morador: clecius, score: 20 },
      { morador: moved, score: 18 }
    ]
  };

  memory.apply(learned.memory, result);
  assert.equal(result.candidatos[0].morador.id, '1006');
  assert.equal(result.memoriaConfirmada, undefined);
});

test('nova confirmação do mesmo padrão aumenta contador e correção posterior substitui o destinatário', () => {
  let learned = memory.record(memory.emptyMemory(), {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  }, new Date('2026-09-02T10:00:00Z'));
  learned = memory.record(learned.memory, {
    resident: lucimara,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  }, new Date('2026-09-02T11:00:00Z'));
  assert.equal(learned.entry.confirmations, 2);

  learned = memory.record(learned.memory, {
    resident: clecius,
    nameRead: 'Lucimara',
    addressRead: 'Rua Brasilia 311'
  }, new Date('2026-09-02T12:00:00Z'));
  assert.equal(learned.entry.residentId, '1006');
  assert.equal(learned.entry.confirmations, 1);
});

test('local OCR carrega o módulo de memória sem depender de cache antigo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-ocr.js'), 'utf8');
  assert.match(source, /recipient-memory\.js\?v=20260902-1/);
  assert.match(source, /recipientMemoryLoader:\s*true/);
});

test('explicações distinguem destinatário lido de outro morador do mesmo endereço', () => {
  const result = {
    confiavel: false,
    morador: null,
    candidatoPrincipal: lucimara,
    destinatarioNaoCadastrado: true,
    nomeExtraido: 'Lucimara Gonçalves Salomé',
    enderecoExtraido: 'Rua Brasilia 311',
    candidatos: [
      {
        morador: lucimara,
        exactName: true,
        plausible: true,
        relation: 'missing',
        motivos: ['Nome completo coincide', 'Endereço ausente ou incompleto']
      },
      {
        morador: clecius,
        exactName: false,
        plausible: false,
        relation: 'address-only',
        motivos: ['Destinatário não cadastrado', 'Rua e número reconhecidos apesar de erro de OCR: confirme o responsável']
      }
    ]
  };

  memory.clarifyCandidates(result);
  assert.deepEqual(result.candidatos[0].motivos, ['Nome completo coincide', 'Rua e número coincidem']);
  assert.deepEqual(result.candidatos[1].motivos, ['Outro morador cadastrado no mesmo endereço', 'Nome lido na etiqueta indica o morador destacado acima']);
  assert.equal(result.destinatarioNaoCadastrado, false);
});
