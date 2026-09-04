#!/usr/bin/env node
'use strict';

const path = require('path');
const { AssociationManager } = require('../association-manager');
const { WithdrawalReceiptService, receiptForPackage, verifyReceipt } = require('../withdrawal-receipt');

const ROOT = path.resolve(__dirname, '..');
const associations = new AssociationManager({
  dataDir: path.join(ROOT, 'data'),
  defaultName: process.env.DEFAULT_ASSOCIATION_NAME || 'Associação de Moradores'
});
const service = new WithdrawalReceiptService({ associations });

let withdrawn = 0;
let created = 0;
let recovered = 0;
let waiting = 0;
let invalid = 0;

for (const association of associations.list().filter(item => item.active !== false)) {
  const summary = service.ensureAssociation(association.id);
  withdrawn += summary.withdrawn;
  created += summary.created;
  recovered += summary.recovered;
  waiting += summary.waiting;
  invalid += summary.invalid;

  const state = associations.readState(association.id);
  const database = associations.database(association.id);
  for (const pkg of state.encomendas || []) {
    if (pkg?.status !== 'retirado') continue;
    const receipt = receiptForPackage(database, pkg.id);
    if (!receipt) {
      if (!summary.waiting) invalid++;
      continue;
    }
    if (!verifyReceipt(receipt).ok) invalid++;
  }

  console.log(`[${association.id}] ${summary.withdrawn} retirada(s), ${summary.created} comprovante(s) criado(s), ${summary.recovered} vínculo(s) recuperado(s), ${summary.waiting} aguardando finalização.`);
}

console.log('---');
console.log('Retiradas:', withdrawn);
console.log('Comprovantes criados:', created);
console.log('Vínculos recuperados:', recovered);
console.log('Aguardando finalização:', waiting);
console.log('Integridade inválida:', invalid);
console.log('Resultado:', invalid === 0 ? 'OK' : 'FALHA');

associations.closeAll();
if (invalid) process.exitCode = 1;
