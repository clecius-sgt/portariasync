'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const STATUS_ORDER = {
  accepted: 10,
  sent: 20,
  received: 30,
  read: 40,
  read_by_me: 40,
  played: 50,
  failed: 90
};

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(value) {
  const raw = digits(value);
  return raw ? '***' + raw.slice(-4) : '';
}

function phoneHash(value) {
  const raw = digits(value);
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
}

function isoFromMoment(value, fallback = new Date()) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : fallback;
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeId(value) {
  if (value && typeof value === 'object') {
    return String(value.messageId || value.id || value.zaapId || '').trim();
  }
  return String(value || '').trim();
}

function normalizeStatus(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'SENT') return 'sent';
  if (upper === 'RECEIVED') return 'received';
  if (upper === 'READ') return 'read';
  if (upper === 'READ_BY_ME') return 'read_by_me';
  if (upper === 'PLAYED') return 'played';
  if (upper === 'FAILED' || upper === 'ERROR') return 'failed';
  return '';
}

class WhatsAppDeliveryStore {
  constructor(options = {}) {
    const filePath = options.filePath || path.join(__dirname, 'data', 'whatsapp-delivery.sqlite');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.now = options.now || (() => new Date());
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        tracking_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        message_id TEXT,
        zaap_id TEXT,
        phone_masked TEXT,
        phone_hash TEXT,
        kind TEXT NOT NULL DEFAULT 'text',
        association_id TEXT,
        reference_id TEXT,
        status TEXT NOT NULL DEFAULT 'accepted',
        accepted_at TEXT,
        sent_at TEXT,
        received_at TEXT,
        read_at TEXT,
        played_at TEXT,
        failed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_message_id
        ON whatsapp_messages(message_id);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_zaap_id
        ON whatsapp_messages(zaap_id);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
        ON whatsapp_messages(status);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_updated_at
        ON whatsapp_messages(updated_at DESC);

      CREATE TABLE IF NOT EXISTS whatsapp_message_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT NOT NULL,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        status TEXT,
        occurred_at TEXT NOT NULL,
        error TEXT,
        FOREIGN KEY(tracking_id) REFERENCES whatsapp_messages(tracking_id)
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_events_tracking
        ON whatsapp_message_events(tracking_id, occurred_at);
    `);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }

  findTrackingId(id) {
    const normalized = normalizeId(id);
    if (!normalized) return '';
    const row = this.db.prepare(`
      SELECT tracking_id
      FROM whatsapp_messages
      WHERE tracking_id = ? OR message_id = ? OR zaap_id = ?
      LIMIT 1
    `).get(normalized, normalized, normalized);
    return row?.tracking_id || '';
  }

  ensureMessage(data = {}) {
    const messageId = normalizeId(data.messageId);
    const zaapId = normalizeId(data.zaapId);
    const trackingId = normalizeId(data.trackingId) || messageId || zaapId;
    if (!trackingId) return null;

    const nowIso = data.at || this.now().toISOString();
    const phone = digits(data.phone);
    this.db.prepare(`
      INSERT INTO whatsapp_messages (
        tracking_id, provider, message_id, zaap_id, phone_masked, phone_hash,
        kind, association_id, reference_id, status, accepted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tracking_id) DO UPDATE SET
        message_id = COALESCE(NULLIF(excluded.message_id, ''), whatsapp_messages.message_id),
        zaap_id = COALESCE(NULLIF(excluded.zaap_id, ''), whatsapp_messages.zaap_id),
        phone_masked = COALESCE(NULLIF(excluded.phone_masked, ''), whatsapp_messages.phone_masked),
        phone_hash = COALESCE(NULLIF(excluded.phone_hash, ''), whatsapp_messages.phone_hash),
        kind = CASE WHEN excluded.kind <> 'text' THEN excluded.kind ELSE whatsapp_messages.kind END,
        association_id = COALESCE(NULLIF(excluded.association_id, ''), whatsapp_messages.association_id),
        reference_id = COALESCE(NULLIF(excluded.reference_id, ''), whatsapp_messages.reference_id),
        updated_at = excluded.updated_at
    `).run(
      trackingId,
      String(data.provider || 'zapi'),
      messageId,
      zaapId,
      maskPhone(phone),
      phoneHash(phone),
      String(data.kind || 'text').slice(0, 80),
      String(data.associationId || '').slice(0, 120),
      String(data.referenceId || '').slice(0, 160),
      String(data.status || 'accepted'),
      data.acceptedAt || nowIso,
      nowIso,
      nowIso
    );
    return trackingId;
  }

  addEvent(trackingId, eventType, status, occurredAt, error = '') {
    const when = occurredAt || this.now().toISOString();
    const key = crypto.createHash('sha256')
      .update([trackingId, eventType, status || '', when, error || ''].join('|'))
      .digest('hex');
    this.db.prepare(`
      INSERT OR IGNORE INTO whatsapp_message_events
        (tracking_id, event_key, event_type, status, occurred_at, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trackingId, key, eventType, status || null, when, error || null);
  }

  recordAccepted(data = {}) {
    const at = data.at || this.now().toISOString();
    const trackingId = this.ensureMessage({ ...data, status: 'accepted', acceptedAt: at, at });
    if (!trackingId) return null;
    this.addEvent(trackingId, 'provider_accepted', 'accepted', at);
    return this.get(trackingId);
  }

