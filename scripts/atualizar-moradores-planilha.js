'use strict';

const fs = require('fs');
const path = require('path');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\brua\s+bueno\s+aires\b/g, 'rua buenos aires')
    .replace(/\brua\s+montevideo\b/g, 'rua montevideu')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function physicalAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/\b(rua|r\.?|avenida|av\.?|alameda|travessa|trav\.?)\s+.+$/i);
  return normalizeText(match ? match[0] : text);
}

function residentKey(resident) {
  return normalizeText(resident?.nome) + '|' + physicalAddress(resident?.casa);
}

function residentNameKey(resident) {
  return normalizeText(resident?.nome);
}

function sourcePhones(source) {
  const values = Array.isArray(source?.whatsAlternativos) ? source.whatsAlternativos : [source?.whats];
  return [...new Set(values.map(digits).filter(Boolean))];
}

function choosePhone(existing, source) {
  const alternatives = sourcePhones(source);
  const current = digits(existing?.whats);
  if (current && alternatives.includes(current)) return current;
  return digits(source?.whats) || alternatives[0] || current || '';
}

function uniqueId(base, used) {
  const clean = String(base || 'cadastro').replace(/[^a-zA-Z0-9_-]/g, '') || 'cadastro';
  if (!used.has(clean)) return clean;
  let n = 2;
  while (used.has(clean + '_' + n)) n++;
  return clean + '_' + n;
}

function mergeRoster(state, roster, now = () => new Date()) {
  if (!state || typeof state !== 'object') throw new Error('Estado do aplicativo inválido.');
  if (!Array.isArray(roster)) throw new Error('Cadastro importado deve ser uma lista.');

  const current = Array.isArray(state.moradores) ? state.moradores.map(item => ({ ...item })) : [];
  const usedIds = new Set(current.map(item => String(item?.id || '')).filter(Boolean));
  const currentByExact = new Map();
  const currentByName = new Map();

  for (const resident of current) {
    const exact = residentKey(resident);
    if (!currentByExact.has(exact)) currentByExact.set(exact, []);
    currentByExact.get(exact).push(resident);
    const name = residentNameKey(resident);
    if (!currentByName.has(name)) currentByName.set(name, []);
    currentByName.get(name).push(resident);
  }

  const sourceNameCounts = new Map();
  for (const source of roster) {
    const name = residentNameKey(source);
    sourceNameCounts.set(name, Number(sourceNameCounts.get(name) || 0) + 1);
  }

  const matched = new Set();
  const summary = {
    source: roster.length,
    updated: 0,
    unchanged: 0,
    added: 0,
    legacyRetained: 0,
    conflicts: []
  };

  for (const source of roster) {
    if (!source || !source.nome || !source.casa) continue;
    const exactCandidates = (currentByExact.get(residentKey(source)) || []).filter(item => !matched.has(item));
    let target = exactCandidates.length === 1 ? exactCandidates[0] : null;

    if (!target) {
      const name = residentNameKey(source);
      const byName = (currentByName.get(name) || []).filter(item => !matched.has(item));
      if (byName.length === 1 && Number(sourceNameCounts.get(name) || 0) === 1) target = byName[0];
    }

    const alternatives = sourcePhones(source);
    if (alternatives.length > 1) {
      summary.conflicts.push({
        nome: source.nome,
        casa: source.casa,
        alternativas: alternatives.map(phone => '***' + phone.slice(-4))
      });
    }

    if (target) {
      const before = JSON.stringify({ nome: target.nome, casa: target.casa, whats: digits(target.whats) });
      target.nome = String(source.nome).trim();
      target.casa = String(source.casa).trim();
      target.whats = choosePhone(target, source);
      target.tipo = source.tipo || target.tipo || '';
      target.unidadesOrigem = Array.isArray(source.unidadesOrigem) ? source.unidadesOrigem : (target.unidadesOrigem || []);
      target.cadastroFonte = 'Cadastro de Moradores - 03.09.2026';
      target.cadastroAtualizadoEm = now().toISOString();
      matched.add(target);
      const after = JSON.stringify({ nome: target.nome, casa: target.casa, whats: digits(target.whats) });
      if (before === after) summary.unchanged++;
      else summary.updated++;
      continue;
    }

    const id = uniqueId(source.idSugerido || ('cad_' + Date.now()), usedIds);
    usedIds.add(id);
    const added = {
      id,
      nome: String(source.nome).trim(),
      casa: String(source.casa).trim(),
      whats: choosePhone(null, source),
      tipo: source.tipo || '',
      unidadesOrigem: Array.isArray(source.unidadesOrigem) ? source.unidadesOrigem : [],
      cadastroFonte: 'Cadastro de Moradores - 03.09.2026',
      cadastroAtualizadoEm: now().toISOString()
    };
    current.push(added);
    matched.add(added);
    summary.added++;
  }

  summary.legacyRetained = current.filter(item => !matched.has(item)).length;
  state.moradores = current;
  state.version = Date.now();
  state.updatedAt = now().toISOString();
  return { state, summary };
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), '-', pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join('');
}

function runCli(argv = process.argv.slice(2)) {
  const rosterPath = argv.find(arg => arg && !arg.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (!rosterPath) {
    console.error('Uso: node scripts/atualizar-moradores-planilha.js <cadastro.json> [--dry-run]');
    process.exitCode = 2;
    return;
  }

  const appStatePath = path.join(__dirname, '..', 'data', 'app-state.json');
  if (!fs.existsSync(appStatePath)) throw new Error('data/app-state.json não encontrado.');
  const roster = JSON.parse(fs.readFileSync(path.resolve(rosterPath), 'utf8'));
  const state = JSON.parse(fs.readFileSync(appStatePath, 'utf8'));
  const { state: merged, summary } = mergeRoster(state, roster);

  console.log('Cadastro da planilha:', summary.source);
  console.log('Atualizados:', summary.updated);
  console.log('Sem alteração:', summary.unchanged);
  console.log('Adicionados:', summary.added);
  console.log('Cadastros anteriores preservados:', summary.legacyRetained);
  if (summary.conflicts.length) {
    console.log('Conflitos de telefone preservados para revisão:');
    for (const item of summary.conflicts) console.log(' - ' + item.nome + ' | ' + item.casa + ' | ' + item.alternativas.join(' / '));
  }

  const lucimara = merged.moradores.find(item => /lucimara/i.test(String(item.nome || '')));
  if (lucimara) {
    const phone = digits(lucimara.whats);
    console.log('Lucimara:', phone ? '***' + phone.slice(-4) + ' (' + phone.length + ' dígitos)' : 'SEM WHATSAPP');
  }

  if (dryRun) {
    console.log('DRY-RUN: nenhum arquivo foi alterado.');
    return;
  }

  const backupPath = path.join(path.dirname(appStatePath), 'app-state.before-moradores-' + timestamp() + '.json');
  fs.copyFileSync(appStatePath, backupPath);
  const tmp = appStatePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, appStatePath);
  console.log('Backup:', backupPath);
  console.log('Cadastro atualizado com sucesso.');
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error('ERRO:', error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  digits,
  normalizeText,
  physicalAddress,
  residentKey,
  sourcePhones,
  choosePhone,
  mergeRoster
};
