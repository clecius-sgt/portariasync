(function(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RecipientReviewUI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const STYLE_ID = 'recipientReviewUiStyles';

  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function firstName(value) {
    return String(value || '').trim().split(/\s+/)[0] || 'morador';
  }

  function candidateFor(result, resident) {
    return (result?.candidatos || []).find(candidate => String(candidate?.morador?.id || '') === String(resident?.id || '')) || null;
  }

  function sameAddressCandidate(candidate) {
    const reasons = (candidate?.motivos || []).map(normalize).join(' ');
    return /outro morador cadastrado no mesmo endereco/.test(reasons) || /mesmo endereco/.test(reasons);
  }

  function presentation(result, resident, index) {
    const candidate = candidateFor(result, resident);
    const primaryId = String(result?.candidatoPrincipal?.id || result?.candidatos?.[0]?.morador?.id || '');
    const isPrimary = String(resident?.id || '') === primaryId || (!primaryId && index === 0);
    const remembered = !!candidate?.memoriaConfirmada || (!!result?.memoriaConfirmada && isPrimary);

    if (remembered) {
      return {
        role: 'remembered',
        badge: 'Já confirmado anteriormente',
        instruction: 'Confira se o nome impresso continua sendo desta pessoa.',
        action: 'Conferi a etiqueta - selecionar ' + firstName(resident?.nome)
      };
    }
    if (isPrimary) {
      return {
        role: 'primary',
        badge: 'Mais provável pela etiqueta',
        instruction: 'Compare o nome impresso com este cadastro antes de selecionar.',
        action: 'Conferi a etiqueta - selecionar ' + firstName(resident?.nome)
      };
    }
    if (sameAddressCandidate(candidate)) {
      return {
        role: 'same-address',
        badge: 'Outro morador do mesmo endereço',
        instruction: 'Selecione somente se este for o nome que aparece na etiqueta.',
        action: 'Conferi a etiqueta - selecionar ' + firstName(resident?.nome)
      };
    }
    return {
      role: 'alternative',
      badge: 'Outra opção do cadastro',
      instruction: 'Use esta opção apenas se a etiqueta confirmar este morador.',
      action: 'Conferi a etiqueta - selecionar ' + firstName(resident?.nome)
    };
  }

  function installStyles(doc) {
    if (!doc?.head || doc.getElementById(STYLE_ID) || typeof doc.createElement !== 'function') return false;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #modalSugestaoMorador{padding:10px!important;align-items:flex-start!important;overflow-y:auto!important;background:rgba(15,18,36,.72)!important;}
      #modalSugestaoMorador>div{max-width:640px!important;width:min(100%,640px)!important;max-height:none!important;margin:12px auto!important;border-radius:18px!important;padding:0!important;overflow:hidden!important;box-shadow:0 18px 60px rgba(0,0,0,.32)!important;background:#f8fafc!important;}
      #modalSugestaoMorador #tituloSugestaoMorador{margin:0!important;padding:18px 18px 4px!important;font-size:21px!important;color:#1a1f3a!important;}
      #modalSugestaoMorador [data-review-intro]{margin:0 18px 14px;padding:10px 12px;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:13px;line-height:1.45;}
      #modalSugestaoMorador [data-review-summary]{margin:0 18px 14px;background:white;border:1px solid #e2e8f0;border-radius:14px;padding:12px 14px;box-shadow:0 1px 3px rgba(15,23,42,.05);}
      #modalSugestaoMorador [data-review-summary] [data-review-row]{display:grid;grid-template-columns:118px 1fr;gap:8px;padding:7px 0;line-height:1.4;font-size:14px;}
      #modalSugestaoMorador [data-review-summary] [data-review-row]+[data-review-row]{border-top:1px solid #eef2f7;}
      #modalSugestaoMorador [data-review-summary] strong{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;}
      #modalSugestaoMorador [data-review-summary] span{font-weight:700;color:#172033;overflow-wrap:anywhere;}
      #modalSugestaoMorador details{margin:0 18px 10px!important;background:white;border:1px solid #e2e8f0;border-radius:10px;padding:9px 11px;}
      #modalSugestaoMorador details summary{cursor:pointer;font-weight:700;color:#475569;font-size:13px;}
      #modalSugestaoMorador label[for="filtroSugestaoMorador"]{display:block;margin:14px 18px 2px!important;font-size:12px!important;font-weight:700!important;color:#64748b!important;text-transform:uppercase;letter-spacing:.04em;}
      #modalSugestaoMorador #filtroSugestaoMorador{width:calc(100% - 36px)!important;margin:6px 18px 14px!important;border:1px solid #cbd5e1!important;background:white!important;border-radius:10px!important;padding:11px 12px!important;}
      #modalSugestaoMorador #listaSugestoesModal{padding:0 18px;}
      #modalSugestaoMorador #listaSugestoesModal>[data-review-card]{position:relative;border:1px solid #dbe3ec!important;border-radius:14px!important;padding:14px!important;margin-bottom:12px!important;background:white;box-shadow:0 1px 4px rgba(15,23,42,.06);}
      #modalSugestaoMorador #listaSugestoesModal>[data-review-role="primary"],
      #modalSugestaoMorador #listaSugestoesModal>[data-review-role="remembered"]{border:2px solid #2d7d4f!important;background:#f7fcf9;}
      #modalSugestaoMorador [data-review-badge]{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;margin-bottom:8px;font-size:11px;font-weight:800;letter-spacing:.01em;background:#eef2ff;color:#3730a3;}
      #modalSugestaoMorador [data-review-role="primary"] [data-review-badge],
      #modalSugestaoMorador [data-review-role="remembered"] [data-review-badge]{background:#e6f4ea;color:#137333;}
      #modalSugestaoMorador [data-review-role="same-address"] [data-review-badge]{background:#fff7e6;color:#8a5b00;}
      #modalSugestaoMorador [data-review-card]>strong{display:block;font-size:18px;color:#172033;line-height:1.25;margin-bottom:3px;}
      #modalSugestaoMorador [data-review-house]{font-size:14px;color:#475569;margin-bottom:8px;}
      #modalSugestaoMorador [data-review-reason]{font-size:13px!important;color:#475569!important;margin:8px 0 5px!important;line-height:1.4;padding-top:8px;border-top:1px solid #eef2f7;}
      #modalSugestaoMorador [data-review-instruction]{font-size:12px;color:#64748b;line-height:1.4;margin-bottom:10px;}
      #modalSugestaoMorador [data-review-card]>button{width:100%!important;padding:12px 14px!important;border:0!important;border-radius:10px!important;background:#1a1f3a!important;color:white!important;font-weight:800!important;font-size:14px!important;white-space:normal!important;}
      #modalSugestaoMorador [data-review-role="primary"]>button,
      #modalSugestaoMorador [data-review-role="remembered"]>button{background:#2d7d4f!important;}
      #modalSugestaoMorador #fecharSugestaoMorador{width:calc(100% - 36px)!important;margin:2px 18px 18px!important;padding:12px!important;border:1px solid #cbd5e1!important;border-radius:10px!important;background:white!important;color:#475569!important;font-weight:700!important;}
      @media(max-width:520px){
        #modalSugestaoMorador{padding:0!important;}
        #modalSugestaoMorador>div{width:100%!important;margin:0!important;border-radius:0!important;min-height:100dvh!important;}
        #modalSugestaoMorador [data-review-summary] [data-review-row]{grid-template-columns:1fr;gap:2px;}
      }
    `;
    doc.head.appendChild(style);
    return true;
  }

  function createIntro(doc, panel) {
    if (panel.querySelector?.('[data-review-intro]')) return;
    const title = panel.querySelector?.('#tituloSugestaoMorador');
    if (!title) return;
    const intro = doc.createElement('div');
    intro.dataset.reviewIntro = '1';
    intro.textContent = 'Compare a etiqueta com o cadastro. O sistema sugere, mas a seleção só deve ser feita após conferência visual.';
    title.insertAdjacentElement('afterend', intro);
  }

  function createSummary(doc, panel) {
    if (panel.querySelector?.('[data-review-summary]')) return;
    const name = panel.querySelector?.('#nomeLidoSugestao');
    const address = panel.querySelector?.('#enderecoLidoSugestao');
    if (!name || !address) return;
    const nameRow = name.parentElement;
    const addressRow = address.parentElement;
    if (!nameRow || !addressRow) return;
    const summary = doc.createElement('section');
    summary.dataset.reviewSummary = '1';
    nameRow.dataset.reviewRow = 'name';
    addressRow.dataset.reviewRow = 'address';
    summary.append(nameRow, addressRow);
    const anchor = panel.querySelector?.('#fotoSugestao') || panel.querySelector?.('details');
    if (anchor) panel.insertBefore(summary, anchor);
    else panel.appendChild(summary);
  }

  function residentForCard(modal, card) {
    const title = card.querySelector?.('strong');
    const house = title?.nextElementSibling;
    const name = normalize(title?.textContent);
    const address = normalize(house?.textContent);
    const candidates = modal?._resultado?.candidatos || [];
    const matched = candidates.find(candidate => normalize(candidate?.morador?.nome) === name && normalize(candidate?.morador?.casa) === address);
    if (matched?.morador) return matched.morador;
    return (modal?._moradores || []).find(resident => normalize(resident?.nome) === name && normalize(resident?.casa) === address) || null;
  }

  function enhanceCard(doc, modal, card, index) {
    if (!card || card.dataset?.reviewCard === '1') return false;
    const title = card.querySelector?.('strong');
    const house = title?.nextElementSibling;
    const reason = house?.nextElementSibling;
    const button = card.querySelector?.('button');
    const resident = residentForCard(modal, card);
    if (!title || !house || !reason || !button || !resident) return false;
    const view = presentation(modal._resultado || {}, resident, index);

    card.dataset.reviewCard = '1';
    card.dataset.reviewRole = view.role;
    house.dataset.reviewHouse = '1';
    reason.dataset.reviewReason = '1';

    const badge = doc.createElement('div');
    badge.dataset.reviewBadge = '1';
    badge.textContent = view.badge;
    card.insertBefore(badge, title);

    const instruction = doc.createElement('div');
    instruction.dataset.reviewInstruction = '1';
    instruction.textContent = view.instruction;
    card.insertBefore(instruction, button);

    button.textContent = view.action;
    button.setAttribute('aria-label', view.action + ' - ' + String(resident.casa || ''));
    return true;
  }

  function enhanceModal(doc, modal) {
    if (!doc || !modal || modal.id !== 'modalSugestaoMorador') return false;
    installStyles(doc);
    const panel = modal.firstElementChild;
    if (!panel) return false;
    createIntro(doc, panel);
    createSummary(doc, panel);

    const search = modal.querySelector?.('#filtroSugestaoMorador');
    if (search && !search.getAttribute('placeholder')) search.setAttribute('placeholder', 'Digite nome, rua ou número');

    const list = modal.querySelector?.('#listaSugestoesModal');
    if (list) Array.from(list.children || []).forEach((card, index) => enhanceCard(doc, modal, card, index));

    const close = modal.querySelector?.('#fecharSugestaoMorador');
    if (close) close.textContent = 'Voltar sem selecionar ninguém';
    modal.dataset.reviewEnhanced = '1';
    return true;
  }

  function install(host) {
    host = host || root;
    const doc = host?.document;
    if (!doc || host.__recipientReviewUiInstalled) return !!doc;
    host.__recipientReviewUiInstalled = true;
    installStyles(doc);

    const apply = () => {
      const modal = doc.getElementById?.('modalSugestaoMorador');
      if (modal) enhanceModal(doc, modal);
    };
    apply();

    if (typeof host.MutationObserver === 'function' && doc.body) {
      const observer = new host.MutationObserver(() => apply());
      observer.observe(doc.body, { childList: true, subtree: true });
      host.RecipientReviewUIRuntime = { observer, apply, version: '2026-09-02.1' };
    } else {
      host.RecipientReviewUIRuntime = { apply, version: '2026-09-02.1' };
    }
    return true;
  }

  const api = {
    STYLE_ID,
    normalize,
    firstName,
    candidateFor,
    sameAddressCandidate,
    presentation,
    installStyles,
    enhanceCard,
    enhanceModal,
    install,
    version: '2026-09-02.1'
  };

  if (typeof document !== 'undefined') {
    const start = () => install(root);
    if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  return api;
});