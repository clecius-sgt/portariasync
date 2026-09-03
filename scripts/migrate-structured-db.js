#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { StructuredDatabase, SCHEMA_VERSION } = require('../structured-database');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SOURCE = path.join(DATA_DIR, 'app-state.json');
const TARGET = path.join(DATA_DIR, 'portariasync.sqlite');

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function counts(state) {
  return {
    moradores: Array.isArray(state?.moradores) ? state.moradores.length : 0,
    encomendas: Array.isArray(state?.encomendas) ? state.encomendas.length : 0,
    retirantes: Array.isArray(state?.retirantesRelacionados) ? state.retirantesRelacionados.length : 0,
    auditoria: Array.isArray(state?.auditoria) ? state.auditoria.length : 0
  };
}

function printCounts(label, value) {
  console.log(label + ':', value.moradores + ' moradores,', value.encomendas + ' encomendas,', value.retirantes + ' retirantes relacionados,', value.auditoria + ' eventos de auditoria.');
}

function sameCounts(a, b) {
  return a.moradores === b.moradores && a.encomendas === b.encomendas && a.retirantes === b.retirantes && a.auditoria === b.auditoria;
}

function run() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  if (!fs.existsSync(SOURCE)) throw new Error('data/app-state.json não encontrado.');
  const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const sourceCounts = counts(source);

  console.log('Fase 3 - Banco de dados estruturado');
  console.log('SQLite nativo do Node: OK');
  console.log('Schema PortariaSync:', SCHEMA_VERSION);
  printCounts('Origem JSON', sourceCounts);

  if (!apply) {
    const db = new StructuredDatabase({ file: ':memory:' });
    db.writeState(source);
    const targetCounts = counts(db.readState());
    printCounts('Simulação SQLite', targetCounts);
    console.log('Integridade:', db.integrity());
    db.close();
    if (!sameCounts(sourceCounts, targetCounts)) throw new Error('A simulação alterou a quantidade de registros.');
    console.log('DRY-RUN: banco em disco não foi alterado.');
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TARGET) && !force) {
    const existing = new StructuredDatabase({ file: TARGET });
    const status = existing.status();
    existing.close();
    if (status.exists) {
      console.log('Banco estruturado já contém dados. Nenhuma sobrescrita foi feita.');
      console.log(JSON.stringify(status, null, 2));
      return;
    }
  }

  const backup = path.join(DATA_DIR, 'app-state.before-sqlite-' + timestamp() + '.json');
  fs.copyFileSync(SOURCE, backup);
  const db = new StructuredDatabase({ file: TARGET });
  db.writeState(source);
  const targetCounts = counts(db.readState());
  const status = db.status();
  db.close();

  printCounts('SQLite gravado', targetCounts);
  console.log('Integridade:', status.integrity);
  console.log('Backup JSON:', backup);
  console.log('Banco:', TARGET);
  if (!sameCounts(sourceCounts, targetCounts)) throw new Error('A migração alterou a quantidade de registros.');
  console.log('MIGRAÇÃO CONCLUÍDA COM SUCESSO.');
}

try { run(); }
catch (error) {
  console.error('ERRO:', error.message);
  process.exitCode = 1;
}
