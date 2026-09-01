(function(root) {
  'use strict';
  let workerPromise = null;
  let queue = Promise.resolve();
  let progress = null;
  let phase = 'inicialização';

  function formatError(error) {
    const detail = String(error?.message || error || 'Erro sem descrição').slice(0, 400);
    return 'Falha no leitor (' + (error?.ocrPhase || phase) + '): ' + detail;
  }

  function getWorker() {
    if (!workerPromise) {
      if (!root.Tesseract) throw new Error('Leitor local ausente. Execute npm ci no servidor.');
      phase = 'inicialização';
      workerPromise = root.Tesseract.createWorker('por', 1, {
        workerPath: '/vendor/ocr/worker.min.js',
        corePath: '/vendor/ocr/core',
        langPath: '/vendor/ocr/lang',
        workerBlobURL: false,
        logger: event => { if (progress) progress(event); },
        // Tesseract also rejects the job promise; prevent an uncaught worker error.
        errorHandler: () => {}
      }).then(async worker => {
        try {
          await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
        } catch (error) {
          await worker.terminate();
          throw error;
        }
        return worker;
      });
    }
    return workerPromise;
  }

  function enqueue(task, onProgress) {
    // One worker and one job at a time, including preview and manual capture.
    const job = queue.then(async () => {
      progress = onProgress;
      let timer;
      try {
        const result = await Promise.race([
          task(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Tempo de leitura excedido. Confira a conexão e tente novamente.')), 60000);
          })
        ]);
        return result;
      } catch (error) {
        const failed = workerPromise;
        workerPromise = null;
        if (failed) failed.then(w => w.terminate()).catch(() => {});
        // Tesseract may reject with a string, not an Error instance.
        const failure = new Error(String(error?.message || error || 'Erro sem descrição'));
        failure.ocrPhase = phase;
        throw failure;
      } finally {
        clearTimeout(timer);
        progress = null;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  function prepare(onProgress) {
    return enqueue(async () => { await getWorker(); }, onProgress);
  }

  function recognize(image, onProgress) {
    return enqueue(async () => {
      const worker = await getWorker();
      phase = 'leitura da imagem';
      const result = await worker.recognize(image, { rotateAuto: true });
      return { text: String(result.data.text || '').trim(), confidence: Number(result.data.confidence) || 0 };
    }, onProgress);
  }

  function progressText(event) {
    const labels = {
      'loading tesseract core': 'Carregando o motor de leitura',
      'initializing tesseract': 'Iniciando o motor de leitura',
      'loading language traineddata': 'Carregando o idioma português',
      'initializing api': 'Preparando o leitor',
      'recognizing text': 'Lendo o texto da etiqueta'
    };
    const label = labels[event?.status] || 'Preparando o leitor local';
    const percent = Number.isFinite(event?.progress) ? ' (' + Math.round(event.progress * 100) + '%)' : '';
    return label + percent + '...';
  }

  root.LocalOCR = { recognize, prepare, formatError, progressText, version: '2026-09-01.2' };
})(globalThis);
