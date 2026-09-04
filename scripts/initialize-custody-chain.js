'use strict';

const path = require('path');
const { AssociationManager } = require('../association-manager');
const { backfillState, verifyChain } = require('../custody-chain');

const dataDir = path.join(__dirname, '..', 'data');
const manager = new AssociationManager({ dataDir });

let totalAssociations = 0;
let totalPackages = 0;
let initialized = 0;
let alreadyProtected = 0;

try {
  for (const association of manager.list()) {
    totalAssociations++;
    const state = manager.readState(association.id);
    const packages = Array.isArray(state.encomendas) ? state.encomendas : [];
    totalPackages += packages.length;
    const missing = packages.filter(item => !Array.isArray(item?.cadeiaCustodia) || !item.cadeiaCustodia.length).length;

    for (const item of packages) {
      if (Array.isArray(item?.cadeiaCustodia) && item.cadeiaCustodia.length) {
        const integrity = verifyChain(item);
        if (!integrity.ok) throw new Error(`Cadeia inválida em ${association.id}/${item.id}: ${integrity.reason}`);
        alreadyProtected++;
      }
    }

    if (!missing) {
      console.log(`[${association.id}] ${packages.length} encomenda(s), todas já protegidas.`);
      continue;
    }

    const result = backfillState(state, { now: new Date() });
    if (result.changed) {
      result.state.version = Date.now();
      result.state.updatedAt = new Date().toISOString();
      manager.writeState(association.id, result.state);
      initialized += missing;
    }
    console.log(`[${association.id}] ${packages.length} encomenda(s), ${missing} cadeia(s) inicializada(s).`);
  }

  console.log('---');
  console.log('Associações:', totalAssociations);
  console.log('Encomendas:', totalPackages);
  console.log('Cadeias inicializadas:', initialized);
  console.log('Já protegidas:', alreadyProtected);
  console.log('Resultado: OK');
} finally {
  manager.closeAll();
}
