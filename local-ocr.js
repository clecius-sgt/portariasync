(function(root) {
  'use strict';
  let workerPromise = null;
  let queue = Promise.resolve();
  let progress = null;

  function getWorker() {
    if (!workerPromise) {
      if (!root.Tesseract) throw new Error('Leitor local ausente. Execute npm ci no servidor.');
      workerPromise = root.Tesseract.createWorker('por', 1, {
        workerPath: '/vendor/ocr/worker.min.js',
        corePath: '/vendor/ocr/core',
        langPath: '/vendor/ocr/lang',
        workerBlobURL: false,
        logger: event => { if (progress) progress(event); },
        // Tesseract also rejects the job promise; prevent an uncaught worker error.
        errorHandler: () => {}
      }).then(async worker => {
        await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
        return worker;
      });
    }
    return workerPromise;
  }

  function recognize(image, onProgress) {
    // One worker and one job at a time, including preview and manual capture.
    const job = queue.then(async () => {
      progress = onProgress;
      let timer;
      try {
        const result = await Promise.race([
          (async () => (await getWorker()).recognize(image, { rotateAuto: true }))(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Tempo de leitura excedido. Tente uma foto mais próxima.')), 60000);
          })
        ]);
        return { text: String(result.data.text || '').trim(), confidence: Number(result.data.confidence) || 0 };
      } catch (error) {
        const failed = workerPromise;
        workerPromise = null;
        if (failed) failed.then(w => w.terminate()).catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
        progress = null;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  root.LocalOCR = { recognize };
})(globalThis);
