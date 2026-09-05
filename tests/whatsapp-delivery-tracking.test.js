'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhatsAppDeliveryStore } = require('../whatsapp-delivery-store');
const { WhatsAppProvider } = require('../whatsapp-provider');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portariasync-whatsapp-'));
  return { dir, file: path.join(dir, 'tracking.sqlite') };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('registra aceite, envio, recebimento e leitura sem armazenar telefone completo', () => {
  const { dir, file } = tempDb();
  const store = new WhatsAppDeliveryStore({ filePath: file, now: () => new Date('2026-09-05T01:00:00.000Z') });
  try {
    store.recordAccepted({
      provider: 'zapi',
      messageId: 'MSG-1',
      zaapId: 'ZAAP-1',
      phone: '5511997868841',
      kind: 'resident_otp'
    });

    store.handleDelivery({
      type: 'DeliveryCallback',
      messageId: 'MSG-1',
      zaapId: 'ZAAP-1',
      phone: '5511997868841',
      momment: Date.parse('2026-09-05T01:00:01.000Z')
    });

    store.handleMessageStatus({
      type: 'MessageStatusCallback',
      status: 'RECEIVED',
      ids: ['MSG-1'],
      phone: '5511997868841',
      momment: Date.parse('2026-09-05T01:00:02.000Z')
    });

    store.handleMessageStatus({
      type: 'MessageStatusCallback',
      status: 'READ',
      ids: ['MSG-1'],
      phone: '5511997868841',
      momment: Date.parse('2026-09-05T01:00:03.000Z')
    });

    const item = store.get('MSG-1');
    assert.equal(item.status, 'read');
    assert.equal(item.phone, '***8841');
    assert.equal(item.kind, 'resident_otp');
    assert.equal(item.sentAt, '2026-09-05T01:00:01.000Z');
    assert.equal(item.receivedAt, '2026-09-05T01:00:02.000Z');
    assert.equal(item.readAt, '2026-09-05T01:00:03.000Z');
    assert.equal(JSON.stringify(item).includes('5511997868841'), false);

    const summary = store.summary();
    assert.equal(summary.total, 1);
    assert.equal(summary.read, 1);
    assert.equal(summary.failed, 0);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('delivery com erro marca a mensagem como falha', () => {
  const { dir, file } = tempDb();
  const store = new WhatsAppDeliveryStore({ filePath: file });
  try {
    store.recordAccepted({ messageId: 'MSG-FAIL', zaapId: 'ZAAP-FAIL', phone: '5511999990000' });
    const result = store.handleDelivery({
      type: 'DeliveryCallback',
      messageId: 'MSG-FAIL',
      zaapId: 'ZAAP-FAIL',
      phone: '5511999990000',
      error: 'Phone number does not exist',
      momment: Date.now()
    });
    assert.equal(result.matched, true);
    assert.equal(store.get('MSG-FAIL').status, 'failed');
    assert.match(store.get('MSG-FAIL').error, /Phone number does not exist/);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('status atrasado não regride mensagem já lida', () => {
  const { dir, file } = tempDb();
  const store = new WhatsAppDeliveryStore({ filePath: file });
  try {
    store.recordAccepted({ messageId: 'MSG-ORDER', phone: '5511999991111' });
    store.handleMessageStatus({ status: 'READ', ids: ['MSG-ORDER'], phone: '5511999991111', momment: Date.now() });
    store.handleMessageStatus({ status: 'SENT', ids: ['MSG-ORDER'], phone: '5511999991111', momment: Date.now() + 1000 });
    assert.equal(store.get('MSG-ORDER').status, 'read');
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('provider Z-API preserva messageId e zaapId e registra aceite do OTP', async () => {
  const accepted = [];
  const provider = new WhatsAppProvider({
    env: {
      WHATSAPP_PROVIDER: 'zapi',
      ZAPI_URL: 'https://api.z-api.io/instances/teste/token/teste',
      ZAPI_CLIENT: 'cliente'
    },
    deliveryStore: { recordAccepted: data => accepted.push(data) },
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ zaapId: 'ZAAP-OTP', messageId: 'MSG-OTP', id: 'MSG-OTP' })
    })
  });

  const result = await provider.sendText(
    '11997868841',
    'PortalSync - código de acesso ao Portal do Morador: 123456.\nVálido por 10 minutos.'
  );

  assert.equal(result.deliveryStatus, 'accepted');
  assert.equal(result.messageId, 'MSG-OTP');
  assert.equal(result.zaapId, 'ZAAP-OTP');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].kind, 'resident_otp');
  assert.equal(accepted[0].phone, '5511997868841');
});

test('webhook server exige segredo e possui rotas de delivery e message-status', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'whatsapp-webhook-server.js'), 'utf8');
  assert.match(source, /ZAPI_WEBHOOK_SECRET/);
  assert.match(source, /\/api\/zapi\/delivery/);
  assert.match(source, /\/api\/zapi\/message-status/);
  assert.match(source, /DeliveryCallback/);
  assert.match(source, /MessageStatusCallback/);
  assert.match(source, /timingSafeEqual/);
});

test('configurador usa HTTPS e registra os dois webhooks oficiais da Z-API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'configure-zapi-webhooks.js'), 'utf8');
  assert.match(source, /update-webhook-delivery/);
  assert.match(source, /update-webhook-message-status/);
  assert.match(source, /PORTARIASYNC_PUBLIC_URL/);
  assert.match(source, /ZAPI_WEBHOOK_SECRET/);
  assert.match(source, /https:/);
});
