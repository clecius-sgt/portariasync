const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'instalar.html'), 'utf8');

test('página dedicada expõe manifesto e instalação sem depender da tela de login', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.json\?v=20260903-1">/);
  assert.match(html, /Instalar PortariaSync/);
  assert.match(html, /beforeinstallprompt/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js\?v=20260903-1'/);
  assert.doesNotMatch(html, /loginScreen/);
});

test('página orienta Android e iOS quando prompt nativo não estiver disponível', () => {
  assert.match(html, /Adicionar à Tela de Início/);
  assert.match(html, /Instalar app/);
  assert.match(html, /Compartilhar/);
  assert.match(html, /usuário e senha/);
});

test('instalação concluída diferencia PWA do acesso normal pelo navegador', () => {
  assert.match(html, /display-mode: standalone/);
  assert.match(html, /PortariaSync já está instalado/);
  assert.match(html, /Abra o PortariaSync pelo novo ícone/);
});
