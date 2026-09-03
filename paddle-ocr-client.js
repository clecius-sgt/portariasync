'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');

const PREFIX = 'PORTARIASYNC_JSON:';

function enabled(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function parseImageDataUrl(value, maxBytes = 10 * 1024 * 1024) {
  const text = String(value || '');
  const match = text.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    const err = new Error('Imagem inválida para OCR.');
    err.statusCode = 400;
    throw err;
  }
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) {
    const err = new Error('Imagem vazia para OCR.');
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > maxBytes) {
    const err = new Error('Imagem muito grande para OCR.');
    err.statusCode = 413;
    throw err;
  }
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  return { buffer, ext };
}

class PaddleOcrClient {
  constructor(options = {}) {
    this.baseDir = options.baseDir || __dirname;
    this.python = options.python || process.env.PADDLE_PYTHON || path.join(this.baseDir, '.venv-paddleocr', 'bin', 'python');
    this.worker = options.worker || path.join(this.baseDir, 'scripts', 'paddleocr_worker.py');
    this.timeoutMs = Number(options.timeoutMs || process.env.PADDLE_OCR_TIMEOUT_MS || 60000);
    this.startupTimeoutMs = Number(options.startupTimeoutMs || process.env.PADDLE_OCR_STARTUP_TIMEOUT_MS || Math.max(this.timeoutMs, 120000));
    this.prewarmEnabled = options.prewarm !== undefined ? !!options.prewarm : enabled(process.env.PADDLE_OCR_PREWARM, true);
    this.proc = null;
    this.ready = false;
    this.starting = null;
    this.pending = new Map();
    this.stderrTail = '';
    this.warmupMs = null;
    this.warmedAt = null;
    this.lastError = '';

    // Fase 1: tira o custo de carregar modelos e executar a primeira inferência
    // do primeiro operador. O servidor continua subindo normalmente enquanto o
    // worker aquece em segundo plano. Se uma leitura chegar antes, ela reutiliza
    // exatamente a mesma Promise de inicialização em start().
    if (this.prewarmEnabled && this.installed()) {
      setImmediate(() => {
        this.prewarm().catch(error => {
          this.lastError = error.message;
          console.warn('Pré-aquecimento do PaddleOCR não concluído:', error.message);
        });
      });
    }
  }

  installed() {
    return fs.existsSync(this.python) && fs.existsSync(this.worker);
  }

  status() {
    return {
      installed: this.installed(),
      running: !!(this.proc && !this.proc.killed),
      ready: this.ready,
      pending: this.pending.size,
      prewarm: this.prewarmEnabled,
      warming: !!this.starting && !this.ready,
      warmed: this.ready,
      warmupMs: this.warmupMs,
      warmedAt: this.warmedAt,
      lastError: this.lastError || null
    };
  }

  async prewarm() {
    if (!this.prewarmEnabled) return this.status();
    await this.start();
    return this.status();
  }

  async start() {
    if (this.ready && this.proc && !this.proc.killed) return;
    if (this.starting) return this.starting;
    if (!this.installed()) {
      const err = new Error('PaddleOCR ainda não foi instalado no VPS. Execute scripts/install-paddleocr.sh.');
      err.statusCode = 503;
      this.lastError = err.message;
      throw err;
    }

    this.starting = new Promise((resolve, reject) => {
      const proc = spawn(this.python, ['-u', this.worker], {
        cwd: this.baseDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || 'True'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.proc = proc;
      this.ready = false;
      this.stderrTail = '';
      this.lastError = '';

      const startupTimer = setTimeout(() => {
        const error = new Error('PaddleOCR demorou demais para iniciar e pré-aquecer.');
        this.lastError = error.message;
        reject(error);
        this._kill();
      }, this.startupTimeoutMs);

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', line => this._handleLine(line, () => {
        clearTimeout(startupTimer);
        resolve();
      }, error => {
        clearTimeout(startupTimer);
        reject(error);
      }));

      proc.stderr.on('data', chunk => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
      });

      proc.on('error', error => {
        clearTimeout(startupTimer);
        this.lastError = error.message;
        this._failAll(error);
        reject(error);
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(startupTimer);
        const detail = this.stderrTail.trim();
        const error = new Error(`PaddleOCR encerrou inesperadamente (${signal || code}).${detail ? ' ' + detail.slice(-700) : ''}`);
        this.ready = false;
        this.proc = null;
        this.starting = null;
        this.lastError = error.message;
        this._failAll(error);
      });
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  _handleLine(line, onReady, onStartupError) {
    if (!line.startsWith(PREFIX)) return;
    let message;
    try {
      message = JSON.parse(line.slice(PREFIX.length));
    } catch {
      return;
    }

    if (message.type === 'ready') {
      this.ready = true;
      this.warmupMs = Number.isFinite(Number(message.warmupMs)) ? Number(message.warmupMs) : null;
      this.warmedAt = new Date().toISOString();
      this.lastError = '';
      onReady();
      return;
    }
    if (message.type === 'startup_error') {
      const error = new Error(message.error || 'Falha ao iniciar PaddleOCR.');
      error.statusCode = 503;
      this.lastError = error.message;
      onStartupError(error);
      this._kill();
      return;
    }

    const pending = message.id ? this.pending.get(message.id) : null;
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try { fs.unlinkSync(pending.file); } catch (_) {}
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error || 'Falha no PaddleOCR.');
      error.statusCode = 502;
      pending.reject(error);
    }
  }

  _failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      try { fs.unlinkSync(pending.file); } catch (_) {}
      pending.reject(error);
    }
    this.pending.clear();
  }

  _kill() {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
    this.proc = null;
    this.ready = false;
  }

  async recognize(imageDataUrl) {
    const { buffer, ext } = parseImageDataUrl(imageDataUrl);
    await this.start();
    const id = crypto.randomUUID();
    const file = path.join(os.tmpdir(), `portariasync-ocr-${id}.${ext}`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { fs.unlinkSync(file); } catch (_) {}
        reject(new Error('A leitura PaddleOCR excedeu o tempo limite.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, file });
      try {
        this.proc.stdin.write(JSON.stringify({ id, path: file }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        try { fs.unlinkSync(file); } catch (_) {}
        reject(error);
      }
    });
  }

  stop() {
    this._kill();
  }
}

module.exports = { PaddleOcrClient, parseImageDataUrl, PREFIX, enabled };
