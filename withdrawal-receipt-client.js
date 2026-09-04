(function(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WithdrawalReceiptUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  const VERSION = '2026-09-04.1';

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString('pt-BR');
    return String(value);
  }

  function findLocalPackage(id) {
    try {
      if (typeof encomendas !== 'undefined' && Array.isArray(encomendas)) {
        return encomendas.find(item => String(item?.id || '') === String(id || '')) || null;
      }
    } catch (_) {}
    return Array.isArray(root?.encomendas)
      ? root.encomendas.find(item => String(item?.id || '') === String(id || '')) || null
      : null;
  }

  async function authoritativePackage(id) {
    try {
      if (typeof root?.apiFetch === 'function') {
        const state = await root.apiFetch('/api/app-state');
        const pkg = (state?.encomendas || []).find(item => String(item?.id || '') === String(id || ''));
        if (pkg) return pkg;
      }
    } catch (_) {}
    return findLocalPackage(id);
  }

  function receiptRows(receipt) {
    const w = receipt?.withdrawal || {};
    const p = receipt?.package || {};
    return [
      ['Comprovante', receipt?.receiptNumber || '-'],
      ['Encomenda', p.code || '-'],
      ['Transportadora', p.carrier || '-'],
      ['Destinatário', p.residentName || '-'],
      ['Endereço / unidade', p.residentHouse || '-'],
      ['Entrada', p.entryAt || '-'],
      ['Retirada', w.at || '-'],
      ['Retirante', w.person || '-'],
      ['Modalidade', w.type === 'outro' ? 'Terceiro autorizado / identificado' : 'Próprio destinatário'],
      ['Documento', w.documentMasked || 'Não aplicável'],
      ['Operador', w.operator || 'PortalSync'],
      ['Validação', w.validationLabel || '-'],
      ['Assinatura', w.signaturePresent ? 'Coletada' : 'Não registrada'],
      ['Evidência fotográfica', w.photoEvidencePresent ? 'Registrada' : 'Não aplicável']
    ];
  }

  function rowsHtml(receipt) {
    return receiptRows(receipt).map(([label, value]) =>
      `<div class="receipt-row"><div class="receipt-label">${esc(label)}</div><div class="receipt-value">${esc(value)}</div></div>`
    ).join('');
  }

  function receiptBody(pkg, receipt, printable = false) {
    const association = receipt?.association || {};
    const integrityOk = receipt?.integrity === 'ok';
    const signature = pkg?.assinatura && printable
      ? `<div class="receipt-signature"><div class="receipt-label">Assinatura coletada</div><img src="${esc(pkg.assinatura)}" alt="Assinatura da retirada"></div>`
      : (pkg?.assinatura
        ? `<div style="margin-top:14px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;"><div style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:7px;">Assinatura coletada</div><img src="${esc(pkg.assinatura)}" alt="Assinatura da retirada" style="max-width:260px;max-height:120px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;"></div>`
        : '');
    return `
      <div class="receipt-head">
        <div>
          <div class="receipt-brand">PortariaSync</div>
          <div class="receipt-association">${esc(association.name || 'Associação de Moradores')}</div>
        </div>
        <div class="receipt-number">${esc(receipt?.receiptNumber || '')}</div>
      </div>
      <div class="receipt-title">COMPROVANTE DIGITAL DE RETIRADA</div>
      <div class="receipt-integrity ${integrityOk ? 'ok' : 'bad'}">
        ${integrityOk ? 'Integridade verificada por SHA-256' : 'Falha na verificação de integridade'}
      </div>
      <div class="receipt-grid">${rowsHtml(receipt)}</div>
      ${signature}
      <div class="receipt-proof">
        <div><strong>Cadeia de Custódia:</strong> ${esc(String(receipt?.custody?.referenceHash || '').slice(0, 24))}${receipt?.custody?.referenceHash ? '...' : '-'}</div>
        <div><strong>Hash do comprovante:</strong><br><span class="receipt-hash">${esc(receipt?.receiptHash || '-')}</span></div>
        <div><strong>Emitido em:</strong> ${esc(formatDate(receipt?.issuedAt))}</div>
      </div>
      <div class="receipt-note">Documento interno gerado a partir dos registros operacionais e da Cadeia de Custódia do PortalSync. O PIN utilizado nunca é exibido neste comprovante.</div>
    `;
  }

  function baseStyles() {
    return `
      *{box-sizing:border-box}body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#1a1f3a;margin:0;background:#f4f6f9}.receipt-doc{max-width:760px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}.receipt-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #c9a84c;padding-bottom:14px}.receipt-brand{font-weight:900;font-size:23px}.receipt-association{font-size:12px;color:#64748b;margin-top:4px}.receipt-number{font:800 14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px}.receipt-title{text-align:center;font-weight:900;font-size:17px;letter-spacing:.7px;margin:18px 0 10px}.receipt-integrity{padding:9px 12px;border-radius:8px;text-align:center;font-size:12px;font-weight:800;margin-bottom:16px}.receipt-integrity.ok{background:#e6f4ea;color:#137333}.receipt-integrity.bad{background:#fce8e6;color:#c5221f}.receipt-grid{border-top:1px solid #e2e8f0}.receipt-row{display:grid;grid-template-columns:180px 1fr;gap:14px;padding:9px 0;border-bottom:1px solid #e2e8f0}.receipt-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;font-weight:700}.receipt-value{font-size:13px;font-weight:650;word-break:break-word}.receipt-proof{margin-top:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;font-size:11px;line-height:1.65}.receipt-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.receipt-signature{margin-top:16px}.receipt-signature img{display:block;max-width:300px;max-height:130px;margin-top:8px;border:1px solid #e2e8f0;border-radius:6px}.receipt-note{font-size:10px;color:#64748b;line-height:1.5;margin-top:14px}@media(max-width:600px){.receipt-doc{margin:0;border-radius:0;padding:16px}.receipt-row{grid-template-columns:1fr;gap:3px}.receipt-head{flex-direction:column}.receipt-number{align-self:flex-start}}@media print{body{background:#fff}.receipt-doc{box-shadow:none;border:0;margin:0;max-width:none;padding:12mm}.no-print{display:none!important}@page{size:A4 portrait;margin:10mm}}
    `;
  }

  function close() {
    const modal = root?.document?.getElementById('withdrawalReceiptModal');
    if (modal) modal.remove();
  }

  function printReceipt(pkg, receipt) {
    const win = root?.open?.('', '_blank', 'noopener,noreferrer');
    if (!win) {
      root?.toast?.('O navegador bloqueou a janela de impressão.', 5000);
      return false;
    }
    win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(receipt.receiptNumber)} - Comprovante de retirada</title><style>${baseStyles()}</style></head><body><div class="receipt-doc">${receiptBody(pkg, receipt, true)}</div><script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),180)});<\/script></body></html>`);
    win.document.close();
    return true;
  }

  async function waitForReceipt(id, attempts = 5) {
    let pkg = null;
    for (let i = 0; i < attempts; i++) {
      pkg = await authoritativePackage(id);
      if (pkg?.comprovanteRetirada) return pkg;
      if (i < attempts - 1) await new Promise(resolve => root?.setTimeout ? root.setTimeout(resolve, 1000) : setTimeout(resolve, 1000));
    }
    return pkg;
  }

  async function open(id) {
    const doc = root?.document;
    if (!doc?.body) return false;
    close();
    const loading = doc.createElement('div');
    loading.id = 'withdrawalReceiptModal';
    loading.style.cssText = 'position:fixed;inset:0;background:rgba(15,18,36,.72);z-index:102000;display:flex;align-items:center;justify-content:center;padding:16px;';
    loading.innerHTML = '<div style="background:#fff;border-radius:12px;padding:20px 24px;font-weight:800;color:#1a1f3a;">Carregando comprovante protegido...</div>';
    doc.body.appendChild(loading);

    const pkg = await waitForReceipt(id);
    close();
    if (!pkg || pkg.status !== 'retirado') {
      root?.toast?.('Comprovante disponível somente para encomendas retiradas.', 5000);
      return false;
    }
    const receipt = pkg.comprovanteRetirada;
    if (!receipt) {
      root?.toast?.('O comprovante ainda está sendo consolidado. Aguarde alguns segundos e tente novamente.', 6000);
      return false;
    }

    const modal = doc.createElement('div');
    modal.id = 'withdrawalReceiptModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,18,36,.72);z-index:102000;display:flex;align-items:center;justify-content:center;padding:14px;';
    modal.innerHTML = `<div style="width:100%;max-width:820px;max-height:94vh;overflow:auto;background:#f4f6f9;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);"><div class="receipt-doc">${receiptBody(pkg, receipt, false)}<div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px;"><button id="withdrawalReceiptPrint" type="button" style="border:0;border-radius:8px;background:#1a1f3a;color:#fff;padding:10px 15px;font-weight:800;cursor:pointer;">Imprimir comprovante</button><button id="withdrawalReceiptClose" type="button" style="border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155;padding:10px 15px;font-weight:800;cursor:pointer;">Fechar</button></div></div></div>`;
    const style = doc.createElement('style');
    style.textContent = baseStyles();
    modal.appendChild(style);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.querySelector('#withdrawalReceiptClose')?.addEventListener('click', close);
    modal.querySelector('#withdrawalReceiptPrint')?.addEventListener('click', () => printReceipt(pkg, receipt));
    doc.body.appendChild(modal);
    return true;
  }

  function install(host) {
    root = host || root;
    if (!root || root.__withdrawalReceiptUiInstalled) return !!root;
    root.__withdrawalReceiptUiInstalled = true;
    root.gerarComprovanteRetirada = open;
    root.WithdrawalReceiptRuntime = { version: VERSION, open, print: printReceipt };
    return true;
  }

  const api = { VERSION, esc, formatDate, receiptRows, receiptBody, authoritativePackage, waitForReceipt, open, close, printReceipt, install, version: VERSION };

  if (typeof document !== 'undefined') {
    const start = () => install(root);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
    else start();
  }

  return api;
});
