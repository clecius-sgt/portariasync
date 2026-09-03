const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WhatsAppProvider, normalizePhone } = require('../whatsapp-provider');
const client = require('../whatsapp-client');

function metaEnv(extra = {}) {
  return {
    WHATSAPP_PROVIDER: 'meta',
    META_WHATSAPP_ACCESS_TOKEN: 'segredo-token',
    META_WHATSAPP_PHONE_NUMBER_ID: '123456789',
    META_WHATSAPP_WABA_ID: '987654321',
    META_GRAPH_API_VERSION: 'vXX.X',
    META_WHATSAPP_TEMPLATE_PACKAGE: 'aviso_encomenda_portaria',
    META_WHATSAPP_TEMPLATE_REMINDER: 'lembrete_encomenda_portaria',
    META_WHATSAPP_TEMPLATE_LANGUAGE: 'pt_BR',
    ...extra
  };
}

test('normaliza telefone brasileiro sem duplicar código do país', () => {
  assert.equal(normalizePhone('(11) 99786-8841'), '5511997868841');
  assert.equal(normalizePhone('5511997868841'), '5511997868841');
});

test('status da Meta informa configuração sem expor token quando Meta é escolhida explicitamente', () => {
  const provider = new WhatsAppProvider({ env: metaEnv(), fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const status = provider.status();
  assert.equal(status.provider, 'meta');
  assert.equal(status.configured, true);
  assert.equal(status.mode, 'official-cloud-api');
  assert.equal(status.meta.accessTokenConfigured, true);
  assert.equal(status.meta.packageTemplate, 'aviso_encomenda_portaria');
  assert.equal(JSON.stringify(status).includes('segredo-token'), false);
});

test('sem escolha explícita, Z-API é o provedor padrão mesmo se existirem credenciais Meta', () => {
  const provider = new WhatsAppProvider({
    env: {
      ZAPI_URL: 'https://api.z-api.io/instances/teste/token/teste',
      ZAPI_CLIENT: 'cliente',
      META_WHATSAPP_ACCESS_TOKEN: 'token-meta-antigo',
      META_WHATSAPP_PHONE_NUMBER_ID: '123',
      META_GRAPH_API_VERSION: 'vXX.X'
    },
    fetchFn: async () => ({ ok: true, status: 200 })
  });
  const status = provider.status();
  assert.equal(status.provider, 'zapi');
  assert.equal(status.configured, true);
  assert.equal(status.mode, 'zapi');
});

test('aviso de encomenda usa template oficial com dados estruturados quando Meta é escolhida explicitamente', async () => {
  let request = null;
  const provider = new WhatsAppProvider({
    env: metaEnv(),
    fetchFn: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    }
  });
  const result = await provider.sendPackage({
    numero: '11997868841',
    nome: 'Lucimara Gonçalves Salomé',
    codigo: 'BR260699888470G',
    transportadora: 'Transportadora',
    casa: 'Rua Brasilia, 311'
  });
  assert.equal(result.provider, 'meta');
  assert.match(request.url, /graph\.facebook\.com\/vXX\.X\/123456789\/messages$/);
  assert.equal(request.body.type, 'template');
  assert.equal(request.body.template.name, 'aviso_encomenda_portaria');
  assert.deepEqual(request.body.template.components[0].parameters.map(item => item.text), [
    'Lucimara Gonçalves Salomé',
    'BR260699888470G',
    'Transportadora',
    'Rua Brasilia, 311'
  ]);
});

test('falha na Meta não dispara fallback automático para Z-API quando Meta foi selecionada', async () => {
  let calls = 0;
  const provider = new WhatsAppProvider({
    env: metaEnv({
      ZAPI_URL: 'https://api.z-api.io/instances/teste/token/teste',
      ZAPI_CLIENT: 'cliente-legado'
    }),
    fetchFn: async url => {
      calls++;
      assert.match(url, /^https:\/\/graph\.facebook\.com\//);
      return { ok: false, status: 500, json: async () => ({ error: { message: 'falha meta' } }) };
    }
  });
  await assert.rejects(provider.sendPackage({ numero: '11997868841', nome: 'Teste', codigo: 'ABC123456', transportadora: 'Teste', casa: 'Teste' }), /falha meta/);
  assert.equal(calls, 1);
});

test('Z-API envia aviso como provedor principal', async () => {
  let request = null;
  const provider = new WhatsAppProvider({
    env: {
      WHATSAPP_PROVIDER: 'zapi',
      ZAPI_URL: 'https://api.z-api.io/instances/teste/token/teste',
      ZAPI_CLIENT: 'cliente'
    },
    fetchFn: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200 };
    }
  });
  const result = await provider.sendPackage({ numero: '11997868841', nome: 'Morador', codigo: 'ABC123', transportadora: 'Teste', casa: 'Casa 1' });
  assert.equal(result.provider, 'zapi');
  assert.match(request.url, /\/send-text$/);
  assert.match(request.body.message, /ABC123/);
});

test('cliente envia aviso e lembrete por endpoints estruturados', async () => {
  const calls = [];
  const host = {
    config: { mensagem: 'Olá {nome} - {codigo}' },
    apiFetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
    diasAguardandoRetirada: () => 4,
    toast() {},
    console
  };
  const morador = { nome: 'Lucimara', casa: 'Rua Brasilia, 311', whats: '11997868841' };
  const enc = { codigo: 'BR260699888470G', transportadora: 'Transportadora' };
  assert.equal(await client.sendPackage(host, morador, enc), true);
  assert.equal(await client.sendReminder(host, morador, enc), true);
  assert.equal(calls[0].url, '/api/whatsapp/package');
  assert.equal(calls[0].body.codigo, 'BR260699888470G');
  assert.equal(calls[1].url, '/api/whatsapp/reminder');
  assert.equal(calls[1].body.dias, 4);
});

test('servidor expõe rotas estruturadas e health informa o provedor sem credenciais', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /new WhatsAppProvider\(\)/);
  assert.match(source, /\/api\/whatsapp\/status/);
  assert.match(source, /\/api\/whatsapp\/package/);
  assert.match(source, /\/api\/whatsapp\/reminder/);
  assert.match(source, /\/api\/whatsapp\/test/);
  assert.match(source, /whatsappProvider:\s*whats/);
});
