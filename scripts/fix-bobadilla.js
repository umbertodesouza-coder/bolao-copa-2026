/**
 * Script único — remove o gol contra do Bobadilla do acumulador
 * e força reprocessamento do jogo EUA x Paraguai
 */
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

async function run() {
  const ref = db.doc('config/scorersAccum');
  const snap = await ref.get();
  if (!snap.exists) { console.log('Sem dados.'); return; }
  const data = snap.data();

  // Remove a entrada do Bobadilla (gol contra)
  const key = Object.keys(data.players||{}).find(k => k.startsWith(normName('Damián Bobadilla')) || k.startsWith(normName('Damian Bobadilla')));
  if (key) {
    console.log('Removendo:', key, data.players[key]);
    delete data.players[key];
  } else {
    console.log('Bobadilla não encontrado no acumulador.');
  }

  await ref.set(data);
  console.log('✓ Acumulador atualizado');

  // Marca scorers como precisando recálculo
  await db.doc('config/scorers').set({ status: 'needs_recalc' }, { merge: true });
}

run().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
