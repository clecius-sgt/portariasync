'use strict';

const crypto = require('crypto');

const CHAIN_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const EMPTY_HASH = '0'.repeat(64);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const direct = new Date(value);
  if (Number.isFinite(direct.getTime())) return direct;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, d, m, y, hh = '0', mm = '0', ss = '0'] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value, fallback = new Date()) {
  const parsed = parseDate(value);
  return (parsed || fallback).toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 3) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^data:/i.test(value)) return '[conteúdo protegido]';
    return value.slice(0, 300);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeMetadata(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 300);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/pin|senha|password|token|secret|codigoHash|codigoSalt|assinatura|foto|imagem/i.test(key)) continue;
    out[key] = sanitizeMetadata(item, depth + 1);
  }
  return out;
}

function eventPayload(event) {
  return {
    version: Number(event.version || CHAIN_VERSION),
    packageId: String(event.packageId || ''),
    seq: Number(event.seq || 0),
    id: String(event.id || ''),
    occurredAt: String(event.occurredAt || ''),
    recordedAt: String(event.recordedAt || ''),
    type: String(event.type || ''),
    title: String(event.title || ''),
    description: String(event.description || ''),
    actor: String(event.actor || ''),
    actorRole: String(event.actorRole || ''),
    source: String(event.source || ''),
    metadata: sanitizeMetadata(event.metadata || {}),
    previousHash: String(event.previousHash || EMPTY_HASH)
  };
}

function hashEvent(event) {
  return crypto.createHash(HASH_ALGORITHM).update(stableStringify(eventPayload(event))).digest('hex');
}

function chainOf(pkg) {
  return Array.isArray(pkg?.cadeiaCustodia) ? pkg.cadeiaCustodia.filter(Boolean) : [];
}

function verifyChain(pkg) {
  const chain = chainOf(pkg);
  let previousHash = EMPTY_HASH;
  for (let index = 0; index < chain.length; index++) {
    const event = chain[index];
    if (Number(event.seq) !== index + 1) return { ok: false, index, reason: 'sequence' };
    if (String(event.previousHash || EMPTY_HASH) !== previousHash) return { ok: false, index, reason: 'previous-hash' };
    const expected = hashEvent(event);
    if (String(event.hash || '') !== expected) return { ok: false, index, reason: 'hash' };
    previousHash = expected;
  }
  return { ok: true, count: chain.length, lastHash: previousHash };
}

function actorFromAudit(state, packageId, patterns = []) {
  const audits = Array.isArray(state?.auditoria) ? state.auditoria : [];
  const id = String(packageId || '');
  const filtered = audits.filter(item => {
    const details = item?.detalhes || item || {};
    const eventPackage = String(details.encomendaId || details.packageId || '');
    if (eventPackage && eventPackage !== id) return false;
    const text = String(item?.acao || item?.action || '').toLowerCase();
    return !patterns.length || patterns.some(pattern => text.includes(String(pattern).toLowerCase()));
  });
  const chosen = filtered[0] || filtered.at?.(-1) || null;
  return {
    actor: String(chosen?.usuarioNome || chosen?.usuario || 'PortalSync'),
    actorRole: String(chosen?.usuarioPerfil || chosen?.perfil || 'sistema')
  };
}

