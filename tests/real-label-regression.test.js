const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const matching = require('../recipient-matching');
const capture = require('../label-capture');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const residents = JSON.parse(html.match(/let _moradores_default = (\[.*\]);/)[1]);

test('real label address survives common OCR substitutions', () => {
  for (const noisy of ['Rua Londres I60', 'Rua Londres 16O', 'Rva Londres I60']) {
    const parsed = matching.address(noisy);
    assert.equal(parsed.street, 'rua londres');
    assert.equal(parsed.number, '160');
  }
});

test('Carlos Augusto remains unassigned but Rua Londres 160 owner is found after OCR noise', () => {
  const text = [
    'GIG1',
    'Avenida Arthur Antonio Sendas, 6A',
    'Predio 500',
    'Carlos Augusto',
    'Rva Londres I60',
    'Res D Italia Colina Sul',
    'Bady Bassitt SP 15115000 Brazil',
    'TBR364591209'
  ].join('\n');
  const result = matching.match(text, residents);
  assert.equal(result.morador, null);
  assert.equal(result.destinatarioNaoCadastrado, true);
  assert.equal(result.responsaveisEndereco[0].id, '1087');
  assert.equal(result.nomeExtraido, 'Carlos Augusto');
});

test('real label can trigger automatic capture even when OCR misses its small address line', () => {
  const result = {
    text: 'Carlos Augusto\nBady Bassitt SP 15115000 Brazil\nOrder ID 701 5478255\nTBR364591209',
    confidence: 68
  };
  assert.equal(capture.looksLikeLabel(result), true);
});

test('ordinary text with no shipping evidence does not auto-capture', () => {
  assert.equal(capture.looksLikeLabel({ text: 'Carlos Augusto\nUm texto comum qualquer', confidence: 95 }), false);
});
