const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class BackupManager {
  constructor(options = {}) {
    this.backupDir = path.resolve(options.backupDir || path.join(process.cwd(), 'data', 'backups'));
    this.snapshotProvider = typeof options.snapshotProvider === 'function' ? options.snapshotProvider : async () => ({});
    this.enabled = options.enabled !== false;
    this.intervalHours = positiveNumber(options.intervalHours, 24);
    this.retentionDays = positiveNumber(options.retentionDays, 30);
    this.maxFiles = Math.max(1, Math.round(positiveNumber(options.maxFiles, 30)));
    this.startupDelayMs = Math.max(0, Number(options.startupDelayMs ?? 3000));
    this.timer = null;
    this.startupTimer = null;
    this.currentPromise = null;
    this.lastBackupAt = null;
    this.lastFile = null;
    this.lastSizeBytes = 0;
    this.lastReason = null;
    this.lastError = null;
    this.nextBackupAt = null;
  }

  ensureDir() {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
  }

  listFiles() {
    this.ensureDir();
    return fs.readdirSync(this.backupDir)
      .filter(name => /^portariasync-backup-.*\.json\.gz$/.test(name))
      .map(name => {
        const fullPath = path.join(this.backupDir, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  refreshStatusFromDisk() {
    const files = this.listFiles();
    if (!this.lastBackupAt && files[0]) {
      this.lastBackupAt = new Date(files[0].mtimeMs).toISOString();
      this.lastFile = files[0].name;
      this.lastSizeBytes = files[0].sizeBytes;
    }
    return files;
  }

  async prune(now = new Date()) {
    const files = this.listFiles();
    const cutoff = now.getTime() - this.retentionDays * 86400000;
    const remove = new Set();
    files.forEach((file, index) => {
      if (file.mtimeMs < cutoff || index >= this.maxFiles) remove.add(file.fullPath);
    });
    for (const fullPath of remove) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    return this.listFiles();
  }

  filename(reason, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
    const safeReason = String(reason || 'automatico').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'automatico';
    const suffix = crypto.randomBytes(3).toString('hex');
    return `portariasync-backup-${stamp}-${safeReason}-${suffix}.json.gz`;
  }

  async verify(fullPath) {
    const compressed = fs.readFileSync(fullPath);
    const raw = await gunzip(compressed);
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || parsed.schema !== 'portariasync-backup-v1' || !parsed.createdAt || !parsed.snapshot) {
      throw new Error('Backup criado, mas a verificação de integridade falhou.');
    }
    return true;
  }

  async create(reason = 'automatico') {
    if (!this.enabled) throw new Error('Backup automático desativado.');
    if (this.currentPromise) return this.currentPromise;

    this.currentPromise = (async () => {
      try {
        this.ensureDir();
        const now = new Date();
        const snapshot = await this.snapshotProvider();
        const payload = {
          schema: 'portariasync-backup-v1',
          createdAt: now.toISOString(),
          reason: String(reason || 'automatico'),
          snapshot
        };
        const raw = Buffer.from(JSON.stringify(payload), 'utf8');
        const compressed = await gzip(raw, { level: 6 });
        const name = this.filename(reason, now);
        const fullPath = path.join(this.backupDir, name);
        const tmpPath = fullPath + '.tmp';
        fs.writeFileSync(tmpPath, compressed, { mode: 0o600 });
        fs.renameSync(tmpPath, fullPath);
        await this.verify(fullPath);
        await this.prune(now);

        this.lastBackupAt = now.toISOString();
        this.lastFile = name;
        this.lastSizeBytes = compressed.length;
        this.lastReason = String(reason || 'automatico');
        this.lastError = null;
        return {
          ok: true,
          createdAt: this.lastBackupAt,
          file: name,
          sizeBytes: compressed.length,
          reason: this.lastReason,
          sha256: crypto.createHash('sha256').update(compressed).digest('hex')
        };
      } catch (error) {
        this.lastError = String(error?.message || error || 'Falha desconhecida no backup').slice(0, 300);
        throw error;
      } finally {
        this.currentPromise = null;
      }
    })();

    return this.currentPromise;
  }

  scheduleNext() {
    if (!this.enabled) {
      this.nextBackupAt = null;
      return;
    }
    this.nextBackupAt = new Date(Date.now() + this.intervalHours * 3600000).toISOString();
  }

  start() {
    if (!this.enabled || this.timer || this.startupTimer) return false;
    this.ensureDir();
    this.refreshStatusFromDisk();

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.create('startup').catch(error => console.warn('Backup automático inicial falhou:', error.message));
      this.scheduleNext();
    }, this.startupDelayMs);
    if (this.startupTimer.unref) this.startupTimer.unref();

    const intervalMs = this.intervalHours * 3600000;
    this.timer = setInterval(() => {
      this.create('agendado').catch(error => console.warn('Backup automático agendado falhou:', error.message));
      this.scheduleNext();
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();

    this.nextBackupAt = new Date(Date.now() + this.startupDelayMs).toISOString();
    return true;
  }

  stop() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
    this.nextBackupAt = null;
  }

  status() {
    const files = this.refreshStatusFromDisk();
    return {
      enabled: this.enabled,
      healthy: this.enabled && !this.lastError,
      intervalHours: this.intervalHours,
      retentionDays: this.retentionDays,
      maxFiles: this.maxFiles,
      count: files.length,
      totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      lastBackupAt: this.lastBackupAt,
      lastFile: this.lastFile,
      lastSizeBytes: this.lastSizeBytes,
      lastReason: this.lastReason,
      lastError: this.lastError,
      nextBackupAt: this.nextBackupAt
    };
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { BackupManager };