function appendEvent(pkg, spec = {}) {
  if (!pkg || !pkg.id) throw new Error('Encomenda inválida para a cadeia de custódia.');
  const chain = chainOf(pkg).map(clone);
  if (chain.length) {
    const integrity = verifyChain({ cadeiaCustodia: chain });
    if (!integrity.ok) throw new Error('Integridade da cadeia de custódia comprometida.');
  }
  const previousHash = chain.length ? String(chain.at(-1).hash) : EMPTY_HASH;
  const recordedAt = iso(spec.recordedAt || new Date());
  const seq = chain.length + 1;
  const event = {
    version: CHAIN_VERSION,
    packageId: String(pkg.id),
    seq,
    id: `cc-${String(pkg.id)}-${seq}-${crypto.randomBytes(4).toString('hex')}`,
    occurredAt: iso(spec.occurredAt || recordedAt, new Date(recordedAt)),
    recordedAt,
    type: String(spec.type || 'event'),
    title: String(spec.title || 'Evento registrado').slice(0, 120),
    description: String(spec.description || '').slice(0, 500),
    actor: String(spec.actor || 'PortalSync').slice(0, 120),
    actorRole: String(spec.actorRole || 'sistema').slice(0, 40),
    source: String(spec.source || 'sistema').slice(0, 80),
    metadata: sanitizeMetadata(spec.metadata || {}),
    previousHash
  };
  event.hash = hashEvent(event);
  chain.push(event);
  pkg.cadeiaCustodia = chain;
  const integrity = verifyChain(pkg);
  pkg.cadeiaCustodiaMeta = {
    version: CHAIN_VERSION,
    algorithm: HASH_ALGORITHM,
    appendOnly: true,
    integrity: integrity.ok ? 'ok' : 'error',
    eventCount: chain.length,
    lastHash: integrity.lastHash || null,
    verifiedAt: recordedAt
  };
  return event;
}

function authorizationRecords(item) {
  const list = Array.isArray(item?.autorizacoesRetirada) ? item.autorizacoesRetirada.filter(Boolean) : [];
  if (!list.length && item?.autorizacaoRetirada && typeof item.autorizacaoRetirada === 'object') list.push(item.autorizacaoRetirada);
  return list;
}

function addBackfillEvents(pkg, state, now = new Date()) {
  const actor = actorFromAudit(state, pkg.id, ['encomenda registrada']);
  appendEvent(pkg, {
    type: 'package_received',
    title: 'Encomenda recebida',
    description: 'Evento reconstruído a partir do registro existente quando a cadeia digital foi ativada.',
    occurredAt: pkg.dataEntrada || now,
    recordedAt: now,
    actor: actor.actor,
    actorRole: actor.actorRole,
    source: 'migração-segura',
    metadata: { reconstructed: true, codigo: pkg.codigo || '', transportadora: pkg.transportadora || '' }
  });
  if (pkg.moradorId || pkg.moradorNome) {
    appendEvent(pkg, {
      type: 'recipient_confirmed',
      title: 'Destinatário confirmado',
      description: 'Destinatário incorporado à cadeia a partir do cadastro existente.',
      occurredAt: pkg.dataEntrada || now,
      recordedAt: now,
      actor: actor.actor,
      actorRole: actor.actorRole,
      source: 'migração-segura',
      metadata: { reconstructed: true, moradorId: pkg.moradorId || '', moradorNome: pkg.moradorNome || '' }
    });
  }
  if (pkg.pinRetiradaEnviado === true) {
    appendEvent(pkg, {
      type: 'resident_notified',
      title: 'Notificação ao morador registrada',
      description: 'O registro existente informa que o aviso de retirada foi enviado.',
      occurredAt: pkg.pinRetiradaEnviadoEm || pkg.dataEntrada || now,
      recordedAt: now,
      actor: 'PortalSync', actorRole: 'sistema', source: 'migração-segura',
      metadata: { reconstructed: true, canal: 'WhatsApp' }
    });
  }
  if (pkg.status === 'cancelado') {
    const cancelActor = actorFromAudit(state, pkg.id, ['cancel']);
    appendEvent(pkg, {
      type: 'package_cancelled', title: 'Encomenda cancelada',
      description: pkg.motivoCancelamento ? 'Motivo: ' + String(pkg.motivoCancelamento).slice(0, 240) : 'Cancelamento incorporado a partir do registro existente.',
      occurredAt: pkg.dataCancelamento || now, recordedAt: now,
      actor: cancelActor.actor, actorRole: cancelActor.actorRole, source: 'migração-segura',
      metadata: { reconstructed: true }
    });
  }
  if (pkg.status === 'retirado') {
    const withdrawalActor = actorFromAudit(state, pkg.id, ['retir']);
    if (pkg.assinatura) {
      appendEvent(pkg, {
        type: 'signature_collected', title: 'Assinatura de retirada registrada',
        description: 'A existência da assinatura foi incorporada à cadeia sem expor a imagem.',
        occurredAt: pkg.dataRetirada || now, recordedAt: now,
        actor: withdrawalActor.actor, actorRole: withdrawalActor.actorRole, source: 'migração-segura',
        metadata: { reconstructed: true, assinaturaPresente: true }
      });
    }
    appendEvent(pkg, {
      type: 'package_withdrawn', title: 'Encomenda entregue',
      description: pkg.retiradoPor ? 'Retirada registrada para ' + String(pkg.retiradoPor).slice(0, 120) + '.' : 'Retirada incorporada a partir do registro existente.',
      occurredAt: pkg.dataRetirada || now, recordedAt: now,
      actor: withdrawalActor.actor, actorRole: withdrawalActor.actorRole, source: 'migração-segura',
      metadata: { reconstructed: true, tipoRetirante: pkg.retiranteTipo || '', retirante: pkg.retiradoPor || '' }
    });
  }
  appendEvent(pkg, {
    type: 'chain_enabled', title: 'Cadeia de custódia digital ativada',
    description: 'A partir deste marco, novos eventos são acrescentados de forma encadeada e verificável.',
    occurredAt: now, recordedAt: now, actor: 'PortalSync', actorRole: 'sistema', source: 'cadeia-custodia',
    metadata: { reconstructedHistory: true }
  });
}

