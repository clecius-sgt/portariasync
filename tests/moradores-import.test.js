'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const importer = require('../scripts/atualizar-moradores-planilha');

test('importador atualiza telefone da Lucimara preservando o ID existente', () => {
  const state = {
    moradores: [
      { id: '1006b', nome: 'Lucimara Gonçalves Salomé', casa: 'QD01LT11 – Rua Brasilia, 311', whats: '11997868841' }
    ]
  };
  const roster = [{
    idSugerido: 'novo',
    nome: 'Lucimara Gonçalves Salomé',
    casa: 'QD08LT05 – Rua Brasilia, 311',
    whats: '11948427617',
    whatsAlternativos: ['11948427617'],
    tipo: 'Proprietário',
    unidadesOrigem: ['QD08LT05']
  }];

  const { state: merged, summary } = importer.mergeRoster(state, roster, () => new Date('2026-09-03T20:00:00.000Z'));
  assert.equal(merged.moradores.length, 1);
  assert.equal(merged.moradores[0].id, '1006b');
  assert.equal(merged.moradores[0].whats, '11948427617');
  assert.equal(merged.moradores[0].casa, 'QD08LT05 – Rua Brasilia, 311');
  assert.equal(summary.updated, 1);
});

test('importador preserva telefone atual quando a planilha possui duas alternativas para o mesmo cadastro', () => {
  const state = {
    moradores: [
      { id: '101', nome: 'Mateus Diogo Ribeiro', casa: 'QD04LT19 – Rua Londres, 99', whats: '17991213708' }
    ]
  };
  const roster = [{
    idSugerido: 'mateus',
    nome: 'Mateus Diogo Ribeiro',
    casa: 'QD09LT12 – Rua Londres, 99',
    whats: '17991213708',
    whatsAlternativos: ['17991213708', '17991281792'],
    unidadesOrigem: ['QD09LT12', 'QD09LT14']
  }];

  const { state: merged, summary } = importer.mergeRoster(state, roster);
  assert.equal(merged.moradores[0].whats, '17991213708');
  assert.equal(summary.conflicts.length, 1);
});

test('importador adiciona novo cadastro sem remover cadastro legado', () => {
  const state = {
    moradores: [
      { id: 'legacy', nome: 'Morador Antigo', casa: 'Rua Roma, 1', whats: '17999999999' }
    ]
  };
  const roster = [{
    idSugerido: 'cad_novo',
    nome: 'Nova Moradora',
    casa: 'QD01LT01 – Rua Atenas, 10',
    whats: '17988887777',
    whatsAlternativos: ['17988887777']
  }];

  const { state: merged, summary } = importer.mergeRoster(state, roster);
  assert.equal(merged.moradores.length, 2);
  assert.ok(merged.moradores.some(item => item.id === 'legacy'));
  assert.ok(merged.moradores.some(item => item.id === 'cad_novo'));
  assert.equal(summary.added, 1);
  assert.equal(summary.legacyRetained, 1);
});

test('normalização trata Montevideo/Montevideu e Bueno/Buenos Aires como o mesmo endereço', () => {
  assert.equal(
    importer.physicalAddress('QD01LT01 – Rua Montevideo, 100'),
    importer.physicalAddress('QD09LT09 – Rua Montevideu, 100')
  );
  assert.equal(
    importer.physicalAddress('Rua Bueno Aires, 291'),
    importer.physicalAddress('Rua Buenos Aires, 291')
  );
});
