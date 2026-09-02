(function(root) {
  'use strict';
  let workerPromise = null;
  let queue = Promise.resolve();
  let progress = null;
  let phase = 'inicialização';
  let progressStage = 'principal';

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
        logger: event => {
          if (progress) progress({ ...event, ocrStage: progressStage });
        },
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
        const failure = new Error(String(error?.message || error || 'Erro sem descrição'));
        failure.ocrPhase = phase;
        throw failure;
      } finally {
        clearTimeout(timer);
        progress = null;
        progressStage = 'principal';
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  function prepare(onProgress) {
    return enqueue(async () => { await getWorker(); }, onProgress);
  }

  function normalizeLine(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
  }

  function mergeTexts(...values) {
    const seen = new Set();
    const lines = [];
    for (const value of values) {
      for (const line of String(value || '').split(/\r?\n/)) {
        const clean = normalizeLine(line);
        if (!clean) continue;
        const key = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(clean);
      }
    }
    return lines.join('\n');
  }

  function hasAddress(text) {
    return /\b(rua|r\.?|rva|avenida|av\.?|alameda|travessa)\s+[^\n]{2,70}(?:\d|[il]\d|\d[oO])/i.test(String(text || ''));
  }

  function hasRecipientLikeName(text) {
    return String(text || '').split(/\r?\n/).some(line => /^[A-Za-zÀ-ÿ]+(?:[ '\-]+[A-Za-zÀ-ÿ]+){1,6}$/.test(line.trim()));
  }

  function needsDetailPass(text, confidence) {
    const value = String(text || '');
    const hasTracking = /\b(?:TBR\d{8,}|TBA\d{8,}|[A-Z]{2}\d{9}BR|BR\d{8,})\b/i.test(value);
    return confidence < 78 || !hasAddress(value) || !(hasRecipientLikeName(value) || hasTracking);
  }

  async function recognizePass(worker, image, pageSegMode, stage) {
    progressStage = stage || 'principal';
    await worker.setParameters({ tessedit_pageseg_mode: String(pageSegMode), preserve_interword_spaces: '1' });
    const result = await worker.recognize(image, { rotateAuto: true });
    return { text: String(result.data.text || '').trim(), confidence: Number(result.data.confidence) || 0 };
  }

  function canCropImage(image) {
    return typeof image === 'string' && /^data:image\//i.test(image)
      && root.document && typeof root.document.createElement === 'function' && typeof root.Image === 'function';
  }

  function detailRegions() {
    return [
      { name: 'superior', x: 0.01, y: 0.04, w: 0.98, h: 0.52 },
      { name: 'destinatario', x: 0.01, y: 0.12, w: 0.78, h: 0.30 }
    ];
  }

  function loadImage(image) {
    return new Promise((resolve, reject) => {
      const img = new root.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Não foi possível preparar o recorte da etiqueta.'));
      img.src = image;
    });
  }

  async function createDetailCrop(image, region) {
    if (!canCropImage(image)) return null;
    const img = await loadImage(image);
    const sx = Math.max(0, Math.round(img.width * region.x));
    const sy = Math.max(0, Math.round(img.height * region.y));
    const sw = Math.max(1, Math.min(img.width - sx, Math.round(img.width * region.w)));
    const sh = Math.max(1, Math.min(img.height - sy, Math.round(img.height * region.h)));
    const targetWidth = Math.min(1800, Math.max(1200, sw * 2));
    const targetHeight = Math.max(1, Math.round(targetWidth * sh / sw));
    const canvas = root.document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

    // Grayscale + contraste moderado para letras pequenas sem destruir sombras/dobras do papel.
    const pixels = ctx.getImageData(0, 0, targetWidth, targetHeight);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = pixels.data[i] * 0.299 + pixels.data[i + 1] * 0.587 + pixels.data[i + 2] * 0.114;
      const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 136));
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = boosted;
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.96);
  }

  function recognize(image, onProgress) {
    return enqueue(async () => {
      const worker = await getWorker();
      phase = 'leitura da imagem';
      const first = await recognizePass(worker, image, 3, 'principal');
      if (!needsDetailPass(first.text, first.confidence)) return first;

      let merged = first.text;
      let confidence = first.confidence;
      const regions = detailRegions();

      if (canCropImage(image)) {
        for (const region of regions) {
          if (hasAddress(merged) && hasRecipientLikeName(merged) && confidence >= 72) break;
          if (progress) progress({ status: 'recognizing text detail', progress: 0, ocrStage: region.name });
          const crop = await createDetailCrop(image, region);
          if (!crop) continue;
          const detail = await recognizePass(worker, crop, 6, region.name);
          merged = mergeTexts(merged, detail.text);
          confidence = Math.max(confidence, detail.confidence);
        }
      } else {
        // Testes/ambientes sem canvas mantêm uma segunda leitura compatível.
        if (progress) progress({ status: 'recognizing text detail', progress: 0, ocrStage: 'superior' });
        const second = await recognizePass(worker, image, 6, 'superior');
        merged = mergeTexts(merged, second.text);
        confidence = Math.max(confidence, second.confidence);
      }

      await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
      progressStage = 'principal';
      return { text: merged, confidence };
    }, onProgress);
  }

  function progressText(event) {
    const stage = event?.ocrStage;
    const labels = {
      'loading tesseract core': 'Carregando o motor de leitura',
      'initializing tesseract': 'Iniciando o motor de leitura',
      'loading language traineddata': 'Carregando o idioma português',
      'initializing api': 'Preparando o leitor',
      'recognizing text detail': stage === 'destinatario' ? 'Ampliando nome e endereço' : 'Ampliando a parte superior da etiqueta'
    };
    let label = labels[event?.status];
    if (!label && event?.status === 'recognizing text') {
      label = stage === 'destinatario' ? 'Lendo nome e endereço'
        : stage === 'superior' ? 'Lendo a parte superior da etiqueta'
          : 'Lendo a etiqueta';
    }
    if (!label) label = 'Preparando o leitor local';
    const percent = Number.isFinite(event?.progress) ? ' (' + Math.round(event.progress * 100) + '%)' : '';
    return label + percent + '...';
  }

  root.LocalOCR = {
    recognize, prepare, formatError, progressText, needsDetailPass, mergeTexts,
    detailRegions, canCropImage, createDetailCrop, version: '2026-09-01.6'
  };
})(globalThis);