function appendTransitionEvents(previous, current, state, now = new Date()) {
  const packageId = current.id;
  const operationalActor = actorFromAudit(state, packageId);

  if (!previous.fotoEtiqueta && current.fotoEtiqueta) {
    appendEvent(current, {
      type: 'label_evidence_recorded', title: 'Imagem da etiqueta vinculada',
      description: 'A imagem da etiqueta foi vinculada ao registro sem ser incorporada ao histórico em texto.',
      occurredAt: current.dataEntrada || now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'leitor-etiqueta',
      metadata: { imagemPresente: true }
    });
  }

  const prevResident = [previous.moradorId || '', previous.moradorNome || '', previous.moradorCasa || ''].join('|');
  const currResident = [current.moradorId || '', current.moradorNome || '', current.moradorCasa || ''].join('|');
  if (prevResident !== currResident && (current.moradorId || current.moradorNome)) {
    const corrected = !!(previous.moradorId || previous.moradorNome);
    appendEvent(current, {
      type: corrected ? 'recipient_corrected' : 'recipient_confirmed',
      title: corrected ? 'Destinatário corrigido' : 'Destinatário confirmado',
      description: corrected ? 'O destinatário do registro foi corrigido sem apagar o histórico anterior.' : 'Destinatário confirmado para a encomenda.',
      occurredAt: now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'operação',
      metadata: {
        moradorId: current.moradorId || '', moradorNome: current.moradorNome || '',
        anteriorMoradorId: corrected ? previous.moradorId || '' : '', anteriorMoradorNome: corrected ? previous.moradorNome || '' : ''
      }
    });
  }

  const previousData = [previous.codigo || '', previous.transportadora || '', previous.obs || ''].join('|');
  const currentData = [current.codigo || '', current.transportadora || '', current.obs || ''].join('|');
  if (previousData !== currentData) {
    const correctionActor = actorFromAudit(state, packageId, ['encomenda corrigida']);
    appendEvent(current, {
      type: 'package_data_corrected',
      title: 'Dados da encomenda corrigidos',
      description: current.motivoUltimaCorrecao
        ? 'Motivo: ' + String(current.motivoUltimaCorrecao).slice(0, 240)
        : 'Código, transportadora ou observação foram atualizados sem apagar o histórico anterior.',
      occurredAt: current.cadastroAtualizadoEm || now,
      recordedAt: now,
      actor: correctionActor.actor,
      actorRole: correctionActor.actorRole,
      source: 'gestao-encomendas-2',
      metadata: {
        codigoAnterior: previous.codigo || '',
        codigoAtual: current.codigo || '',
        transportadoraAnterior: previous.transportadora || '',
        transportadoraAtual: current.transportadora || ''
      }
    });
  }

  const pinWasSent = previous.pinRetiradaEnviado === true;
  const pinIsSent = current.pinRetiradaEnviado === true;
  const resent = pinWasSent && current.pinRetiradaEnviadoEm && current.pinRetiradaEnviadoEm !== previous.pinRetiradaEnviadoEm;
  if ((!pinWasSent && pinIsSent) || resent) {
    appendEvent(current, {
      type: resent ? 'resident_notification_resent' : 'resident_notified',
      title: resent ? 'Aviso reenviado ao morador' : 'Morador notificado',
      description: 'Aviso de encomenda/PIN registrado como enviado pelo WhatsApp.',
      occurredAt: current.pinRetiradaEnviadoEm || now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'WhatsApp',
      metadata: { canal: 'WhatsApp', reenvio: resent }
    });
  }

  const previousAuth = new Map(authorizationRecords(previous).map(record => [String(record.id || ''), record]));
  for (const record of authorizationRecords(current)) {
    const id = String(record.id || '');
    const before = previousAuth.get(id);
    if (!before) {
      const authActor = actorFromAudit(state, packageId, ['autorização digital de retirada criada']);
      appendEvent(current, {
        type: 'third_party_authorization_created', title: 'Autorização digital para terceiro criada',
        description: 'O morador autorizou uma pessoa específica para esta encomenda.',
        occurredAt: record.criadaEm || now, recordedAt: now,
        actor: authActor.actor, actorRole: authActor.actorRole || 'morador', source: 'Portal do Morador',
        metadata: { authorizationId: id, autorizado: record.nome || '', expiraEm: record.expiraEm || null }
      });
    }
    if (before && !before.validadaEm && record.validadaEm) {
      appendEvent(current, {
        type: 'third_party_authorization_validated', title: 'Autorização digital validada',
        description: 'Código e documento da pessoa autorizada foram validados.',
        occurredAt: record.validadaEm, recordedAt: now,
        actor: record.validadaPor || operationalActor.actor, actorRole: 'porteiro', source: 'portaria',
        metadata: { authorizationId: id, autorizado: record.nome || '' }
      });
    }
    if (before && String(before.status || 'ativa') !== String(record.status || 'ativa')) {
      const status = String(record.status || '').toLowerCase();
      if (status === 'cancelada' || status === 'bloqueada' || status === 'utilizada' || status === 'encerrada') {
        appendEvent(current, {
          type: 'third_party_authorization_' + status,
          title: status === 'cancelada' ? 'Autorização digital cancelada' : status === 'bloqueada' ? 'Autorização digital bloqueada' : status === 'utilizada' ? 'Autorização digital utilizada' : 'Autorização digital encerrada',
          description: 'Mudança de status da autorização registrada na cadeia.',
          occurredAt: record.canceladaEm || record.bloqueadaEm || record.utilizadaEm || record.encerradaEm || now,
          recordedAt: now, actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'PortalSync',
          metadata: { authorizationId: id, status }
        });
      }
    }
  }

  if (!previous.fotoRetirante && current.fotoRetirante) {
    appendEvent(current, {
      type: 'third_party_evidence_collected', title: 'Evidência do terceiro registrada',
      description: 'Foto do documento ou da pessoa retirante foi coletada. A imagem não é reproduzida na cadeia.',
      occurredAt: current.dataRetirada || now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'portaria',
      metadata: { evidenciaPresente: true, tipoRetirante: current.retiranteTipo || '' }
    });
  }

  if (!previous.pinRetiradaMetodo && current.pinRetiradaMetodo) {
    appendEvent(current, {
      type: 'withdrawal_validation', title: 'Validação de retirada concluída',
      description: current.pinRetiradaMetodo === 'autorizacao-digital'
        ? 'Retirada validada por autorização digital de terceiro.'
        : current.pinRetiradaMetodo === 'liberacao-administrativa'
          ? 'Retirada liberada administrativamente com justificativa registrada.'
          : 'PIN de retirada validado.',
      occurredAt: current.pinRetiradaValidadoEm || current.dataRetirada || now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'controle-retirada',
      metadata: { metodo: current.pinRetiradaMetodo }
    });
  }

  if (!previous.assinatura && current.assinatura) {
    appendEvent(current, {
      type: 'signature_collected', title: 'Assinatura coletada',
      description: 'Assinatura obrigatória da retirada foi registrada. A imagem não é reproduzida na cadeia.',
      occurredAt: current.dataRetirada || now, recordedAt: now,
      actor: operationalActor.actor, actorRole: operationalActor.actorRole, source: 'portaria',
      metadata: { assinaturaPresente: true }
    });
  }

  if (previous.status !== 'cancelado' && current.status === 'cancelado') {
    const cancelActor = actorFromAudit(state, packageId, ['cancel']);
    appendEvent(current, {
      type: 'package_cancelled', title: 'Encomenda cancelada',
      description: current.motivoCancelamento ? 'Motivo: ' + String(current.motivoCancelamento).slice(0, 240) : 'Cancelamento registrado.',
      occurredAt: current.dataCancelamento || now, recordedAt: now,
      actor: cancelActor.actor, actorRole: cancelActor.actorRole, source: 'operação', metadata: {}
    });
  }

  if (previous.status === 'cancelado' && current.status === 'pendente') {
    const reopenActor = actorFromAudit(state, packageId, ['reabert']);
    appendEvent(current, {
      type: 'package_reopened',
      title: 'Encomenda reaberta',
      description: current.motivoReabertura
        ? 'Motivo: ' + String(current.motivoReabertura).slice(0, 240)
        : 'O cancelamento foi revertido e a encomenda voltou a aguardar retirada.',
      occurredAt: current.dataReabertura || now,
      recordedAt: now,
      actor: reopenActor.actor,
      actorRole: reopenActor.actorRole,
      source: 'gestao-encomendas-2',
      metadata: { statusAnterior: 'cancelado', statusAtual: 'pendente' }
    });
  }

  if (previous.status !== 'retirado' && current.status === 'retirado') {
    const withdrawalActor = actorFromAudit(state, packageId, ['retir']);
    appendEvent(current, {
      type: 'package_withdrawn', title: 'Encomenda entregue',
      description: current.retiradoPor ? 'Retirada concluída por ' + String(current.retiradoPor).slice(0, 120) + '.' : 'Retirada concluída.',
      occurredAt: current.dataRetirada || now, recordedAt: now,
      actor: withdrawalActor.actor, actorRole: withdrawalActor.actorRole, source: 'portaria',
      metadata: { tipoRetirante: current.retiranteTipo || '', retirante: current.retiradoPor || '' }
    });
  }
}

