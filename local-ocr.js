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

  function mobileResultSufficient(result) {
    const text = String(result?.text || '').trim();
    const confidence = Number(result?.confidence || 0);
    if (!text || !Number.isFinite(confidence)) return false;
    return !needsDetailPass(text, confidence);
  }

  function mobileRecipientSufficient(result, host) {
    if (!mobileResultSufficient(result)) return false;
    host = host || root;
    if (!host || typeof host.identificarMoradorOCR !== 'function') return true;
    try {
      const match = host.identificarMoradorOCR(String(result?.text || ''));
      return !!String(match?.enderecoExtraido || '').trim();
    } catch (_) {
      return false;
    }
  }

  function mergeOcrResults(mobileResult, serverResult) {
    const mobileText = String(mobileResult?.text || '').trim();
    const serverText = String(serverResult?.text || '').trim();
    const text = mergeTexts(serverText, mobileText);
    const lines = text ? text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    const mobileConfidence = Number(mobileResult?.confidence || 0);
    const serverConfidence = Number(serverResult?.confidence || 0);
    return {
      ...(serverResult || {}),
      text,
      lines,
      confidence: Math.max(mobileConfidence, serverConfidence),
      engine: 'paddleocr',
      mergedMobileServer: !!(mobileText && serverText)
    };
  }

  async function recognizePass(worker, image, pageSegMode, stage) {
    progressStage = stage || 'principal';
    await worker.setParameters({ tessedit_pageseg_mode: String(pageSegMode), preserve_interword_spaces: '1' });
    const result = await worker.recognize(image, { rotateAuto: true });
    return { text: String(result.data.text || '').trim(), confidence: Number(result.data.confidence) || 0 };
  }

  function recognizeFast(image, onProgress) {
    return enqueue(async () => {
      const worker = await getWorker();
      phase = 'leitura mobile';
      const result = await recognizePass(worker, image, 3, 'mobile');
      return { ...result, engine: 'tesseract-mobile', mode: 'fast' };
    }, onProgress);
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
      label = stage === 'mobile' ? 'Lendo a etiqueta no celular'
        : stage === 'destinatario' ? 'Lendo nome e endereço'
          : stage === 'superior' ? 'Lendo a parte superior da etiqueta'
            : 'Lendo a etiqueta';
    }
    if (!label) label = stage === 'mobile' ? 'Preparando OCR no celular' : 'Preparando o leitor local';
    const percent = Number.isFinite(event?.progress) ? ' (' + Math.round(event.progress * 100) + '%)' : '';
    return label + percent + '...';
  }

  function installMobileFirstFallback(host) {
    host = host || root;
    if (!host || typeof host.enviarParaOCR !== 'function') return false;
    const current = host.enviarParaOCR;
    if (current.__mobileFirstWrapped) return true;
    const core = current.__paddleWrapped && typeof current.__original === 'function' ? current.__original : current;

    const wrapped = async function(imgBase64, statusEl, codigoJaLido = null, transpJaLida = '', leituraId, ocrResult = null) {
      if (ocrResult) return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, ocrResult);

      let mobileResult = null;
      let mobileError = null;
      const startedAt = Date.now();
      try {
        if (statusEl) statusEl.textContent = 'Lendo a etiqueta no celular...';
        mobileResult = await recognizeFast(imgBase64, event => {
          if (statusEl) statusEl.textContent = progressText(event);
        });
        mobileResult = {
          ...mobileResult,
          engine: 'tesseract-mobile',
          route: 'mobile',
          elapsedMs: Date.now() - startedAt
        };
        if (mobileRecipientSufficient(mobileResult, host)) {
          if (statusEl) statusEl.textContent = 'Leitura concluída no celular. Conferindo destinatário...';
          return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, mobileResult);
        }
      } catch (error) {
        mobileError = error;
        if (host.console && typeof host.console.warn === 'function') host.console.warn('OCR mobile indisponível; acionando PaddleOCR:', error);
      }

      const serverReader = host.LabelCapture && typeof host.LabelCapture.recognizeWithPaddle === 'function'
        ? host.LabelCapture.recognizeWithPaddle
        : null;
      if (serverReader) {
        try {
          if (statusEl) statusEl.textContent = mobileResult
            ? 'Leitura mobile sem endereço confirmado. Refinando no servidor...'
            : 'OCR mobile indisponível. Lendo no servidor...';
          const serverStartedAt = Date.now();
          const serverResult = await serverReader(imgBase64, statusEl, host);
          const combined = mergeOcrResults(mobileResult, serverResult);
          const enriched = {
            ...combined,
            engine: 'paddleocr',
            route: 'server-fallback',
            fallbackUsed: true,
            mobileConfidence: mobileResult ? Number(mobileResult.confidence || 0) : null,
            mobileElapsedMs: mobileResult ? Number(mobileResult.elapsedMs || 0) : null,
            serverElapsedMs: Date.now() - serverStartedAt
          };
          if (statusEl) statusEl.textContent = 'PaddleOCR refinou a leitura. Conferindo destinatário e endereço...';
          return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, enriched);
        } catch (serverError) {
          if (host.console && typeof host.console.warn === 'function') host.console.warn('Fallback PaddleOCR indisponível:', serverError);
          if (mobileResult && String(mobileResult.text || '').trim()) {
            if (statusEl) statusEl.textContent = 'Servidor indisponível. Usando a melhor leitura feita no celular...';
            return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, {
              ...mobileResult,
              route: 'mobile-degraded',
              fallbackUsed: true,
              serverError: String(serverError?.message || serverError || '').slice(0, 180)
            });
          }
          const detail = serverError || mobileError || new Error('Nenhum leitor OCR disponível.');
          if (host.console && typeof host.console.error === 'function') host.console.error('OCR mobile e servidor falharam:', detail);
        }
      }

      if (mobileResult && String(mobileResult.text || '').trim()) {
        return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, {
          ...mobileResult,
          route: 'mobile-degraded'
        });
      }

      return core.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, {
        text: '',
        confidence: 0,
        lines: [],
        engine: 'unavailable',
        route: 'failed',
        error: String(mobileError?.message || mobileError || 'Nenhum leitor OCR disponível.').slice(0, 180)
      });
    };

    wrapped.__mobileFirstWrapped = true;
    wrapped.__original = core;
    wrapped.__serverWrapper = current.__paddleWrapped ? current : null;
    host.enviarParaOCR = wrapped;
    return true;
  }

  function loadRecipientMemoryScript(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || !host.RecipientMatching || typeof doc.createElement !== 'function') return false;
    if (host.RecipientMemory) {
      if (typeof host.RecipientMemory.install === 'function') host.RecipientMemory.install(host);
      return true;
    }
    if (doc.querySelector && doc.querySelector('script[data-recipient-memory="1"]')) return true;
    const script = doc.createElement('script');
    script.src = '/recipient-memory.js?v=20260902-3';
    script.async = true;
    script.dataset.recipientMemory = '1';
    script.onload = function() {
      if (host.RecipientMemory && typeof host.RecipientMemory.install === 'function') host.RecipientMemory.install(host);
    };
    (doc.head || doc.documentElement).appendChild(script);
    return true;
  }

  root.LocalOCR = {
    recognize, recognizeFast, prepare, formatError, progressText, needsDetailPass, mobileResultSufficient, mobileRecipientSufficient,
    mergeTexts, mergeOcrResults, detailRegions, canCropImage, createDetailCrop, installMobileFirstFallback, loadRecipientMemoryScript,
    mobileFirst: true, serverFallback: true, recipientMemoryLoader: true, version: '2026-09-02.5'
  };

  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('DOMContentLoaded', function() {
      loadRecipientMemoryScript(root);
      installMobileFirstFallback(root);
    }, { once: true });
  }
})(globalThis);
