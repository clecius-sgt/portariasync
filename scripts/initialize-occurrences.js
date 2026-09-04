#!/usr/bin/env node
'use strict';

const path = require('path');
const { AssociationManager } = require('../association-manager');
const { OccurrenceService, ensureOccurrenceTables, readOccurrenceEvents, verifyOccurrenceEvents } = require('../occurrence-service');

const ROOT = path.resolve(__dirname, '..');
const associations = new AssociationManager({
  dataDir:path.join(ROOT, 'data'),
  defaultName:process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const service = new OccurrenceService({ associations });

let total = 0;
let open = 0;
let events = 0;
let attachments = 0;
let invalid = 0;

for (const association of associations.list().filter(item => item.active !== false)) {
  const database = associations.database(association.id);
  ensureOccurrenceTables(database);
  const status = service.status(association.id);
  total += status.total;
  open += status.opened;
  events += status.events;
  attachments += status.attachments;

  const rows = database.db.prepare('SELECT id FROM occurrences ORDER BY opened_at').all();
  for (const row of rows) {
    const check = verifyOccurrenceEvents(readOccurrenceEvents(database, row.id));
    if (!check.ok) invalid++;
  }

  console.log(`[${association.id}] ${status.total} ocorrência(s), ${status.opened} aberta(s), ${status.events} evento(s), ${status.attachments} anexo(s).`);
}

console.log('---');
console.log('Ocorrências:', total);
console.log('Abertas:', open);
console.log('Eventos:', events);
console.log('Anexos:', attachments);
console.log('Linhas do tempo inválidas:', invalid);
console.log('Resultado:', invalid === 0 ? 'OK' : 'FALHA');

associations.closeAll();
if (invalid) process.exitCode = 1;
