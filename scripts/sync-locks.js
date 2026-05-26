/**
 * Bolão Copa 2026 — Sincronizador automático
 * GitHub Actions — roda a cada 5 minutos
 * v3 — Pagamento: só usuários com paid:true aparecem no ranking
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

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

const TM = {
  'Mexico':'Mexico','South Korea':'Coreia do Sul','Czech Republic':'Rep. Tcheca',
  'Czechia':'Rep. Tcheca','South Africa':'Africa do Sul','Canada':'Canada',
  'Switzerland':'Suica','Qatar':'Catar','Bosnia-Herzegovina':'Bosnia',
  'Bosnia and Herzegovina':'Bosnia','Bosnia & Herzegovina':'Bosnia',
  'Bosnia &amp; Herzegovina':'Bosnia','Brazil':'Brasil','Morocco':'Marrocos',
  'Scotland':'Escocia','Haiti':'Haiti','USA':'EUA','United States':'EUA',
  'Paraguay':'Paraguai','Turkey':'Turquia','Turkiye':'Turquia','Australia':'Australia',
  'Germany':'Alemanha','Ecuador':'Equador','Ivory Coast':'Costa do Marfim',
  'Netherlands':'Holanda','Japan':'Japao','Sweden':'Suecia','Tunisia':'Tunisia',
  'Belgium':'Belgica','Iran':'Ira','Egypt':'Egito','New Zealand':'Nova Zelandia',
  'Spain':'Espanha','Uruguay':'Uruguai','Saudi Arabia':'Arabia Saudita',
  'Cape Verde':'Cabo Verde','France':'Franca','Senegal':'Senegal',
  'Norway':'Noruega','Iraq':'Iraque','Argentina':'Argentina','Austria':'Austria',
  'Algeria':'Algeria','Jordan':'Jordania','Portugal':'Portugal',
  'Colombia':'Colombia','Uzbekistan':'Uzbequistao','DR Congo':'RD Congo',
  'England':'Inglaterra','Croatia':'Croacia','Ghana':'Gana','Panama':'Panama',
  'Curacao':'Curacao','Curaçao':'Curacao','Korea Republic':'Coreia do Sul'
};

const ROUND_MAP = {
  'Round of 32':'r32','Last 32':'r32','Round of 32 ':'r32',
  'Round of 16':'r16','Last 16':'r16','Round of Sixteen':'r16',
  'Quarter-finals':'qf','Quarter-final':'qf','Quarterfinals':'qf','Quarterfinale':'qf',
  'Quarter-Finals':'qf','Quarter-Final':'qf','Quartas de final':'qf','Quarterfinal':'qf',
  'Semi-finals':'sf','Semi-final':'sf','Semifinals':'sf','Semifinal':'sf',
  'Semi-Finals':'sf','Semi-Final':'sf','Meias-finais':'sf',
  'Third-place match':'tp','Third place match':'tp','Third Place':'tp',
  'Third-Place':'tp','Match for third place':'tp','Match for Third Place':'tp',
  'Bronze Final':'tp','3rd Place':'tp','Play-off for third place':'tp',
  '3rd place play-off':'tp','Third place':'tp',
  'Final':'final','The Final':'final'
};

function parseRoundName(round) {
  if (!round) return '';
  if (typeof round === 'string') return round.trim();
  if (typeof round === 'object') return (round.name || round.key || round.label || '').trim();
  return String(round).trim();
}

function getMx(ts) {
  const m = [];
  for (let i = 0; i < ts.length; i++)
    for (let j = i+1; j < ts.length; j++)
      m.push({h:ts[i], a:ts[j]});
  return m;
}

function findMid(t1r, t2r) {
  const t1 = TM[t1r] || t1r, t2 = TM[t2r] || t2r;
  for (const g of GK) {
    const mx = getMx(GD[g]);
    for (let i = 0; i < mx.length; i++) {
      const m = mx[i];
      if ((m.h===t1 && m.a===t2) || (m.h===t2 && m.a===t1)) return g+i;
    }
  }
  return null;
}

function parseMT(d, t) {
  if (!t) return null;
  const parts = t.split(' ');
  if (parts.length < 2) return null;
  const tp = parts[0].split(':');
  const off = parseInt(parts[1].replace('UTC',''));
  const utcH = parseInt(tp[0]) - off;
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCHours(utcH, parseInt(tp[1] || 0), 0, 0);
  return dt.getTime();
}

function validateData(data, stats) {
  const warnings = [];
  if (!data || !data.matches) { warnings.push('JSON sem campo "matches"'); return warnings; }
  if (data.matches.length === 0) { warnings.push('Campo "matches" está vazio'); return warnings; }
  if (stats.groupMatches === 0) warnings.push('Nenhum jogo de grupo encontrado');
  if (stats.groupMatches < 72 && stats.groupMatches > 0) warnings.push(`Apenas ${stats.groupMatches}/72 jogos encontrados`);
  if (stats.unknownTeams.length > 0) warnings.push(`Times não reconhecidos: ${stats.unknownTeams.slice(0,5).join(', ')}`);
  if (stats.roundFormats.mixed) warnings.push(`Formato misto de rounds detectado`);
  if (stats.koMatches > 0 && stats.koPhasesMissing.length > 0) warnings.push(`Fases KO sem mapeamento: ${stats.koPhasesMissing.join(', ')}`);
  return warnings;
}

async function syncLocks() {
  const WC_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Iniciando sincronização...`);

  let data;
  try {
    const res = await fetch(`${WC_URL}?t=${now}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.error('Erro ao buscar dados:', e.message);
    await db.doc('config/wc').set({
      lastSync: admin.firestore.FieldValue.serverTimestamp(),
      syncStatus: 'error', syncError: e.message,
      syncMessage: `Falha ao buscar openfootball: ${e.message}`
    }, { merge: true });
    return;
  }

  const lt = {}, results = {}, koMatches = [];
  const roundCtrs = {};
  const stats = { groupMatches:0, koMatches:0, unknownTeams:[], roundFormats:{string:0,object:0,mixed:false}, koPhasesMissing:[] };

  for (const m of (data.matches || [])) {
    const lockTime = parseMT(m.date, m.time);
    if (m.group) {
      const mid = findMid(m.team1, m.team2);
      if (!mid) {
        if (!stats.unknownTeams.includes(m.team1)) stats.unknownTeams.push(m.team1);
        if (!stats.unknownTeams.includes(m.team2)) stats.unknownTeams.push(m.team2);
        continue;
      }
      if (lockTime) lt[mid] = lockTime;
      if (m.score?.ft?.length === 2) results[mid] = { h: String(m.score.ft[0]), a: String(m.score.ft[1]) };
      stats.groupMatches++;
    } else if (m.round !== undefined) {
      const rawRound = m.round;
      if (typeof rawRound === 'string') stats.roundFormats.string++;
      else if (typeof rawRound === 'object') stats.roundFormats.object++;
      if (stats.roundFormats.string > 0 && stats.roundFormats.object > 0) stats.roundFormats.mixed = true;
      const rname = parseRoundName(rawRound);
      const phase = ROUND_MAP[rname] || ROUND_MAP[rname.replace(/\s+/g,' ')];
      if (!phase) {
        if (!stats.koPhasesMissing.includes(rname)) stats.koPhasesMissing.push(rname);
        continue;
      }
      if (!roundCtrs[phase]) roundCtrs[phase] = 0;
      const kid = `${phase}_${roundCtrs[phase]++}`;
      const t1 = TM[m.team1] || m.team1 || 'A definir';
      const t2 = TM[m.team2] || m.team2 || 'A definir';
      const tbd = n => !n || ['winner','runner','loser','tbd','a definir'].some(x => n.toLowerCase().includes(x));
      const ksc = m.score?.ft?.length === 2 ? { h: String(m.score.ft[0]), a: String(m.score.ft[1]) } : null;
      if (lockTime) lt[kid] = lockTime;
      if (ksc) results[kid] = ksc;
      koMatches.push({ id:kid, phase, date:m.date||null, lt:lockTime||null, t1, t2, score:ksc,
        known: !tbd(t1) && !tbd(t2) && Date.now() >= new Date('2026-06-27T00:00:00Z').getTime() });
      stats.koMatches++;
    }
  }

  const lockedMatches = Object.keys(lt).filter(mid => !mid.includes('_') && lt[mid] <= now);
  const koLockedMatches = Object.keys(lt).filter(mid => mid.includes('_') && lt[mid] <= now);
  const groupLockTimes = {};
  GK.forEach(g => {
    const gTimes = [0,1,2,3,4,5].map(i => lt[g+i]).filter(Boolean);
    if (gTimes.length > 0) groupLockTimes[g] = admin.firestore.Timestamp.fromMillis(Math.min(...gTimes));
  });
  const allGroupTimes = Object.values(groupLockTimes);
  const firstMatchTime = allGroupTimes.length > 0 ? allGroupTimes.reduce((a,b) => a.toMillis()<b.toMillis()?a:b) : null;

  const warnings = validateData(data, stats);
  const status = warnings.length === 0 ? 'ok' : 'warning';
  const wcData = {
    lt, results, lockedMatches, koLockedMatches, groupLockTimes, koMatches,
    lastSync: admin.firestore.FieldValue.serverTimestamp(),
    syncStatus: status, syncError: null,
    syncMessage: warnings.length > 0 ? warnings.join(' | ') : null,
    syncStats: { groupMatches:stats.groupMatches, koMatches:stats.koMatches,
      lockedCount:lockedMatches.length, koLockedCount:koLockedMatches.length, warnings }
  };
  if (firstMatchTime) wcData.firstMatchTime = firstMatchTime;
  await db.doc('config/wc').set(wcData, { merge: true });

  console.log(`  ✓ Status: ${status}`);
  console.log(`  ✓ Grupos: ${stats.groupMatches}/72 | KO: ${stats.koMatches}`);
  console.log(`  ✓ Travados: ${lockedMatches.length} grupo | ${koLockedMatches.length} KO`);
  console.log(`  ✓ Resultados: ${Object.keys(results).length}`);
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);

  const wcSnap = await db.doc('config/wc').get();
  const bonusResults = (wcSnap.exists && wcSnap.data().bonusResults) ? wcSnap.data().bonusResults : {};
  await syncRanking(results, koMatches, bonusResults);
}

// ── Pontuação ─────────────────────────────────────────────────────────────
const PH_SCORE = {
  group:{r:1,e:3}, r32:{r:2,e:6}, r16:{r:4,e:12},
  qf:{r:8,e:24}, sf:{r:16,e:48}, tp:{r:16,e:48}, final:{r:32,e:96}
};
const BF_PTS = { champion:10, runnerup:6, scorer:5 };
const ALL_MIDS = [];
GK.forEach(g => { getMx(GD[g]).forEach((_, i) => ALL_MIDS.push(g + i)); });

function scoreMR(p, r, phase) {
  if (!p || !r || p.h === '' || r.h === '' || p.h == null || r.h == null) return -1;
  const ph=parseInt(p.h), pa=parseInt(p.a), rh=parseInt(r.h), ra=parseInt(r.a);
  if (isNaN(ph)||isNaN(pa)||isNaN(rh)||isNaN(ra)) return -1;
  const phObj = PH_SCORE[phase] || PH_SCORE.group;
  if (ph===rh && pa===ra) return phObj.e;
  const pr = ph>pa?'H':ph<pa?'A':'D';
  const rr = rh>ra?'H':rh<ra?'A':'D';
  return pr===rr ? phObj.r : 0;
}

function calcRankScore(pred, results, koMatches, bonusRes) {
  if (!pred) return {pts:0, exact:0, res:0, filled:0};
  let pts=0, exact=0, res=0, filled=0;
  ALL_MIDS.forEach(id => {
    const p = pred.matches?.[id];
    if (p && p.h !== '' && p.h != null) filled++;
    const sc = scoreMR(p, results?.[id], 'group');
    if (sc === PH_SCORE.group.e) { pts+=sc; exact++; }
    else if (sc > 0) { pts+=sc; res++; }
  });
  (koMatches||[]).forEach(m => {
    if (!m.score || !pred.ko?.[m.id]) return;
    const sc = scoreMR(pred.ko[m.id], m.score, m.phase);
    const phObj = PH_SCORE[m.phase] || PH_SCORE.group;
    if (sc === phObj.e) { pts+=sc; exact++; }
    else if (sc > 0) { pts+=sc; res++; }
  });
  Object.entries(BF_PTS).forEach(([k, p]) => {
    if (pred.bonus?.[k] && bonusRes?.[k])
      if (pred.bonus[k].toLowerCase() === bonusRes[k].toLowerCase()) pts += p;
  });
  return {pts, exact, res, filled};
}

async function syncRanking(results, koMatches, bonusRes) {
  console.log('  Calculando ranking...');
  const [usersSnap, predsSnap, paymentsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('predictions').get(),
    db.collection('payments').get()   // ← lê pagamentos
  ]);

  const users = {}, preds = {}, payments = {};
  usersSnap.forEach(d => { users[d.id] = d.data(); });
  predsSnap.forEach(d => { preds[d.id] = d.data(); });
  paymentsSnap.forEach(d => { payments[d.id] = d.data(); });

  const sortFn = (a,b) => b.pts-a.pts || b.exact-a.exact || b.res-a.res;

  // Agrupar por groupId
  const groupEntries = {};
  const allEntries = [];
  const allEntriesIncludingUnpaid = []; // para o admin ver todos

  Object.keys(users).forEach(uid => {
    const gid = users[uid].groupId || 'bolao-inicial';
    const pay = payments[uid];
    const isPaid = pay && pay.status === 'approved';

    const sc = calcRankScore(preds[uid], results, koMatches, bonusRes);
    const entry = { uid, name: users[uid].displayName||'Sem nome',
                    pts:sc.pts, exact:sc.exact, res:sc.res, filled:sc.filled,
                    paid: isPaid===true };

    allEntriesIncludingUnpaid.push(entry);

    // Só entra no ranking público se pagou
    if (isPaid) {
      if (!groupEntries[gid]) groupEntries[gid] = [];
      groupEntries[gid].push(entry);
      allEntries.push(entry);
    }
  });

  Object.keys(groupEntries).forEach(gid => groupEntries[gid].sort(sortFn));
  allEntries.sort(sortFn);
  allEntriesIncludingUnpaid.sort(sortFn);

  const groups = {};
  Object.keys(groupEntries).forEach(gid => {
    groups[gid] = { entries: groupEntries[gid], totalUsers: groupEntries[gid].length };
  });

  // Estatísticas de pagamento
  const totalUsers = Object.keys(users).length;
  const totalPaid = allEntries.length;

  await db.doc('config/ranking').set({
    entries: allEntries,              // ranking público (só pagos)
    entriesAll: allEntriesIncludingUnpaid, // admin vê todos
    groups,
    totalUsers, totalPaid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    calculatedAt: new Date().toISOString()
  });

  const top = allEntries[0];
  console.log(`  ✓ Ranking: ${totalPaid} pagos / ${totalUsers} total`);
  console.log(`  ✓ 1º lugar: ${top?.name||'—'} (${top?.pts||0}pts)`);
  Object.keys(groups).forEach(gid => {
    const g = groups[gid];
    console.log(`    └ ${gid}: ${g.totalUsers} pagos · 1º ${g.entries[0]?.name||'—'} (${g.entries[0]?.pts||0}pts)`);
  });
}

syncLocks()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO CRÍTICO:', e.message); process.exit(1); });