  applyStatus(trackingId, status, occurredAt, error = '') {
    const normalized = normalizeStatus(status) || String(status || '').toLowerCase();
    if (!STATUS_ORDER[normalized]) return this.get(trackingId);
    const current = this.get(trackingId);
    if (!current) return null;
    const when = occurredAt || this.now().toISOString();
    const currentRank = STATUS_ORDER[current.status] || 0;
    const nextRank = STATUS_ORDER[normalized] || 0;
    const effectiveStatus = normalized === 'failed' || nextRank >= currentRank ? normalized : current.status;

    const fields = {
      sent: 'sent_at',
      received: 'received_at',
      read: 'read_at',
      read_by_me: 'read_at',
      played: 'played_at',
      failed: 'failed_at'
    };
    const timestampField = fields[normalized];
    const updates = ['status = ?', 'updated_at = ?'];
    const values = [effectiveStatus, when];
    if (timestampField) {
      updates.push(`${timestampField} = COALESCE(${timestampField}, ?)`);
      values.push(when);
    }
    if (normalized === 'failed') {
      updates.push('error = ?');
      values.push(String(error || 'Falha informada pelo provedor').slice(0, 500));
    }
    values.push(trackingId);
    this.db.prepare(`UPDATE whatsapp_messages SET ${updates.join(', ')} WHERE tracking_id = ?`).run(...values);
    this.addEvent(trackingId, 'status_update', normalized, when, error);
    return this.get(trackingId);
  }

  handleDelivery(payload = {}) {
    const messageId = normalizeId(payload.messageId);
    const zaapId = normalizeId(payload.zaapId);
    let trackingId = this.findTrackingId(messageId) || this.findTrackingId(zaapId);
    const at = isoFromMoment(payload.momment, this.now());
    if (!trackingId) {
      trackingId = this.ensureMessage({
        messageId,
        zaapId,
        phone: payload.phone,
        provider: 'zapi',
        status: 'accepted',
        acceptedAt: at,
        at
      });
    }
    if (!trackingId) return { matched: false };
    const error = String(payload.error || '').trim();
    this.addEvent(trackingId, 'delivery_callback', error ? 'failed' : 'sent', at, error);
    const message = this.applyStatus(trackingId, error ? 'failed' : 'sent', at, error);
    return { matched: true, message };
  }

  handleMessageStatus(payload = {}) {
    const status = normalizeStatus(payload.status);
    if (!status) return { matched: 0, ignored: true };
    const at = isoFromMoment(payload.momment, this.now());
    const ids = Array.isArray(payload.ids) ? payload.ids.map(normalizeId).filter(Boolean) : [];
    let matched = 0;
    const messages = [];
    for (const id of ids) {
      let trackingId = this.findTrackingId(id);
      if (!trackingId) {
        trackingId = this.ensureMessage({
          trackingId: id,
          messageId: id,
          phone: payload.phone,
          provider: 'zapi',
          status: 'accepted',
          acceptedAt: at,
          at
        });
      }
      if (!trackingId) continue;
      this.addEvent(trackingId, 'message_status_callback', status, at);
      const message = this.applyStatus(trackingId, status, at);
      matched++;
      messages.push(message);
    }
    return { matched, messages };
  }

  get(id) {
    const trackingId = this.findTrackingId(id) || normalizeId(id);
    if (!trackingId) return null;
    const row = this.db.prepare(`
      SELECT tracking_id, provider, message_id, zaap_id, phone_masked, kind,
             association_id, reference_id, status, accepted_at, sent_at,
             received_at, read_at, played_at, failed_at, error, created_at, updated_at
      FROM whatsapp_messages
      WHERE tracking_id = ?
    `).get(trackingId);
    if (!row) return null;
    return {
      trackingId: row.tracking_id,
      provider: row.provider,
      messageId: row.message_id,
      zaapId: row.zaap_id,
      phone: row.phone_masked,
      kind: row.kind,
      associationId: row.association_id || null,
      referenceId: row.reference_id || null,
      status: row.status,
      acceptedAt: row.accepted_at,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      readAt: row.read_at,
      playedAt: row.played_at,
      failedAt: row.failed_at,
      error: row.error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  list(limit = 25) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));
    return this.db.prepare(`
      SELECT tracking_id
      FROM whatsapp_messages
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeLimit).map(row => this.get(row.tracking_id));
  }

  summary() {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS total FROM whatsapp_messages').get()?.total || 0);
    const rows = this.db.prepare('SELECT status, COUNT(*) AS total FROM whatsapp_messages GROUP BY status').all();
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = Number(row.total || 0);
    const last = this.db.prepare('SELECT updated_at FROM whatsapp_messages ORDER BY updated_at DESC LIMIT 1').get();
    return {
      enabled: true,
      total,
      accepted: byStatus.accepted || 0,
      sent: byStatus.sent || 0,
      received: byStatus.received || 0,
      read: (byStatus.read || 0) + (byStatus.read_by_me || 0),
      played: byStatus.played || 0,
      failed: byStatus.failed || 0,
      lastUpdateAt: last?.updated_at || null
    };
  }
}

module.exports = {
  WhatsAppDeliveryStore,
  normalizeStatus,
  maskPhone
};
