(function(root) {
  'use strict';

  function measure(data, width, height, previous) {
    const gray = new Uint8Array(width * height);
    let sum = 0, square = 0, motion = 0, edges = 0;
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      const value = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
      gray[i] = value;
      sum += value;
      square += value * value;
      if (previous?.length === gray.length) motion += Math.abs(value - previous[i]);
      if (i % width && Math.abs(value - gray[i - 1]) > 26) edges++;
    }
    const mean = sum / gray.length;
    const contrast = Math.sqrt(Math.max(0, square / gray.length - mean * mean));
    const movement = previous?.length === gray.length ? motion / gray.length : Infinity;
    const detail = edges / gray.length;
    const ready = mean > 38 && mean < 252 && contrast > 13 && detail > 0.010 && movement < 7.5;
    return { gray, mean, contrast, movement, detail, ready };
  }

  function looksLikeLabel(result) {
    if (!result || result.confidence < 50) return false;
    const text = String(result.text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const address = /\b(rua|r\.?|rva|avenida|av\.?|alameda|travessa)\s+[^\n]{2,80}(?:\d|[il]\d|\d[oO])/i.test(text);
    const tracking = /\b(?:[A-Z]{2}\d{9}BR|TBR\d{8,}|TBA\d{8,}|BR\d{8,})\b/i.test(text);
    const shippingWord = /\b(destinatario|recipient|entrega|cep|correios|shopee|amazon|jadlog|loggi|order|tentativa)\b/i.test(text);
    const cep = /\b(?:cep\s*)?\d{5}[- ]?\d{3}\b/i.test(text);
    const name = lines.some(s => /^[a-z]+(?:[ '\-]+[a-z]+){1,7}$/i.test(s));
    const readableAddress = lines.length >= 2 && text.length >= 25 && address && (name || shippingWord || tracking);
    const strongShippingLabel = lines.length >= 3 && text.length >= 35 && tracking && (shippingWord || cep || /\d/.test(text));
    return readableAddress || strongShippingLabel;
  }

  function updateManualCaptureUi(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    const modal = doc.getElementById('modalUnificado');
    if (modal && modal.firstElementChild) {
      const title = String(modal.firstElementChild.textContent || '');
      if (/captura\s+(?:e|é)\s+autom[aá]tica/i.test(title)) {
        modal.firstElementChild.textContent = '📷 Use a câmera do celular e fotografe a etiqueta inteira.';
      }
    }

    if (doc.querySelectorAll) {
      doc.querySelectorAll('button').forEach(button => {
        const text = String(button.textContent || '').trim();
        if (/Ler etiqueta com captura autom[aá]tica/i.test(text)) button.textContent = '📷 Fotografar etiqueta';
        else if (/Capturar agora/i.test(text)) button.textContent = '📸 Fotografar etiqueta';
      });
    }
  }

  function installAdminShortcut(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.getElementById !== 'function') return false;
    const page = doc.getElementById('page-config');
    if (!page) return false;

    const nav = doc.getElementById('navConfig');
    if (nav) nav.textContent = '🛠 Admin';
    if (doc.getElementById('adminPanelShortcut')) return true;
    if (typeof doc.createElement !== 'function') return false;

    const card = doc.createElement('div');
    card.id = 'adminPanelShortcut';
    card.className = 'card';
    card.innerHTML = '<h2>🛠 Painel administrativo</h2>' +
      '<p style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px;">Acompanhe o estado do PaddleOCR, armazenamento, integrações e resumo operacional do PortariaSync.</p>' +
      '<a href="/admin.html" class="btn btn-primary btn-full" style="text-decoration:none;">Abrir painel administrativo</a>';
    page.insertBefore(card, page.firstChild || null);
    return true;
  }

  function atualizarPreviewAssinaturaTelaCheia(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host) return;
    const preview = doc.getElementById('assinaturaPreviewTelaCheia');
    const status = doc.getElementById('assinaturaStatusTelaCheia');
    const limpar = doc.getElementById('btnLimparAssinaturaTelaCheia');
    if (!preview || !status || !limpar) return;
    if (host._assinaturaData) {
      preview.src = host._assinaturaData;
      preview.style.display = 'block';
      status.textContent = '✅ Assinatura registrada. Toque em “Assinar novamente” para substituir.';
      status.style.color = '#137333';
      limpar.style.display = 'inline-flex';
    } else {
      preview.removeAttribute('src');
      preview.style.display = 'none';
      status.textContent = 'Abra a área de assinatura e entregue o celular ao recebedor.';
      status.style.color = '#5f6368';
      limpar.style.display = 'none';
    }
  }

  function configurarCanvasAssinaturaTelaCheia(canvas, host, initialData) {
    host = host || root;
    const ctx = canvas.getContext('2d');
    let desenhando = false;
    let ultimoPonto = null;
    let temAssinatura = !!initialData;
    let resizeTimer = null;

    function aplicarResolucao(dataUrl) {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, host.devicePixelRatio || 1);
      const largura = Math.max(1, Math.round(rect.width * dpr));
      const altura = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = largura;
      canvas.height = altura;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (dataUrl && host.Image) {
        const img = new host.Image();
        img.onload = function() {
          const cssW = largura / dpr;
          const cssH = altura / dpr;
          const escala = Math.min(cssW / img.width, cssH / img.height);
          const w = img.width * escala;
          const h = img.height * escala;
          ctx.drawImage(img, (cssW - w) / 2, (cssH - h) / 2, w, h);
        };
        img.src = dataUrl;
      }
    }

    function ponto(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function iniciar(e) {
      if (e.cancelable) e.preventDefault();
      desenhando = true;
      ultimoPonto = ponto(e);
      ctx.beginPath();
      ctx.moveTo(ultimoPonto.x, ultimoPonto.y);
      ctx.lineTo(ultimoPonto.x + 0.1, ultimoPonto.y + 0.1);
      ctx.stroke();
      temAssinatura = true;
    }

    function desenhar(e) {
      if (e.cancelable) e.preventDefault();
      if (!desenhando) return;
      const atual = ponto(e);
      ctx.lineWidth = e.pressure && e.pressure > 0 ? Math.max(2, e.pressure * 5) : 3;
      ctx.beginPath();
      ctx.moveTo(ultimoPonto.x, ultimoPonto.y);
      ctx.lineTo(atual.x, atual.y);
      ctx.stroke();
      ultimoPonto = atual;
      temAssinatura = true;
    }

    function parar(e) {
      if (e && e.cancelable) e.preventDefault();
      desenhando = false;
      ultimoPonto = null;
    }

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', function(e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      iniciar(e);
    }, { passive: false });
    canvas.addEventListener('pointermove', desenhar, { passive: false });
    canvas.addEventListener('pointerup', function(e) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      parar(e);
    }, { passive: false });
    canvas.addEventListener('pointercancel', parar, { passive: false });

    aplicarResolucao(initialData || null);

    function preservarERedimensionar() {
      if (resizeTimer) host.clearTimeout(resizeTimer);
      resizeTimer = host.setTimeout(function() {
        const atual = temAssinatura ? canvas.toDataURL('image/png') : null;
        aplicarResolucao(atual);
      }, 120);
    }
    if (host.addEventListener) {
      host.addEventListener('resize', preservarERedimensionar);
      host.addEventListener('orientationchange', preservarERedimensionar);
    }

    return {
      temAssinatura: function() { return temAssinatura; },
      limpar: function() {
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        temAssinatura = false;
      },
      obter: function() { return temAssinatura ? canvas.toDataURL('image/png') : null; },
      destruir: function() {
        if (resizeTimer) host.clearTimeout(resizeTimer);
        if (host.removeEventListener) {
          host.removeEventListener('resize', preservarERedimensionar);
          host.removeEventListener('orientationchange', preservarERedimensionar);
        }
      }
    };
  }

  async function fecharAssinaturaTelaCheia(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc) return;
    const overlay = doc.getElementById('modalAssinaturaTelaCheia');
    if (overlay && overlay._signatureController) overlay._signatureController.destruir();
    try {
      if (doc.fullscreenElement && typeof doc.exitFullscreen === 'function') await doc.exitFullscreen();
    } catch (_) {}
    try {
      if (host.screen && host.screen.orientation && typeof host.screen.orientation.unlock === 'function') host.screen.orientation.unlock();
    } catch (_) {}
    if (overlay) overlay.remove();
  }

  async function abrirAssinaturaTelaCheia(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host || typeof doc.createElement !== 'function') return false;
    const anterior = doc.getElementById('modalAssinaturaTelaCheia');
    if (anterior) anterior.remove();
    const assinaturaAnterior = host._assinaturaData || null;

    const overlay = doc.createElement('div');
    overlay.id = 'modalAssinaturaTelaCheia';
    overlay.style.cssText = 'position:fixed;inset:0;width:100dvw;height:100dvh;background:#0f1224;z-index:12000;display:flex;flex-direction:column;padding:10px;box-sizing:border-box;overflow:hidden;';
    overlay.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;color:white;flex:0 0 auto;padding:2px 4px 8px;">' +
        '<div><div style="font-size:17px;font-weight:800;">✍️ Assinatura do recebedor</div><div id="avisoOrientacaoAssinatura" style="font-size:12px;color:#e8c97a;margin-top:2px;">Use o celular na horizontal para aproveitar toda a tela.</div></div>' +
        '<button id="btnCancelarAssinaturaFullscreen" type="button" style="border:1px solid rgba(255,255,255,.35);background:transparent;color:white;border-radius:8px;padding:9px 12px;font-weight:700;">Cancelar</button>' +
      '</div>' +
      '<div style="flex:1 1 auto;min-height:0;background:white;border-radius:12px;padding:8px;box-shadow:0 4px 20px rgba(0,0,0,.3);">' +
        '<canvas id="canvasAssinaturaTelaCheia" aria-label="Área de assinatura" style="display:block;width:100%;height:100%;min-height:180px;background:#fff;border:2px dashed #94a3b8;border-radius:8px;touch-action:none;cursor:crosshair;"></canvas>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex:0 0 auto;padding-top:10px;">' +
        '<button id="btnLimparFullscreen" type="button" style="flex:1;padding:13px;border-radius:9px;border:1px solid #64748b;background:#fff;color:#334155;font-weight:800;font-size:15px;">🗑️ Limpar</button>' +
        '<button id="btnConcluirFullscreen" type="button" style="flex:2;padding:13px;border-radius:9px;border:none;background:#34a853;color:white;font-weight:800;font-size:16px;">✅ Concluir assinatura</button>' +
      '</div>';
    (doc.body || doc.documentElement).appendChild(overlay);

    const canvas = doc.getElementById('canvasAssinaturaTelaCheia');
    const controller = configurarCanvasAssinaturaTelaCheia(canvas, host, assinaturaAnterior);
    overlay._signatureController = controller;

    doc.getElementById('btnLimparFullscreen').addEventListener('click', function() { controller.limpar(); });
    doc.getElementById('btnCancelarAssinaturaFullscreen').addEventListener('click', function() {
      void fecharAssinaturaTelaCheia(doc, host);
    });
    doc.getElementById('btnConcluirFullscreen').addEventListener('click', function() {
      if (!controller.temAssinatura()) {
        if (typeof host.toast === 'function') host.toast('⚠️ A assinatura é obrigatória para confirmar a retirada.', 5000);
        else if (typeof host.alert === 'function') host.alert('A assinatura é obrigatória.');
        return;
      }
      host._assinaturaData = controller.obter();
      atualizarPreviewAssinaturaTelaCheia(doc, host);
      void fecharAssinaturaTelaCheia(doc, host);
    });

    try {
      if (typeof overlay.requestFullscreen === 'function') await overlay.requestFullscreen({ navigationUI: 'hide' });
    } catch (_) {}
    try {
      if (host.screen && host.screen.orientation && typeof host.screen.orientation.lock === 'function') {
        await host.screen.orientation.lock('landscape');
      }
    } catch (_) {}

    const aviso = doc.getElementById('avisoOrientacaoAssinatura');
    try {
      if (aviso && host.matchMedia && host.matchMedia('(orientation: landscape)').matches) {
        aviso.textContent = 'Assine dentro da área branca usando o dedo ou caneta touch.';
      }
    } catch (_) {}
    return true;
  }

  function aprimorarAssinaturaRetirada(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host || typeof doc.getElementById !== 'function') return false;
    const canvas = doc.getElementById('canvasAssinatura');
    if (!canvas || canvas.dataset.fullscreenEnhanced === '1') return false;
    canvas.dataset.fullscreenEnhanced = '1';
    canvas.style.display = 'none';
    canvas.style.pointerEvents = 'none';
    const limparAntigo = canvas.nextElementSibling;
    if (limparAntigo && /limpar assinatura/i.test(String(limparAntigo.textContent || ''))) limparAntigo.style.display = 'none';

    const controls = doc.createElement('div');
    controls.id = 'controlesAssinaturaTelaCheia';
    controls.style.cssText = 'margin-top:6px;padding:12px;border:1px solid #dbe4ee;border-radius:10px;background:#f8fafc;';
    controls.innerHTML =
      '<button id="btnAbrirAssinaturaTelaCheia" type="button" style="width:100%;padding:15px;border:none;border-radius:10px;background:linear-gradient(135deg,#1a1f3a,#2d3561);color:white;font-size:16px;font-weight:800;cursor:pointer;">✍️ Assinar em tela cheia</button>' +
      '<div id="assinaturaStatusTelaCheia" style="font-size:12px;color:#5f6368;line-height:1.4;margin-top:8px;text-align:center;">Abra a área de assinatura e entregue o celular ao recebedor.</div>' +
      '<img id="assinaturaPreviewTelaCheia" alt="Prévia da assinatura" style="display:none;width:100%;height:90px;object-fit:contain;border:1px solid #dadce0;border-radius:8px;margin-top:8px;background:white;">' +
      '<button id="btnLimparAssinaturaTelaCheia" type="button" style="display:none;margin:8px auto 0;border:none;background:transparent;color:#c0392b;font-size:13px;font-weight:700;cursor:pointer;">🗑️ Apagar e refazer assinatura</button>';
    canvas.parentNode.insertBefore(controls, canvas);

    doc.getElementById('btnAbrirAssinaturaTelaCheia').addEventListener('click', function() {
      void abrirAssinaturaTelaCheia(doc, host);
    });
    doc.getElementById('btnLimparAssinaturaTelaCheia').addEventListener('click', function() {
      host._assinaturaData = null;
      try { if (typeof host.limparAssinatura === 'function') host.limparAssinatura(); } catch (_) {}
      atualizarPreviewAssinaturaTelaCheia(doc, host);
    });
    atualizarPreviewAssinaturaTelaCheia(doc, host);
    return true;
  }

  function installFullscreenSignatureMode(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host || typeof doc.getElementById !== 'function') return false;
    if (doc.__portariaSignatureObserver) return true;

    const enhance = function() { aprimorarAssinaturaRetirada(doc, host); };
    enhance();
    const Observer = host.MutationObserver;
    if (!Observer || !doc.documentElement) return false;
    const observer = new Observer(enhance);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    doc.__portariaSignatureObserver = observer;
    return true;
  }

  function triggerNativePhotoInput(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return false;
    const input = doc.getElementById('inputFotoOCR');
    if (!input || typeof input.click !== 'function') return false;
    input.value = '';
    input.click();
    return true;
  }

  function installNativePhotoMode(doc, host) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    host = host || root;
    if (!doc || !host) return false;
    updateManualCaptureUi(doc);
    const input = doc.getElementById('inputFotoOCR');
    if (!input) return false;

    host.fotografarEtiqueta = function() {
      try {
        if (typeof host.fecharCameraUnificada === 'function') host.fecharCameraUnificada();
      } catch (_) {}
      return triggerNativePhotoInput(doc);
    };
    return true;
  }

  async function recognizeWithPaddle(imgBase64, statusEl, host) {
    host = host || root;
    if (!host || typeof host.fetch !== 'function') throw new Error('Navegador sem suporte ao leitor do servidor.');
    const storage = host.localStorage;
    const token = storage && typeof storage.getItem === 'function' ? (storage.getItem('authToken') || '') : '';
    const apiBase = storage && typeof storage.getItem === 'function' ? (storage.getItem('apiBaseUrl') || '') : '';
    if (!token) throw new Error('Sessão expirada. Entre novamente no sistema.');
    if (statusEl) statusEl.textContent = 'Lendo a fotografia com PaddleOCR no servidor...';

    const response = await host.fetch(apiBase + '/api/ocr-paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify({ imagemBase64: imgBase64 })
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload.error || payload.detail || ('PaddleOCR respondeu ' + response.status));
    const result = payload.result || payload;
    if (!String(result.text || '').trim()) throw new Error('PaddleOCR não encontrou texto legível na fotografia.');
    return {
      text: String(result.text || ''),
      confidence: Number(result.confidence || 0),
      lines: Array.isArray(result.lines) ? result.lines : [],
      engine: 'paddleocr'
    };
  }

  function installPaddleOcrMode(host) {
    host = host || root;
    if (!host || typeof host.enviarParaOCR !== 'function') return false;
    const original = host.enviarParaOCR;
    if (original.__paddleWrapped) return true;

    const wrapped = async function(imgBase64, statusEl, codigoJaLido = null, transpJaLida = '', leituraId, ocrResult = null) {
      if (ocrResult) {
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, ocrResult);
      }
      try {
        const paddleResult = await recognizeWithPaddle(imgBase64, statusEl, host);
        if (statusEl) statusEl.textContent = 'PaddleOCR concluiu a leitura. Conferindo destinatário...';
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, paddleResult);
      } catch (error) {
        console.warn('PaddleOCR indisponível, usando leitor local como contingência:', error);
        if (statusEl) statusEl.textContent = 'Leitor do servidor indisponível. Tentando leitor local...';
        return original.call(this, imgBase64, statusEl, codigoJaLido, transpJaLida, leituraId, null);
      }
    };
    wrapped.__paddleWrapped = true;
    wrapped.__original = original;
    host.enviarParaOCR = wrapped;
    return true;
  }

  function create({ onStatus = () => {} } = {}) {
    let stopped = false;
    updateManualCaptureUi();
    onStatus('Use Fotografar etiqueta, enquadre toda a etiqueta e confirme uma única foto.');
    return {
      stop() { stopped = true; },
      get stopped() { return stopped; }
    };
  }

  if (typeof document !== 'undefined') {
    const install = () => {
      installNativePhotoMode(document, root);
      installPaddleOcrMode(root);
      installAdminShortcut(document);
      installFullscreenSignatureMode(document, root);
    };
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else install();
  }

  const api = {
    measure,
    looksLikeLabel,
    create,
    updateManualCaptureUi,
    installAdminShortcut,
    triggerNativePhotoInput,
    installNativePhotoMode,
    recognizeWithPaddle,
    installPaddleOcrMode,
    atualizarPreviewAssinaturaTelaCheia,
    configurarCanvasAssinaturaTelaCheia,
    abrirAssinaturaTelaCheia,
    fecharAssinaturaTelaCheia,
    aprimorarAssinaturaRetirada,
    installFullscreenSignatureMode,
    automaticCapture: false,
    nativePhotoCapture: true,
    paddleOCRServer: true,
    fullscreenLandscapeSignature: true,
    version: '2026-09-02.4'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
