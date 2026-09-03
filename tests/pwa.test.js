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
  assert.equal(registered.url, '/sw.js?v=20260903-1');
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
  assert.match(source, /portariasync-shell-v1/);
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
