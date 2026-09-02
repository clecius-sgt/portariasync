const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('../label-capture');

const root = path.join(__dirname, '..');

test('admin panel files expose protected dashboard flow', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
  assert.match(html, /Painel Administrativo/);
  assert.match(html, /statusOcr/);
  assert.match(html, /countResidents/);
  assert.match(js, /\/api\/auth\/me/);
  assert.match(js, /payload\.user\.perfil !== 'admin'/);
  assert.match(js, /\/api\/health/);
  assert.match(js, /\/api\/app-state/);
});

test('main admin configuration receives a shortcut without duplicating it', () => {
  const nodes = new Map();
  const page = {
    firstChild: null,
    inserted: [],
    insertBefore(node) {
      this.inserted.push(node);
      nodes.set(node.id, node);
    }
  };
  const nav = { textContent: '⚙️ Config' };
  nodes.set('page-config', page);
  nodes.set('navConfig', nav);
  const doc = {
    getElementById(id) { return nodes.get(id) || null; },
    createElement() { return { id: '', className: '', innerHTML: '' }; }
  };

  assert.equal(capture.installAdminShortcut(doc), true);
  assert.equal(nav.textContent, '🛠 Admin');
  assert.equal(page.inserted.length, 1);
  assert.match(page.inserted[0].innerHTML, /\/admin\.html/);
  assert.equal(capture.installAdminShortcut(doc), true);
  assert.equal(page.inserted.length, 1);
});
