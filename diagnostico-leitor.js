(function() {
  'use strict';
  const button = document.getElementById('testar');
  const status = document.getElementById('estado');
  const report = document.getElementById('relatorio');
  const canvas = document.getElementById('etiqueta');
  const ctx = canvas.getContext('2d');
  const fixture = ['DESTINATARIO', 'Carlos Augusto', 'Rua Londres 160', 'CEP 15115000', 'TBR123456789'];
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black'; ctx.font = '42px Arial';
  fixture.forEach((line, i) => ctx.fillText(line, 90, 125 + i * 100));
  const environment = [
    'PortariaSync | diagnóstico 2026-09-01.2',
    'Endereço: ' + location.origin + location.pathname,
    'Navegador: ' + navigator.userAgent,
    'Contexto seguro: ' + window.isSecureContext,
    'Worker: ' + (typeof Worker !== 'undefined'),
    'WebAssembly: ' + (typeof WebAssembly !== 'undefined'),
    'Câmera disponível na API: ' + !!navigator.mediaDevices?.getUserMedia,
    'Biblioteca: ' + !!window.Tesseract,
    'Leitor: ' + (window.LocalOCR?.version || 'não carregado')
  ];
  let lines = [];
  function update(message) {
    report.value = environment.concat(lines, message ? [message] : []).join('\n');
    if (message) status.textContent = message;
  }
  update();
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.dataset.result = 'executando';
    lines = [];
    const started = performance.now();
    try {
      if (!window.LocalOCR) throw new Error('O arquivo local-ocr.js não carregou neste endereço.');
      if (!window.Tesseract) throw new Error('O arquivo /vendor/ocr/tesseract.min.js não carregou neste endereço. Confira se abriu o sistema no VPS.');
      if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new Error('O navegador não disponibilizou os recursos Worker e WebAssembly necessários ao leitor.');
      update('Preparando o leitor...');
      const progress = event => update(LocalOCR.progressText(event));
      await LocalOCR.prepare(progress);
      lines.push('Inicialização: concluída');
      const result = await LocalOCR.recognize(canvas.toDataURL('image/png'), progress);
      lines.push('Tempo: ' + ((performance.now() - started) / 1000).toFixed(1) + ' s',
        'Confiança informada pelo motor: ' + result.confidence, 'Texto lido:', result.text);
      const text = result.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
      if (!/Carlos Augusto/i.test(text) || !/Rua Londres[ ,]*160/i.test(text) || result.confidence < 75) {
        throw new Error('O motor executou, mas não leu nome e endereço da etiqueta de teste com confiança suficiente.');
      }
      status.dataset.result = 'ok';
      update('Teste concluído: o leitor funcionou com a etiqueta fictícia neste aparelho. Falta testar a câmera com uma etiqueta real.');
    } catch (error) {
      lines.push('Tempo até a falha: ' + ((performance.now() - started) / 1000).toFixed(1) + ' s');
      status.dataset.result = 'erro';
      update(window.LocalOCR?.formatError ? LocalOCR.formatError(error) : String(error?.message || error));
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('copiar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(report.value);
      document.getElementById('copiar').textContent = 'Resultado copiado';
    } catch {
      report.focus(); report.select();
      document.getElementById('copiar').textContent = 'Selecione e copie o resultado acima';
    }
  });
})();
