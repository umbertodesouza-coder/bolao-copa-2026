/**
 * Bolão Copa 2026 — Cálculo de Ranking Consolidado
 * GitHub Actions — roda a cada 30 minutos
 * Lê predictions + users + payments do Firestore, calcula pontuação, grava config/ranking
 */

const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

// ── Constantes de pontuação (idênticas ao HTML) ────────────────────────────
const GD = {
  A:['Mexico','Coreia do Sul','Rep. Tcheca','Africa do Sul'],
  B:['Canada','Suica','Catar','Bosnia'],
  C:['Brasil','Marrocos','Escocia','Haiti'],
  D:['EUA','Paraguai','Turquia','Australia'],
  E:['Alemanha','Equador','Costa do Marfim','Curacao'],
  F:['Holanda','Japao','Suecia','Tunisia'],
  G:['Belgica','Ira','Egito','Nova Zelandia'],
  H:['Espanha','Uruguai','Arabia Saudita','Cabo Verde'],
  I:['Franca','Senegal','Noruega','Iraque'],
  J:['Argentina','Austria','Algeria','Jordania'],
  K:['Portugal','Colombia','Uzbequistao','RD Congo'],
  L:['Inglaterra','Croacia','Gana','Panama']
};
const GK = Object.keys(GD);

function getMx(ts) {
  const m = [];
  for (let i = 0; i < ts.length; i++)
    for (let j = i+1; j < ts.length; j++)
      m.push([ts[i], ts[j]]);
  return m;
}

const ALL = [];
GK.forEach(g => getMx(GD[g]).forEach((_, i) => ALL.push(g + i)));

const PH = {
  group: {r:1,  e:3},
  r32:   {r:2,  e:6},
  r16:   {r:4,  e:12},
  qf:    {r:8,  e:24},
  sf:    {r:16, e:48},
  tp:    {r:16, e:48},
  final: {r:32, e:96}
};

const BF_PTS = { champion:10, runnerup:6, scorer:5 };

function scoreM(p, r, phase) {
  if (!p || !r || p.h === '' || r.h === '' || p.h == null || r.h == null) return -1;
  const ph = parseInt(p.h), pa = parseInt(p.a);
  const rh = parseInt(r.h), ra = parseInt(r.a);
  if (isNaN(ph)||isNaN(pa)||isNaN(rh)||isNaN(ra)) return -1;
  const phObj = PH[phase] || PH.group;
  if (ph === rh && pa === ra) return phObj.e;
  const pr = ph>pa?'H':ph<pa?'A':'D';
  const rr = rh>ra?'H':rh<ra?'A':'D';
  return pr === rr ? phObj.r : 0;
}

function calcScore(pred, results, koMatches, bonusRes) {
  if (!pred) return { pts:0, exact:0, res:0, filled:0 };
  let pts=0, exact=0, res=0, filled=0;

  ALL.forEach(id => {
    const p = pred.matches?.[id];
    if (p && p.h !== '' && p.h != null) filled++;
    const sc = scoreM(p, results?.[id], 'group');
    if (sc === PH.group.e) { pts += sc; exact++; }
    else if (sc > 0) { pts += sc; res++; }
  });

  (koMatches || []).forEach(m => {
    if (!m.score || !pred.ko?.[m.id]) return;
    const sc = scoreM(pred.ko[m.id], m.score, m.phase);
    const phObj = PH[m.phase] || PH.group;
    if (sc === phObj.e) { pts += sc; exact++; }
    else if (sc > 0) { pts += sc; res++; }
  });

  Object.entries(BF_PTS).forEach(([k, p]) => {
    if (pred.bonus?.[k] && bonusRes?.[k])
      if (pred.bonus[k].toLowerCase() === bonusRes[k].toLowerCase()) pts += p;
  });

  return { pts, exact, res, filled };
}

async function syncRanking() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Calculando ranking...`);

  // 1. Ler config/wc
  const wcSnap = await db.doc('config/wc').get();
  if (!wcSnap.exists) { console.log('  config/wc não encontrado — abortando'); return; }
  const wc = wcSnap.data();
  const results   = wc.results   || {};
  const koMatches = wc.koMatches || [];
  const bonusRes  = wc.bonusResults || {};

  // 2. Ler usuários, palpites e pagamentos em paralelo
  const [usersSnap, predsSnap, paymentsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('predictions').get(),
    db.collection('payments').get()
  ]);

  const users = {}, preds = {}, payments = {};
  usersSnap.forEach(d => { users[d.id] = d.data(); });
  predsSnap.forEach(d => { preds[d.id] = d.data(); });
  paymentsSnap.forEach(d => { payments[d.id] = d.data(); });

  const sortFn = (a, b) => b.pts-a.pts || b.exact-a.exact || b.res-a.res;

  // 3. Calcular e separar por grupo
  const groupEntries = {};
  const allEntries = [];
  const allEntriesIncludingUnpaid = [];

  Object.keys(users).forEach(uid => {
    const user = users[uid];
    const pay  = payments[uid];
    const isPaid = pay && pay.status === 'approved';
    const gid  = user.groupId || 'bolao-inicial';
    const sc   = calcScore(preds[uid], results, koMatches, bonusRes);

    const entry = {
      uid,
      name:   user.displayName || 'Sem nome',
      pts:    sc.pts,
      exact:  sc.exact,
      res:    sc.res,
      filled: sc.filled,
      paid:   isPaid === true
    };

    allEntriesIncludingUnpaid.push(entry);

    if (isPaid) {
      if (!groupEntries[gid]) groupEntries[gid] = [];
      groupEntries[gid].push(entry);
      allEntries.push(entry);
    }
  });

  allEntries.sort(sortFn);
  allEntriesIncludingUnpaid.sort(sortFn);
  Object.keys(groupEntries).forEach(gid => groupEntries[gid].sort(sortFn));

  const groups = {};
  Object.keys(groupEntries).forEach(gid => {
    groups[gid] = {
      entries:    groupEntries[gid],
      totalUsers: groupEntries[gid].length,
      totalPaid:  groupEntries[gid].length
    };
  });

  const totalPaid  = allEntries.length;
  const totalUsers = Object.keys(users).length;

  // 4. Gravar config/ranking (campos completos, compatível com sync-locks.js)
  await db.doc('config/ranking').set({
    entries:    allEntries,
    entriesAll: allEntriesIncludingUnpaid,
    groups,
    totalUsers,
    totalPaid,
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    calculatedAt: new Date().toISOString()
  });

  console.log(`  ✓ Ranking: ${totalPaid} pagos / ${totalUsers} total`);
  console.log(`  ✓ 1º lugar: ${allEntries[0]?.name || '—'} (${allEntries[0]?.pts || 0}pts)`);
  Object.keys(groups).forEach(gid => {
    const g = groups[gid];
    console.log(`    └ ${gid}: ${g.totalPaid} pagos · 1º ${g.entries[0]?.name || '—'} (${g.entries[0]?.pts || 0}pts)`);
  });
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncRanking()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