function reconcilePackage(previous, incoming, state, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const current = clone(incoming || {});
  if (!current.id) return current;

  if (previous) {
    const existingChain = chainOf(previous).map(clone);
    if (existingChain.length) {
      const integrity = verifyChain({ cadeiaCustodia: existingChain });
      if (!integrity.ok) throw new Error(`Integridade da cadeia de custódia comprometida na encomenda ${current.id}.`);
      current.cadeiaCustodia = existingChain;
      current.cadeiaCustodiaMeta = clone(previous.cadeiaCustodiaMeta || null);
    } else {
      delete current.cadeiaCustodia;
      delete current.cadeiaCustodiaMeta;
      addBackfillEvents(current, state, now);
    }
    appendTransitionEvents(previous, current, state, now);
  } else {
    delete current.cadeiaCustodia;
    delete current.cadeiaCustodiaMeta;
    const actor = actorFromAudit(state, current.id, ['encomenda registrada']);
    appendEvent(current, {
      type: 'package_received', title: 'Encomenda recebida', description: 'Entrada registrada no PortalSync.',
      occurredAt: current.dataEntrada || now, recordedAt: now,
      actor: actor.actor, actorRole: actor.actorRole, source: 'operação',
      metadata: { codigo: current.codigo || '', transportadora: current.transportadora || '' }
    });
    if (current.fotoEtiqueta) {
      appendEvent(current, {
        type: 'label_evidence_recorded', title: 'Imagem da etiqueta vinculada',
        description: 'Imagem da etiqueta vinculada ao recebimento.', occurredAt: current.dataEntrada || now, recordedAt: now,
        actor: actor.actor, actorRole: actor.actorRole, source: 'leitor-etiqueta', metadata: { imagemPresente: true }
      });
    }
    if (current.moradorId || current.moradorNome) {
      appendEvent(current, {
        type: 'recipient_confirmed', title: 'Destinatário confirmado', description: 'Destinatário confirmado para o recebimento.',
        occurredAt: current.dataEntrada || now, recordedAt: now,
        actor: actor.actor, actorRole: actor.actorRole, source: 'operação',
        metadata: { moradorId: current.moradorId || '', moradorNome: current.moradorNome || '' }
      });
    }
    if (current.pinRetiradaEnviado === true) {
      appendEvent(current, {
        type: 'resident_notified', title: 'Morador notificado', description: 'Aviso de encomenda/PIN enviado pelo WhatsApp.',
        occurredAt: current.pinRetiradaEnviadoEm || now, recordedAt: now,
        actor: 'PortalSync', actorRole: 'sistema', source: 'WhatsApp', metadata: { canal: 'WhatsApp' }
      });
    }
  }

  const integrity = verifyChain(current);
  current.cadeiaCustodiaMeta = {
    version: CHAIN_VERSION,
    algorithm: HASH_ALGORITHM,
    appendOnly: true,
    integrity: integrity.ok ? 'ok' : 'error',
    eventCount: chainOf(current).length,
    lastHash: integrity.lastHash || null,
    verifiedAt: now.toISOString()
  };
  return current;
}

