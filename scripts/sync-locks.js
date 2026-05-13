/**
 * Bolão Copa 2026 — Sincronizador automático
 * GitHub Actions — roda a cada 5 minutos
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
  'Bosnia and Herzegovina':'Bosnia',
  'Bosnia & Herzegovina':'Bosnia',
  'Bosnia &amp; Herzegovina':'Bosnia',
  'Brazil':'Brasil','Morocco':'Marrocos',
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

// ── PONTO 1: Parsing robusto do round (aceita string ou objeto) ───────────
const ROUND_MAP = {
  // Round of 32
  'Round of 32':'r32','Last 32':'r32','Round of 32 ':'r32',
  // Round of 16
  'Round of 16':'r16','Last 16':'r16','Round of Sixteen':'r16',
  // Quarter-finals (todas as variações)
  'Quarter-finals':'qf','Quarter-final':'qf',
  'Quarterfinals':'qf','Quarterfinale':'qf',
  'Quarter-Finals':'qf','Quarter-Final':'qf',
  'Quartas de final':'qf','Quarterfinal':'qf',
  // Semi-finals
  'Semi-finals':'sf','Semi-final':'sf',
  'Semifinals':'sf','Semifinal':'sf',
  'Semi-Finals':'sf','Semi-Final':'sf',
  'Meias-finais':'sf',
  // Third place
  'Third-place match':'tp','Third place match':'tp',
  'Third Place':'tp','Third-Place':'tp',
  'Match for third place':'tp','Match for Third Place':'tp',
  'Bronze Final':'tp','3rd Place':'tp',
  'Play-off for third place':'tp','3rd place play-off':'tp',
  'Third place':'tp',
  // Final
  'Final':'final','The Final':'final'
};

function parseRoundName(round) {
  if (!round) return '';
  // Aceita string simples OU objeto {name, pos, key}
  if (typeof round === 'string') return round.trim();
  if (typeof round === 'object') {
    return (round.name || round.key || round.label || '').trim();
  }
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

// ── PONTO 3: Validação do JSON ────────────────────────────────────────────
function validateData(data, stats) {
  const warnings = [];
  if (!data || !data.matches) {
    warnings.push('JSON sem campo "matches"');
    return warnings;
  }
  if (data.matches.length === 0) {
    warnings.push('Campo "matches" está vazio');
    return warnings;
  }
  if (stats.groupMatches === 0) {
    warnings.push('Nenhum jogo de grupo encontrado — verifique o formato do JSON');
  }
  if (stats.groupMatches < 72 && stats.groupMatches > 0) {
    warnings.push(`Apenas ${stats.groupMatches}/72 jogos de grupo encontrados`);
  }
  if (stats.unknownTeams.length > 0) {
    warnings.push(`Times não reconhecidos: ${stats.unknownTeams.slice(0,5).join(', ')}`);
  }
  if (stats.roundFormats.mixed) {
    warnings.push(`Formato misto de rounds detectado (string + objeto)`);
  }
  if (stats.koMatches > 0 && stats.koPhasesMissing.length > 0) {
    warnings.push(`Fases KO sem mapeamento: ${stats.koPhasesMissing.join(', ')}`);
  }
  return warnings;
}

async function syncLocks() {
  const WC_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
  const now = Date.now();
  const syncStart = new Date().toISOString();

  console.log(`[${syncStart}] Iniciando sincronização...`);

  let data, fetchError = null;
  try {
    const res = await fetch(`${WC_URL}?t=${now}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (e) {
    fetchError = e.message;
    console.error('Erro ao buscar dados:', fetchError);
    await db.doc('config/wc').set({
      lastSync: admin.firestore.FieldValue.serverTimestamp(),
      syncStatus: 'error',
      syncError: fetchError,
      syncMessage: `Falha ao buscar openfootball: ${fetchError}`
    }, { merge: true });
    return;
  }

  const lt = {}, results = {}, koMatches = [];
  const roundCtrs = {};
  const stats = {
    groupMatches: 0, koMatches: 0,
    unknownTeams: [], roundFormats: {string:0, object:0, mixed:false},
    koPhasesMissing: []
  };

  for (const m of (data.matches || [])) {
    const lockTime = parseMT(m.date, m.time);

    if (m.group) {
      // ── Fase de grupos ────────────────────────────────────────────────
      const mid = findMid(m.team1, m.team2);
      if (!mid) {
        if (!stats.unknownTeams.includes(m.team1)) stats.unknownTeams.push(m.team1);
        if (!stats.unknownTeams.includes(m.team2)) stats.unknownTeams.push(m.team2);
        continue;
      }
      if (lockTime) lt[mid] = lockTime;
      if (m.score?.ft?.length === 2)
        results[mid] = { h: String(m.score.ft[0]), a: String(m.score.ft[1]) };
      stats.groupMatches++;

    } else if (m.round !== undefined) {
      // ── Mata-mata — PONTO 1: aceita round como string ou objeto ───────
      const rawRound = m.round;
      if (typeof rawRound === 'string') stats.roundFormats.string++;
      else if (typeof rawRound === 'object') stats.roundFormats.object++;
      if (stats.roundFormats.string > 0 && stats.roundFormats.object > 0)
        stats.roundFormats.mixed = true;

      const rname = parseRoundName(rawRound);
      const phase = ROUND_MAP[rname] || ROUND_MAP[rname.replace(/\s+/g,' ')];

      if (!phase) {
        if (!stats.koPhasesMissing.includes(rname)) stats.koPhasesMissing.push(rname);
        console.warn(`  Round não mapeado: "${rname}"`);
        continue;
      }
      if (!roundCtrs[phase]) roundCtrs[phase] = 0;
      const kid = `${phase}_${roundCtrs[phase]++}`;
      const t1 = TM[m.team1] || m.team1 || 'A definir';
      const t2 = TM[m.team2] || m.team2 || 'A definir';
      const tbd = n => !n || ['winner','runner','loser','tbd','a definir']
        .some(x => n.toLowerCase().includes(x));
      if (lockTime) lt[kid] = lockTime;
      if (m.score?.ft?.length === 2)
        results[kid] = { h: String(m.score.ft[0]), a: String(m.score.ft[1]) };
      koMatches.push({ id:kid, phase, t1, t2, known:!tbd(t1)&&!tbd(t2) });
      stats.koMatches++;
    }
  }

  // ── Calcular lockedMatches ────────────────────────────────────────────
  const lockedMatches = Object.keys(lt).filter(mid => !mid.includes('_') && lt[mid] <= now);
  const koLockedMatches = Object.keys(lt).filter(mid => mid.includes('_') && lt[mid] <= now);

  // ── Calcular groupLockTimes por grupo ─────────────────────────────────
  const groupLockTimes = {};
  GK.forEach(g => {
    const gTimes = [0,1,2,3,4,5].map(i => lt[g+i]).filter(Boolean);
    if (gTimes.length > 0)
      groupLockTimes[g] = admin.firestore.Timestamp.fromMillis(Math.min(...gTimes));
  });

  const allGroupTimes = Object.values(groupLockTimes);
  const firstMatchTime = allGroupTimes.length > 0
    ? allGroupTimes.reduce((a,b) => a.toMillis()<b.toMillis()?a:b) : null;

  // ── PONTO 3: Validar e gravar status ─────────────────────────────────
  const warnings = validateData(data, stats);
  const status = warnings.length === 0 ? 'ok' : 'warning';

  const wcData = {
    lt, results, lockedMatches, koLockedMatches, groupLockTimes,
    lastSync: admin.firestore.FieldValue.serverTimestamp(),
    syncStatus: status,
    syncError: null,
    syncMessage: warnings.length > 0 ? warnings.join(' | ') : null,
    syncStats: {
      groupMatches: stats.groupMatches,
      koMatches: stats.koMatches,
      lockedCount: lockedMatches.length,
      koLockedCount: koLockedMatches.length,
      warnings: warnings
    }
  };
  if (firstMatchTime) wcData.firstMatchTime = firstMatchTime;

  await db.doc('config/wc').set(wcData, { merge: true });

  console.log(`  ✓ Status: ${status}`);
  if (warnings.length > 0) warnings.forEach(w => console.warn(`  ⚠ ${w}`));
  console.log(`  ✓ Grupos: ${stats.groupMatches}/72 | KO: ${stats.koMatches}`);
  console.log(`  ✓ Travados: ${lockedMatches.length} grupo | ${koLockedMatches.length} KO`);
  console.log(`  ✓ Resultados: ${Object.keys(results).length}`);
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncLocks()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERRO CRÍTICO:', e.message);
    process.exit(1);
  });
