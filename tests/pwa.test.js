const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pwa = require('../pwa');

const root = path.join(__dirname, '..');

test('manifesto define PortariaSync como aplicativo standalone com ícones escaláveis', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'PortariaSync - Controle de Encomendas');
  assert.equal(manifest.short_name, 'PortariaSync');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#1a1f3a');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
});

test('PWA registra service worker somente em contexto seguro', async () => {
  let registered = null;
  let updated = 0;
  const host = {
    location: { protocol: 'https:', hostname: 'portaria.clecius.tech' },
    navigator: {
      serviceWorker: {
        async register(url, options) {
          registered = { url, options };
          return { async update() { updated++; } };
        }
      }
    }
  };
  const result = await pwa.registerServiceWorker(host);
  assert.ok(result);
  assert.equal(registered.url, '/sw.js?v=20260903-3');
  assert.equal(registered.options.scope, '/');
  assert.equal(registered.options.updateViaCache, 'none');
  assert.equal(updated, 1);

  const insecure = await pwa.registerServiceWorker({
    location: { protocol: 'http:', hostname: 'exemplo.test' },
    navigator: { serviceWorker: { register() { throw new Error('não deve registrar'); } } }
  });
  assert.equal(insecure, null);
});

test('service worker nunca intercepta API nem diretório de dados', () => {
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\).*return false/);
  assert.match(source, /url\.pathname\.startsWith\('\/data\/'\).*return false/);
  assert.match(source, /request\.method !== 'GET'/);
  assert.match(source, /portariasync-shell-v3/);
  assert.match(source, /whatsapp-client\.js/);
  assert.match(source, /withdrawal-pin\.js/);
});

test('ícones PWA existem nos tamanhos declarados', () => {
  const icon192 = fs.readFileSync(path.join(root, 'icons', 'portariasync-192.svg'), 'utf8');
  const icon512 = fs.readFileSync(path.join(root, 'icons', 'portariasync-512.svg'), 'utf8');
  assert.match(icon192, /width="192" height="192"/);
  assert.match(icon512, /width="512" height="512"/);
  assert.match(icon192, /#1a1f3a/);
  assert.match(icon512, /#c9a84c/);
});

test('aplicação carrega suporte PWA após ficar pronta', () => {
  const source = fs.readFileSync(path.join(root, 'local-ocr.js'), 'utf8');
  assert.match(source, /pwa\.js\?v=20260903-1/);
  assert.match(source, /loadPwaScript\(root\)/);
  assert.match(source, /pwaLoader:\s*true/);
  assert.match(source, /version:\s*'2026-09-03\.1'/);
});

test('botão de instalação fica acima da tela de login e oferece caminho manual quando o prompt não existe', () => {
  const pwaSource = fs.readFileSync(path.join(root, 'pwa.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const loginZ = Number(indexSource.match(/#loginScreen\s*\{[^}]*z-index:\s*(\d+)/s)?.[1] || 0);
  const buttonZ = Number(pwaSource.match(/z-index:(\d+)/)?.[1] || 0);
  assert.equal(pwa.VERSION, '2026-09-03.6');
  assert.ok(loginZ >= 99999);
  assert.ok(buttonZ > loginZ);
  assert.match(pwaSource, /showFallbackInstall/);
  assert.match(pwaSource, /Instalar app/);
  assert.match(pwaSource, /Adicionar à tela inicial/);
});

test('PWA carrega cliente do WhatsApp, PIN e autorização digital sem credenciais no navegador', () => {
  const source = fs.readFileSync(path.join(root, 'pwa.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'whatsapp-client.js'), 'utf8');
  assert.match(source, /whatsapp-client\.js\?v=20260903-2/);
  assert.match(source, /loadWhatsappClient\(host\)/);
  assert.match(source, /withdrawal-pin\.js\?v=20260903-1/);
  assert.match(source, /loadWithdrawalPin\(host\)/);
  assert.match(source, /withdrawal-authorization\.js\?v=20260903-1/);
  assert.match(source, /loadWithdrawalAuthorization\(host\)/);
  assert.doesNotMatch(client, /META_WHATSAPP_ACCESS_TOKEN|ZAPI_CLIENT/);
  assert.match(client, /\/api\/whatsapp\/package/);
  assert.match(client, /\/api\/whatsapp\/reminder/);
});

test('troca de associação limpa somente o estado operacional local', () => {
  const values = new Map([
    ['activeAssociationId', 'principal'],
    ['moradores', '[{"id":"m1"}]'],
    ['encomendas', '[{"id":"e1"}]'],
    ['authToken', 'token-seguro'],
    ['apiBaseUrl', 'https://exemplo.test']
  ]);
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const changed = pwa.applyAssociationScope({ localStorage: storage }, 'jardim-sul');
  assert.equal(changed, true);
  assert.equal(values.get('activeAssociationId'), 'jardim-sul');
  assert.equal(values.has('moradores'), false);
  assert.equal(values.has('encomendas'), false);
  assert.equal(values.get('authToken'), 'token-seguro');
  assert.equal(values.get('apiBaseUrl'), 'https://exemplo.test');
});