function reconcileState(previousState, incomingState, options = {}) {
  const previous = previousState && previousState.exists !== false ? previousState : { encomendas: [] };
  const next = clone(incomingState || {});
  const before = new Map((previous.encomendas || []).filter(item => item?.id).map(item => [String(item.id), item]));
  next.encomendas = (next.encomendas || []).map(item => reconcilePackage(before.get(String(item?.id || '')) || null, item, next, options));
  return next;
}

function backfillState(state, options = {}) {
  const original = clone(state || {});
  const before = clone(state || {});
  const next = reconcileState(before, original, options);
  let changed = false;
  next.encomendas = (next.encomendas || []).map((item, index) => {
    const previous = (before.encomendas || [])[index];
    if (!previous?.cadeiaCustodia?.length) {
      changed = true;
      const rebuilt = clone(previous || item);
      delete rebuilt.cadeiaCustodia;
      delete rebuilt.cadeiaCustodiaMeta;
      addBackfillEvents(rebuilt, next, options.now instanceof Date ? options.now : new Date(options.now || Date.now()));
      return rebuilt;
    }
    return item;
  });
  return { state: next, changed };
}

module.exports = {
  CHAIN_VERSION,
  HASH_ALGORITHM,
  EMPTY_HASH,
  stableStringify,
  sanitizeMetadata,
  hashEvent,
  chainOf,
  verifyChain,
  appendEvent,
  reconcilePackage,
  reconcileState,
  backfillState,
  parseDate,
  iso
};
