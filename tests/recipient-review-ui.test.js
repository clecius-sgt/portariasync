const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const review = require('../recipient-review-ui');

const lucimara = { id: '1006b', nome: 'Lucimara Gonçalves Salomé', casa: 'QD01LT11 - Rua Brasilia, 311' };
const clecius = { id: '1006', nome: 'Clecius Eduardo Alves Salome', casa: 'QD01LT11 - Rua Brasilia, 311' };

function result() {
  return {
    candidatoPrincipal: lucimara,
    candidatos: [
      { morador: lucimara, motivos: ['Nome completo coincide', 'Rua e número coincidem'] },
      { morador: clecius, motivos: ['Outro morador cadastrado no mesmo endereço', 'Nome lido na etiqueta indica o morador destacado acima'] }
    ]
  };
}

test('destinatário principal recebe destaque sem virar seleção automática', () => {
  const view = review.presentation(result(), lucimara, 0);
  assert.equal(view.role, 'primary');
  assert.equal(view.badge, 'Mais provável pela etiqueta');
  assert.match(view.action, /selecionar Lucimara$/);
  assert.match(view.instruction, /Compare o nome impresso/);
});

test('outro morador do mesmo endereço aparece como alternativa claramente identificada', () => {
  const view = review.presentation(result(), clecius, 1);
  assert.equal(view.role, 'same-address');
  assert.equal(view.badge, 'Outro morador do mesmo endereço');
  assert.match(view.instruction, /somente se este for o nome/);
  assert.match(view.action, /selecionar Clecius$/);
});

test('memória confirmada recebe indicador próprio mas ainda exige conferência visual', () => {
  const value = result();
  value.memoriaConfirmada = true;
  value.candidatos[0].memoriaConfirmada = true;
  const view = review.presentation(value, lucimara, 0);
  assert.equal(view.role, 'remembered');
  assert.equal(view.badge, 'Já confirmado anteriormente');
  assert.match(view.instruction, /Confira se o nome impresso/);
});

test('opção fora do endereço compartilhado permanece neutra e exige confirmação', () => {
  const maria = { id: 'maria', nome: 'Maria Oliveira', casa: 'Rua Roma, 7' };
  const value = result();
  value.candidatos.push({ morador: maria, motivos: ['Seleção manual'] });
  const view = review.presentation(value, maria, 2);
  assert.equal(view.role, 'alternative');
  assert.equal(view.badge, 'Outra opção do cadastro');
  assert.match(view.instruction, /apenas se a etiqueta confirmar/);
});

test('tela aprimorada mantém foto, leitura completa, busca e ação explícita de confirmação', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'recipient-review-ui.js'), 'utf8');
  assert.match(source, /#fotoSugestao/);
  assert.match(source, /#filtroSugestaoMorador/);
  assert.match(source, /Conferi a etiqueta - selecionar/);
  assert.match(source, /100dvh/);
  assert.match(source, /MutationObserver/);
});

test('leitor já carregado pela aplicação também carrega a tela de conferência melhorada', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'barcode-reader.js'), 'utf8');
  assert.match(source, /recipient-review-ui\.js\?v=20260902-1/);
  assert.match(source, /loadReviewUi\(host\)/);
  assert.match(source, /version:\s*'2026-09-02\.4'/);
});
