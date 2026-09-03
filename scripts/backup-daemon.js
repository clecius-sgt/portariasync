#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BackupManager } = require('../backup-manager');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const APP_STATE_FILE = path.join(DATA_DIR, 'app-state.json');
const BACKUP_DIR = path.resolve(ROOT, process.env.BACKUP_DIR || '../portariasync-backups');
const enabled = !/^(?:0|false|no|off)$/i.test(String(process.env.BACKUP_ENABLED || 'true'));
const intervalHours = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const maxFiles = Number(process.env.BACKUP_MAX_FILES || 30);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('Não foi possível ler ' + path.basename(file) + ': ' + error.message);
  }
}

const manager = new BackupManager({
  backupDir: BACKUP_DIR,
  enabled,
  intervalHours,
  retentionDays,
  maxFiles,
  startupDelayMs: 1500,
  snapshotProvider: async () => ({
    source: 'vps-local-mirror',
    files: {
      'users.json': readJsonFile(USERS_FILE, []),
      'app-state.json': readJsonFile(APP_STATE_FILE, { exists: false, version: 0, updatedAt: null })
    }
  })
});

manager.start();
console.log(
  'Backup automático do PortariaSync ativo:',
  'a cada ' + manager.intervalHours + 'h,',
  'retenção de ' + manager.retentionDays + ' dias,',
  'máximo de ' + manager.maxFiles + ' arquivos.'
);
console.log('Diretório protegido fora da aplicação:', BACKUP_DIR);

// Mantém este daemon ativo no PM2. Os timers internos do BackupManager são unref
// para não prender o processo principal quando o módulo for usado em testes.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    manager.stop();
    clearInterval(keepAlive);
    process.exit(0);
  });
}
