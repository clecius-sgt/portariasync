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

  function normalizeHouseNumber(value) {
    const raw = String(value || '').toLowerCase().replace(/[^0-9ilo]/g, '');
    if (!/\d/.test(raw)) return '';
    return raw.replace(/[il]/g, '1').replace(/o/g, '0').replace(/^0+(?=\d)/, '');
  }

  function address(value) {
    const original = String(value || '').trim();
    const raw = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/\brva\b/g, 'rua').replace(/\brua\./g, 'rua');
    const street = raw.match(/\b(rua|r\.?|avenida|av\.?|alameda|travessa|trav\.?)\s+(.+)/);
    if (!street) return null;
    const rest = street[2];
    const numberToken = '[0-9ilo]{1,5}[a-z]?';
    const commaPattern = new RegExp('^(.+?),\\s*(?:n(?:umero|ro)?\\.?[\\sº°]*)?(' + numberToken + ')(?=\\s|,|$)(.*)$', 'i');
    const spacePattern = new RegExp("^([a-z][a-z\\s.'-]*?)\\s+(?:n(?:umero|ro)?\\.?[\\sº°]*)?(" + numberToken + ')(?=\\s|,|$)(.*)$', 'i');
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
    return { blocks, addresses };
  }

  function match(text, residents) {
    const { blocks, addresses } = extract(text);
    const candidates = [];
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
      if (!best && addresses.some(a => ['exact', 'incomplete'].includes(addressRelation(a, home)))) best = { morador: resident, score: 15, safe: false, addressOwner: true, relation: 'address-only', motivos: ['Destinatário não cadastrado', 'Endereço localizado no cadastro: confirme o responsável'] };
      if (best) candidates.push(best);
    }
    candidates.sort((a, b) => b.score - a.score || String(a.morador.id).localeCompare(String(b.morador.id)));
    const safe = candidates.filter(c => c.safe);
    const best = candidates[0];
    const addressOwners = candidates.filter(c => c.addressOwner && ['exact', 'incomplete', 'address-only'].includes(c.relation));
    const chosenBlock = best?.block || blocks.find(b => b.address) || blocks.find(b => b.explicit) || blocks[0];
    const competing = safe.length === 1 && candidates.some(c => c !== safe[0] && c.plausible && ['exact', 'incomplete'].includes(c.relation));
    const blockKeys = new Set(blocks.filter(b => b.address).map(b => normalize(b.name) + '|' + b.address.street + '|' + b.address.number));
    const multipleBlocks = blockKeys.size > 1;
    const confident = safe.length === 1 && !competing && !multipleBlocks;
    let reason = 'Não foi possível cruzar nome completo e endereço. Confira a etiqueta.';
    if (!(residents || []).length) reason = 'O cadastro de moradores está vazio. Cadastre ou sincronize os moradores.';
    else if (confident) reason = 'Nome completo e endereço coincidem com um único cadastro.';
    else if (multipleBlocks) reason = 'A etiqueta contém mais de um bloco de nome e endereço. Confirme qual é o destinatário.';
    else if (safe.length > 1 || competing) reason = 'Há mais de um cadastro compatível. Confirme o destinatário.';
    else if (addressOwners.length === 1 && chosenBlock) reason = 'Destinatário não cadastrado, mas o endereço foi localizado. Confirme o morador responsável pelo endereço antes de registrar.';
    else if (addressOwners.length > 1 && chosenBlock) reason = 'Destinatário não cadastrado. O endereço corresponde a mais de um cadastro; confirme o responsável.';
    else if (best?.relation === 'conflict') reason = 'O nome é parecido, mas o endereço diverge do cadastro.';
    else if (best?.plausible && !best.exactName) reason = 'Nome parcial ou possível erro de leitura. Confirme nome e endereço.';
    else if (!best && chosenBlock) reason = 'Destinatário não localizado no cadastro. Confira a leitura e o cadastro de moradores.';
    return {
      morador: confident ? safe[0].morador : null,
      confiavel: confident,
      candidatoPrincipal: best?.morador || null,
      candidatos: candidates.slice(0, 8),
      responsaveisEndereco: addressOwners.map(c => c.morador),
      destinatarioNaoCadastrado: !confident && addressOwners.length > 0,
      nomeExtraido: chosenBlock?.name || '',
      enderecoExtraido: chosenBlock?.address?.text || addresses[0]?.text || '',
      motivo: reason
    };
  }

  const api = { normalize, nameTokens, similar, normalizeHouseNumber, address, addressRelation, extract, match };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecipientMatching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
