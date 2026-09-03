const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { BackupManager } = require('../backup-manager');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-backup-'));
}

function readBackup(file) {
  const compressed = fs.readFileSync(file);
  return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

test('backup cria arquivo gzip íntegro com estado e usuários', async () => {
  const dir = tempDir();
  const manager = new BackupManager({
    backupDir: dir,
    maxFiles: 5,
    retentionDays: 30,
    snapshotProvider: async () => ({
      source: 'teste',
      files: {
        'users.json': [{ id: 'u1', password: 'hash' }],
        'app-state.json': { version: 123, moradores: [{ id: '1' }] }
      }
    })
  });

  const result = await manager.create('teste');
  assert.equal(result.ok, true);
  assert.match(result.file, /^portariasync-backup-.*\.json\.gz$/);
  assert.equal(result.sha256.length, 64);

  const payload = readBackup(path.join(dir, result.file));
  assert.equal(payload.schema, 'portariasync-backup-v1');
  assert.equal(payload.reason, 'teste');
  assert.equal(payload.snapshot.files['app-state.json'].version, 123);
  assert.equal(payload.snapshot.files['users.json'][0].password, 'hash');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});

test('retenção mantém no máximo a quantidade configurada', async () => {
  const dir = tempDir();
  let version = 0;
  const manager = new BackupManager({
    backupDir: dir,
    maxFiles: 2,
    retentionDays: 30,
    snapshotProvider: async () => ({ version: ++version })
  });

  await manager.create('um');
  await new Promise(resolve => setTimeout(resolve, 5));
  await manager.create('dois');
  await new Promise(resolve => setTimeout(resolve, 5));
  await manager.create('tres');

  const files = manager.listFiles();
  assert.equal(files.length, 2);
  assert.equal(manager.status().count, 2);
});

test('status informa periodicidade, retenção e último backup sem expor conteúdo', async () => {
  const dir = tempDir();
  const manager = new BackupManager({
    backupDir: dir,
    intervalHours: 24,
    retentionDays: 30,
    maxFiles: 30,
    snapshotProvider: async () => ({ segredo: 'não deve aparecer no status' })
  });
  await manager.create('manual');
  const status = manager.status();
  assert.equal(status.enabled, true);
  assert.equal(status.intervalHours, 24);
  assert.equal(status.retentionDays, 30);
  assert.equal(status.maxFiles, 30);
  assert.equal(status.count, 1);
  assert.equal(status.lastReason, 'manual');
  assert.equal(JSON.stringify(status).includes('segredo'), false);
});

test('daemon usa backup diário protegido fora da aplicação e não inclui .env no snapshot', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup-daemon.js'), 'utf8');
  assert.match(source, /BACKUP_INTERVAL_HOURS\s*\|\|\s*24/);
  assert.match(source, /BACKUP_RETENTION_DAYS\s*\|\|\s*30/);
  assert.match(source, /BACKUP_MAX_FILES\s*\|\|\s*30/);
  assert.match(source, /\.\.\/portariasync-backups/);
  assert.match(source, /'users\.json'/);
  assert.match(source, /'app-state\.json'/);
  assert.doesNotMatch(source, /files:\s*\{[^}]*\.env/s);
});
