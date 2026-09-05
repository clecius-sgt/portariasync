const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Central de WhatsApp possui painel, filtros e aviso de privacidade', () => {
  const html = read('whatsapp.html');
  assert.match(html, /Central de WhatsApp/);
  assert.match(html, /Total monitorado/);
  assert.match(html, /Em processamento/);
  assert.match(html, /Entregues/);
  assert.match(html, /Lidas/);
  assert.match(html, /Falhas/);
  assert.match(html, /statusFilter/);
  assert.match(html, /kindFilter/);
  assert.match(html, /não exibe o texto das mensagens/i);
  assert.match(html, /whatsapp-central\.js/);
});

test('Central usa sessão administrativa e nunca envia segredo do webhook ao navegador', () => {
  const source = read('whatsapp-central.js');
  assert.match(source, /Authorization = 'Bearer '/);
  assert.match(source, /\/api\/zapi\/admin\/recent\?limit=200/);
  assert.match(source, /plataforma !== true/);
  assert.doesNotMatch(source, /ZAPI_WEBHOOK_SECRET/);
  assert.doesNotMatch(source, /[?&]key=/);
});

test('servidor de webhook valida administrador da plataforma antes de expor histórico', () => {
  const source = read('scripts/whatsapp-webhook-server.js');
  assert.match(source, /\/api\/zapi\/admin\/recent/);
  assert.match(source, /http:\/\/127\.0\.0\.1:3000\/api\/auth\/me/);
  assert.match(source, /payload\.user\.perfil !== 'admin'/);
  assert.match(source, /payload\.user\.plataforma !== true/);
  assert.match(source, /store\.summary\(\)/);
  assert.match(source, /store\.list\(limit\)/);
});
