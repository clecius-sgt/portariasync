(function(root) {
  'use strict';

  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function nameTokens(value) {
    return normalize(value).split(' ').filter(t => t && !/^(de|da|do|das|dos|e)$/.test(t));
  }

  function similar(a, b) {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
      row = next;
    }
    return row[b.length] <= 1;
  }

  function nameEvidenceScore(text, residentName) {
    const words = normalize(text).split(' ').filter(Boolean);
    const tokens = nameTokens(residentName);
    if (!words.length || !tokens.length) return 0;
    const available = [...words];
    let hits = 0;
    let firstNameHit = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const index = available.findIndex(word => word === token || similar(word, token));
      if (index >= 0) {
        hits++;
        if (i === 0) firstNameHit = true;
        available.splice(index, 1);
      }
    }
    const full = normalize(residentName);
    const phraseHit = full && (' ' + normalize(text) + ' ').includes(' ' + full + ' ');
    return hits * 20 + (firstNameHit ? 25 : 0) + (phraseHit ? 100 : 0);
  }

  function normalizeHouseNumber(value) {
    const cleaned = String(value || '').toLowerCase().replace(/[^0-9a-z]/g, '');
    const suffixMatch = cleaned.match(/[a-hj-km-np-z]$/);
    const suffix = suffixMatch ? suffixMatch[0] : '';
    const base = suffix ? cleaned.slice(0, -1) : cleaned;
    if (!/[0-9ilo]/.test(base)) return '';
    return base.replace(/[il]/g, '1').replace(/o/g, '0').replace(/^0+(?=\d)/, '') + suffix;
  }

  function address(value) {
    const original = String(value || '').trim();
    const raw = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/\brva\b/g, 'rua').replace(/\brva\./g, 'rua').replace(/\brua\./g, 'rua');
    const street = raw.match(/\b(rua|r\.?|avenida|av\.?|alameda|travessa|trav\.?)\s+(.+)/);
    if (!street) return null;
    const rest = street[2];
    const numberToken = '[0-9ilo]{1,5}[a-z]?';
    const commaPattern = new RegExp('^(.+?),\\s*(?:n(?:umero|ro)?\\.?[\\sº°]*)?(' + numberToken + ')(?=\\s|,|$)(.*)$', 'i');
    const spacePattern = new RegExp("^([a-z0-9][a-z0-9\\s.'-]*?)\\s+(?:n(?:umero|ro)?\\.?[\\sº°]*)?(" + numberToken + ')(?=\\s|,|$)(.*)$', 'i');
    const parts = rest.match(commaPattern) || rest.match(spacePattern);
    if (!parts) return null;
    const number = normalizeHouseNumber(parts[2]);
    if (!number) return null;
    const kind = /^(r|rua)\.?$/.test(street[1]) ? 'rua' : /^(av|avenida)\.?$/.test(street[1]) ? 'avenida' : /^trav/.test(street[1]) ? 'travessa' : street[1];
    const extra = normalize(parts[3]);
    const unit = {};
    for (const match of extra.matchAll(/\b(apto|apartamento|ap|bloco|bl|sala|casa)\s+([a-z0-9]+)\b/g)) {
      const key = /^(apto|apartamento|ap)$/.test(match[1]) ? 'apto' : /^(bloco|bl)$/.test(match[1]) ? 'bloco' : match[1];
      unit[key] = match[2];
    }
    return { street: kind + ' ' + normalize(parts[1]), number, unit, text: original };
  }

  function addressRelation(a, b) {
    if (!a || !b) return 'missing';
    if (a.street !== b.street || a.number !== b.number) return 'conflict';
    const keys = new Set([...Object.keys(a.unit), ...Object.keys(b.unit)]);
    if ([...keys].some(k => a.unit[k] && b.unit[k] && a.unit[k] !== b.unit[k])) return 'conflict';
    if ([...keys].some(k => !a.unit[k] || !b.unit[k])) return 'incomplete';
    return 'exact';
  }

  function streetTokens(street) {
    return normalize(street).split(' ').filter(t => t && !/^(rua|r|avenida|av|alameda|travessa|trav|de|da|do|das|dos)$/.test(t));
  }

  function addressEvidence(text, home) {
    if (!home) return null;
    const wanted = streetTokens(home.street);
    if (!wanted.length) return null;
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + 2).join(' ');
      const words = normalize(window).split(' ').filter(Boolean);
      let streetHits = 0;
      for (const token of wanted) {
        if (words.some(word => word === token || similar(word, token))) streetHits++;
      }
      const required = wanted.length <= 2 ? wanted.length : Math.ceil(wanted.length * 0.7);
      if (streetHits < Math.max(1, required)) continue;
      const rawNumbers = window.toLowerCase().match(/\b[0-9ilo]{1,5}[a-z]?\b/g) || [];
      if (!rawNumbers.some(n => normalizeHouseNumber(n) === home.number)) continue;

      let relation = 'exact';
      const unitKeys = Object.keys(home.unit || {});
      if (unitKeys.length) {
        const parsed = address(window);
        if (parsed) {
          for (const key of unitKeys) {
            if (parsed.unit[key] && parsed.unit[key] !== home.unit[key]) return null;
            if (!parsed.unit[key]) relation = 'incomplete';
          }
        } else relation = 'incomplete';
      }
      return { relation, text: window };
    }
    return null;
  }

  function recipientNameText(text, home) {
    if (!home) return '';
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      let found = false;
      for (const span of [1, 2]) {
        const window = lines.slice(i, i + span).join(' ');
        const parsed = address(window);
        const relation = parsed ? addressRelation(parsed, home) : 'missing';
        if (relation === 'exact' || relation === 'incomplete' || addressEvidence(window, home)) {
          found = true;
          break;
        }
      }
      if (!found) continue;
      return lines.slice(Math.max(0, i - 2), i)
        .filter(line => {
          const norm = normalize(line);
          return norm && !address(line) && !/\b\d{5,}\b/.test(norm) &&
            !/^(cep|codigo|rastreamento|pedido|remessa|nota|order|tentativa|bairro|cidade|estado|dados|transporte|transportadora|courier|service|servico|servicos)\b/.test(norm);
        })
        .join(' ');
    }
    return '';
  }

  function probableName(line) {
    const norm = normalize(line);
    return !/\d/.test(norm) && nameTokens(norm).length >= 2 && nameTokens(norm).length <= 8
      && !/^(rua|r|rva|avenida|av|alameda|travessa|res|residencial|condominio|bairro|cidade|estado|cep|br|brasil|brazil|predio|remetente|destinatario|origem|destino|endereco|complemento|nota|order|tentativa|liquid|cycle|mercado livre|amazon|shopee)\b/.test(norm);
  }

  function extract(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let sender = false, recipient = false;
    const usable = [];
    for (const line of lines) {
      const norm = normalize(line);
      if (/^(remetente|sender|from|origem)\b/.test(norm)) { sender = true; recipient = false; continue; }
      if (/^(destinatario|destino|recipient|para|to)\b/.test(norm)) {
        sender = false; recipient = true;
        const name = line.replace(/^[^\s:]+\s*:?\s*/, '').trim();
        if (name) usable.push({ text: name, recipient });
        continue;
      }
      if (!sender) usable.push({ text: line.replace(/^nome\s*:\s*/i, ''), recipient });
    }
    const explicit = usable.some(l => l.recipient);
    const focus = explicit ? usable.filter(l => l.recipient) : usable;
    const evidenceText = focus.map(l => l.text).join('\n');
    const blocks = [];
    const addresses = focus.map(l => address(l.text)).filter(Boolean);
    for (let i = 0; i < focus.length; i++) {
      let name = focus[i].text.replace(/\s*\([A-Z0-9 -]{4,}\)\s*$/, '').trim();
      if (!probableName(name)) continue;
      let addr = focus[i + 1] ? address(focus[i + 1].text) : null;
      if (!addr && focus[i + 1] && focus[i + 2] && probableName(focus[i + 1].text) && address(focus[i + 2].text)) {
        name += ' ' + focus[++i].text;
        addr = address(focus[i + 1].text);
      }
      if (addr && focus[i + 2] && /^(apto|apartamento|ap|bloco|bl|sala|casa)\b/.test(normalize(focus[i + 2].text))) addr = address(addr.text + ' ' + focus[i + 2].text);
      blocks.push({ name, address: addr, explicit: focus[i].recipient });
    }
    return { blocks, addresses, evidenceText };
  }

  function match(text, residents) {
    const { blocks, addresses, evidenceText } = extract(text);
    const candidates = [];
    const normalizedText = ' ' + normalize(evidenceText) + ' ';
    for (const resident of residents || []) {
      const tokens = nameTokens(resident.nome);
      if (!resident.id || tokens.length < 2) continue;
      const home = address(resident.casa);
      let best = null;
      for (const block of blocks) {
        const read = nameTokens(block.name), available = [...tokens];
        let hits = 0;
        for (const token of read) {
          const index = available.findIndex(t => similar(token, t));
          if (index >= 0) { hits++; available.splice(index, 1); }
        }
        const exactName = read.join(' ') === tokens.join(' ');
        const plausible = hits >= 2 && hits / read.length >= 0.75;
        const relation = addressRelation(block.address, home);
        if (!plausible && relation !== 'exact' && relation !== 'incomplete') continue;
        const safe = exactName && relation === 'exact';
        const addressOwner = !plausible && ['exact', 'incomplete'].includes(relation);
        const score = (exactName ? 60 : plausible ? 30 : 0) + (relation === 'exact' ? 35 : relation === 'incomplete' ? 15 : 0);
        const reasons = [exactName ? 'Nome completo coincide' : plausible ? 'Nome parcial ou com erro de leitura' : 'Destinatário não consta neste cadastro',
          relation === 'exact' ? 'Rua e número coincidem' : relation === 'conflict' ? 'Endereço divergente' : 'Endereço ausente ou incompleto'];
        if (!best || score > best.score) best = { morador: resident, score, safe, addressOwner, exactName, plausible, relation, block, motivos: reasons };
      }

      if (!best) {
        const direct = addresses.find(a => ['exact', 'incomplete'].includes(addressRelation(a, home)));
        if (direct) {
          best = { morador: resident, score: 20, safe: false, addressOwner: true, relation: 'address-only', evidenceText: direct.text,
            motivos: ['Destinatário não cadastrado', 'Endereço localizado no cadastro: confirme o responsável'] };
        }
      }

      if (!best) {
        const evidence = addressEvidence(evidenceText, home);
        if (evidence) {
          const residentName = normalize(resident.nome);
          const exactNameAnywhere = residentName && normalizedText.includes(' ' + residentName + ' ');
          const safe = exactNameAnywhere && evidence.relation === 'exact';
          best = { morador: resident, score: safe ? 95 : 18, safe, addressOwner: !exactNameAnywhere,
            exactName: exactNameAnywhere, plausible: false, relation: evidence.relation === 'exact' ? 'address-only' : 'incomplete', evidenceText: evidence.text,
            motivos: exactNameAnywhere ? ['Nome completo coincide', 'Endereço confirmado mesmo com ruído de OCR'] : ['Destinatário não cadastrado', 'Rua e número reconhecidos apesar de erro de OCR: confirme o responsável'] };
        }
      }
      if (best) candidates.push(best);
    }

    function candidateAddressRank(candidate) {
      if (!candidate) return -1;
      if (candidate.safe) return 6;
      if (candidate.relation === 'exact') return 5;
      if (candidate.relation === 'incomplete') return 4;
      if (candidate.relation === 'address-only') return 3;
      if (candidate.relation === 'missing') return 1;
      if (candidate.relation === 'conflict') return 0;
      return 1;
    }

    function candidateNameEvidence(candidate) {
      const home = address(candidate.morador.casa);
      const nearby = recipientNameText(evidenceText, home);
      const localScore = nearby ? nameEvidenceScore(nearby, candidate.morador.nome) : 0;
      const blockScore = candidate.block?.name ? nameEvidenceScore(candidate.block.name, candidate.morador.nome) : 0;
      return localScore * 8 + blockScore * 4 + nameEvidenceScore(evidenceText, candidate.morador.nome);
    }

    const addressAnchor = candidates.slice().sort((a, b) =>
      candidateAddressRank(b) - candidateAddressRank(a) || b.score - a.score
    )[0] || null;
    if (addressAnchor && candidateAddressRank(addressAnchor) >= 3) {
      const anchorHome = address(addressAnchor.morador.casa);
      for (const resident of residents || []) {
        if (!resident?.id || candidates.some(c => String(c.morador.id) === String(resident.id))) continue;
        if (addressRelation(anchorHome, address(resident.casa)) !== 'exact') continue;
        candidates.push({
          morador: resident,
          score: 10,
          safe: false,
          addressOwner: true,
          exactName: false,
          plausible: false,
          relation: 'address-only',
          evidenceText: addressAnchor.block?.address?.text || addressAnchor.evidenceText || '',
          motivos: ['Outro morador cadastrado no mesmo endereço', 'Confirme o nome impresso na etiqueta']
        });
      }
    }

    candidates.sort((a, b) => {
      const sameHome = addressRelation(address(a.morador.casa), address(b.morador.casa)) === 'exact';
      if (sameHome) {
        const nameDifference = candidateNameEvidence(b) - candidateNameEvidence(a);
        if (nameDifference !== 0) return nameDifference;
        if (!!a.exactName !== !!b.exactName) return a.exactName ? -1 : 1;
        if (!!a.plausible !== !!b.plausible) return a.plausible ? -1 : 1;
      } else {
        const addressDifference = candidateAddressRank(b) - candidateAddressRank(a);
        if (addressDifference !== 0) return addressDifference;
      }
      return b.score - a.score || String(a.morador.id).localeCompare(String(b.morador.id));
    });

    const safe = candidates.filter(c => c.safe);
    const best = candidates[0];
    const addressOwners = candidates.filter(c => c.addressOwner && ['exact', 'incomplete', 'address-only'].includes(c.relation));
    const uniqueAddressOwner = addressOwners.length === 1 ? addressOwners[0] : null;
    const competing = safe.length === 1 && candidates.some(c => c !== safe[0] && c.plausible && ['exact', 'incomplete'].includes(c.relation));
    const sameHomeResidents = best
      ? candidates.filter(c => c !== best && addressRelation(address(best.morador.casa), address(c.morador.casa)) === 'exact')
      : [];
    const blockKeys = new Set(blocks.filter(b => b.address).map(b => normalize(b.name) + '|' + b.address.street + '|' + b.address.number));
    const multipleBlocks = blockKeys.size > 1;
    const confident = safe.length === 1 && !competing && !multipleBlocks && sameHomeResidents.length === 0;
    const principal = confident ? safe[0] : (best || safe[0] || uniqueAddressOwner);
    const chosenBlock = principal?.block || best?.block || blocks.find(b => b.address) || blocks.find(b => b.explicit) || blocks[0];
    const addressText = chosenBlock?.address?.text || uniqueAddressOwner?.block?.address?.text || uniqueAddressOwner?.evidenceText || addresses[0]?.text || best?.evidenceText || '';
    const rankedCandidates = candidates;

    let reason = 'Não foi possível cruzar nome completo e endereço. Confira a etiqueta.';
    if (!(residents || []).length) reason = 'O cadastro de moradores está vazio. Cadastre ou sincronize os moradores.';
    else if (confident) reason = 'Nome completo e endereço coincidem com um único cadastro.';
    else if (sameHomeResidents.length > 0) reason = 'Há mais de um morador cadastrado neste endereço. Confirme qual nome consta na etiqueta antes de registrar.';
    else if (multipleBlocks) reason = 'A etiqueta contém mais de um bloco de nome e endereço. Confirme qual é o destinatário.';
    else if (safe.length > 1 || competing) reason = 'Há mais de um cadastro compatível. Confirme o destinatário.';
    else if (addressOwners.length === 1) reason = 'Destinatário não cadastrado, mas o endereço foi localizado. Confirme o morador responsável pelo endereço antes de registrar.';
    else if (addressOwners.length > 1) reason = 'Destinatário não cadastrado. O endereço corresponde a mais de um cadastro; confirme o responsável.';
    else if (best?.relation === 'conflict') reason = 'O nome é parecido, mas o endereço diverge do cadastro.';
    else if (best?.plausible && !best.exactName) reason = 'Nome parcial ou possível erro de leitura. Confirme nome e endereço.';
    else if (!best && chosenBlock) reason = 'Destinatário não localizado no cadastro. Confira a leitura e o cadastro de moradores.';
    return {
      morador: confident ? safe[0].morador : null,
      confiavel: confident,
      candidatoPrincipal: principal?.morador || null,
      candidatos: rankedCandidates.slice(0, 8),
      responsaveisEndereco: addressOwners.map(c => c.morador),
      destinatarioNaoCadastrado: safe.length === 0 && addressOwners.length > 0,
      nomeExtraido: chosenBlock?.name || blocks.find(b => b.explicit)?.name || '',
      enderecoExtraido: addressText,
      motivo: reason
    };
  }

  const api = { normalize, nameTokens, similar, nameEvidenceScore, normalizeHouseNumber, address, addressRelation, addressEvidence, recipientNameText, extract, match, version: '2026-09-03.4' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecipientMatching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);