#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BackupManager } = require('../backup-manager');
const { AssociationManager } = require('../association-manager');
const { AccessStore } = require('../access-store');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.resolve(ROOT, process.env.PORTARIASYNC_DATA_DIR || 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_DIR = path.resolve(ROOT, process.env.BACKUP_DIR || '../portariasync-backups');
const enabled = !/^(?:0|false|no|off)$/i.test(String(process.env.BACKUP_ENABLED || 'true'));
const intervalHours = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const maxFiles = Number(process.env.BACKUP_MAX_FILES || 30);
const associations = new AssociationManager({
  dataDir: DATA_DIR,
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const access = new AccessStore({
  file: process.env.ACCESS_DB || path.join(DATA_DIR, 'access.sqlite'),
  usersFile: USERS_FILE,
  defaultAssociationId: 'principal',
  normalizeAssociationId: value => associations.get(String(value || ''))?.id || 'principal',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 8 * 60 * 60 * 1000),
  maxLoginAttempts: Number(process.env.ACCESS_MAX_LOGIN_ATTEMPTS || 5),
  lockDurationMs: Number(process.env.ACCESS_LOCK_MINUTES || 15) * 60 * 1000
});

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
    source: 'sqlite-multi-association-access',
    multiAssociation: associations.status(false),
    associations: associations.snapshotAll(),
    files: {
      'access-users.json': access.backupUsers(),
      'users-legacy.json': readJsonFile(USERS_FILE, [])
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
console.log('Multi-Associação incluída no backup:', associations.status(false).total, 'associação(ões).');
console.log('Diretório protegido fora da aplicação:', BACKUP_DIR);

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    manager.stop();
    access.close();
    associations.closeAll();
    clearInterval(keepAlive);
    process.exit(0);
  });
}
