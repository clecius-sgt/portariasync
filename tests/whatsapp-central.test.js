const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Central de WhatsApp possui funil, filtros, associação e aviso de privacidade', () => {
  const html = read('whatsapp.html');
  assert.match(html, /Central de WhatsApp/);
  assert.match(html, /Total monitorado/);
  assert.match(html, /Aceitas/);
  assert.match(html, /Enviadas/);
  assert.match(html, /Recebidas/);
  assert.match(html, /Lidas/);
  assert.match(html, /Falhas/);
  assert.match(html, /associationFilter/);
  assert.match(html, /<th>Associação<\/th>/);
  assert.match(html, /statusFilter/);
  assert.match(html, /kindFilter/);
  assert.match(html, /não exibe o texto das mensagens/i);
  assert.match(html, /whatsapp-central\.js/);
});

test('Central usa sessão administrativa, filtra associação e nunca envia segredo ao navegador', () => {
  const source = read('whatsapp-central.js');
  assert.match(source, /Authorization = 'Bearer '/);
  assert.match(source, /\/api\/zapi\/admin\/recent\?limit=200/);
  assert.match(source, /plataforma !== true/);
  assert.match(source, /associationFilter/);
  assert.match(source, /associationName/);
  assert.match(source, /countReceived/);
  assert.doesNotMatch(source, /ZAPI_WEBHOOK_SECRET/);
  assert.doesNotMatch(source, /[?&]key=/);
});

test('servidor de webhook valida plataforma, expõe diretório de associações e funil cumulativo', () => {
  const source = read('scripts/whatsapp-webhook-server.js');
  assert.match(source, /\/api\/zapi\/admin\/recent/);
  assert.match(source, /http:\/\/127\.0\.0\.1:3000\/api\/auth\/me/);
  assert.match(source, /http:\/\/127\.0\.0\.1:3000\/api\/associations/);
  assert.match(source, /payload\.user\.perfil !== 'admin'/);
  assert.match(source, /payload\.user\.plataforma !== true/);
  assert.match(source, /trackingSummary\(\)/);
  assert.match(source, /associationName/);
  assert.match(source, /received_at IS NOT NULL/);
  assert.match(source, /store\.list\(limit\)/);
});
