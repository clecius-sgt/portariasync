const test = require('node:test');
const assert = require('node:assert/strict');
const matching = require('../recipient-matching');

const creusa = { id: '1087', nome: 'Creusa Maria Castilho Bento', casa: 'QD06LT04 - Rua Londres, 160' };
const maria = { id: 'other', nome: 'Maria Oliveira', casa: 'Rua Madri, 12' };

for (const line of ['Rua Londres 160', 'Rua Londres I60', 'Rua Londres 16O', 'Rva Londres I60']) {
  test('localiza responsável pelo endereço com OCR ruidoso: ' + line, () => {
    const result = matching.match('Carlos Augusto\n' + line + '\nTBR364591209', [creusa, maria]);
    assert.equal(result.confiavel, false);
    assert.equal(result.morador, null);
    assert.equal(result.destinatarioNaoCadastrado, true);
    assert.equal(result.responsaveisEndereco[0].id, '1087');
    assert.equal(result.candidatos[0].morador.id, '1087');
    assert.match(result.enderecoExtraido, /Londres/i);
    assert.match(result.enderecoExtraido, /(160|I60|16O)/i);
  });
}

test('não usa apenas número da casa para criar associação', () => {
  const result = matching.match('Carlos Augusto\nAvenida Arthur Antonio Sendas 160\nTBR364591209', [creusa]);
  assert.equal(result.candidatos.length, 0);
});

test('endereço quebrado em duas linhas ainda localiza o responsável e preserva o endereço exibido', () => {
  const result = matching.match('Carlos Augusto\nRua Londres\nI60\nBady Bassitt SP\nTBR364591209', [creusa]);
  assert.equal(result.responsaveisEndereco[0].id, '1087');
  assert.match(result.enderecoExtraido, /Rua Londres I60/i);
});

test('responsável pelo endereço fica em primeiro mesmo quando outro cadastro combina apenas com o nome', () => {
  const carlos = { id: 'carlos', nome: 'Carlos Augusto Souza', casa: 'Rua Paris, 999' };
  const result = matching.match('Carlos Augusto\nRua Londres\nI60\nBady Bassitt SP\nTBR364591209', [carlos, creusa]);
  assert.equal(result.confiavel, false);
  assert.equal(result.destinatarioNaoCadastrado, true);
  assert.equal(result.candidatoPrincipal.id, '1087');
  assert.equal(result.candidatos[0].morador.id, '1087');
  assert.match(result.enderecoExtraido, /Rua Londres I60/i);
});

test('morador cadastrado com nome completo e endereço ruidoso pode ser identificado com segurança', () => {
  const result = matching.match('Creusa Maria Castilho Bento\nRva Londres I60\nTBR364591209', [creusa]);
  assert.equal(result.confiavel, true);
  assert.equal(result.morador.id, '1087');
});
