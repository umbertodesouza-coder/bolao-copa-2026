/**
 * Bolão Copa 2026 — Sincronizador automático de travamentos
 * Roda via GitHub Actions a cada 5 minutos
 * Busca openfootball → calcula jogos iniciados → atualiza Firestore
 */

const admin = require('firebase-admin');

// ── Inicializar Firebase Admin ─────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

// ── Dados dos grupos ───────────────────────────────────────────────────────
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
  'Bosnia and Herzegovina':'Bosnia','Brazil':'Brasil','Morocco':'Marrocos',
  'Scotland':'Escocia','Haiti':'Haiti','USA':'EUA','United States':'EUA',
  'Paraguay':'Paraguai','Turkey':'Turquia','Australia':'Australia',
  'Germany':'Alemanha','Ecuador':'Equador','Ivory Coast':'Costa do Marfim',
  'Netherlands':'Holanda','Japan':'Japao','Sweden':'Suecia','Tunisia':'Tunisia',
  'Belgium':'Belgica','Iran':'Ira','Egypt':'Egito','New Zealand':'Nova Zelandia',
  'Spain':'Espanha','Uruguay':'Uruguai','Saudi Arabia':'Arabia Saudita',
  'Cape Verde':'Cabo Verde','France':'Franca','Senegal':'Senegal',
  'Norway':'Noruega','Iraq':'Iraque','Argentina':'Argentina','Austria':'Austria',
  'Algeria':'Algeria','Jordan':'Jordania','Portugal':'Portugal',
  'Colombia':'Colombia','Uzbekistan':'Uzbequistao','DR Congo':'RD Congo',
  'England':'Inglaterra','Croatia':'Croacia','Ghana':'Gana','Panama':'Panama',
  'Curacao':'Curacao','Curaçao':'Curacao','Türkiye':'Turquia',
  'Korea Republic':'Coreia do Sul'
};

const ROUND_MAP = {
  'Round of 32':'r32','Last 32':'r32','Round of 16':'r16','Last 16':'r16',
  'Quarter-finals':'qf','Quarterfinals':'qf','Semi-finals':'sf','Semifinals':'sf',
  'Third-place match':'tp','Third Place':'tp','Final':'final'
};

// ── Helpers ────────────────────────────────────────────────────────────────
function getMx(ts) {
  const m = [];
  for(let i=0;i<ts.length;i++)
    for(let j=i+1;j<ts.length;j++)
      m.push({h:ts[i],a:ts[j]});
  return m;
}

function findMid(t1r, t2r) {
  const t1 = TM[t1r]||t1r, t2 = TM[t2r]||t2r;
  for(const g of GK) {
    const mx = getMx(GD[g]);
    for(let i=0;i<mx.length;i++) {
      const m = mx[i];
      if((m.h===t1&&m.a===t2)||(m.h===t2&&m.a===t1)) return g+i;
    }
  }
  return null;
}

function parseMT(d, t) {
  if(!t) return null;
  const parts = t.split(' ');
  if(parts.length < 2) return null;
  const tp = parts[0].split(':');
  const off = parseInt(parts[1].replace('UTC',''));
  const utcH = parseInt(tp[0]) - off;
  const dt = new Date(d+'T00:00:00Z');
  dt.setUTCHours(utcH, parseInt(tp[1]||0), 0, 0);
  return dt.getTime();
}

// ── Sincronizador principal ────────────────────────────────────────────────
async function syncLocks() {
  const WC_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
  const now = Date.now();

  console.log(`[${new Date().toISOString()}] Sincronizando...`);

  // 1. Buscar dados do openfootball
  const res = await fetch(`${WC_URL}?t=${now}`);
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const lt = {};          // lock times (ms)
  const results = {};     // resultados
  const koMatches = [];   // partidas do mata-mata
  const roundCtrs = {};

  for(const m of (data.matches || [])) {
    const lockTime = parseMT(m.date, m.time);

    if(m.group) {
      // Fase de grupos
      const mid = findMid(m.team1, m.team2);
      if(!mid) { console.warn(`  Nao encontrado: ${m.team1} x ${m.team2}`); continue; }
      if(lockTime) lt[mid] = lockTime;
      if(m.score?.ft?.length === 2) {
        results[mid] = { h: String(m.score.ft[0]), a: String(m.score.ft[1]) };
      }
    } else {
      // Mata-mata
      const rname = (m.round?.name || '').trim();
      const phase = ROUND_MAP[rname];
      if(!phase) continue;
      if(!roundCtrs[phase]) roundCtrs[phase] = 0;
      const kid = `${phase}_${roundCtrs[phase]++}`;
      const t1 = TM[m.team1]||m.team1||'A definir';
      const t2 = TM[m.team2]||m.team2||'A definir';
      const tbd = n => !n||n.toLowerCase().includes('winner')||n.toLowerCase().includes('runner')||n==='A definir';
      if(lockTime) lt[kid] = lockTime;
      if(m.score?.ft?.length === 2) {
        results[kid] = { h: String(m.score.ft[0]), a: String(m.score.ft[1]) };
      }
      koMatches.push({ id:kid, phase, t1, t2, known:!tbd(t1)&&!tbd(t2) });
    }
  }

  // 2. Calcular jogos travados (tempo atual >= horário de início)
  const lockedMatches = Object.keys(lt).filter(mid =>
    !mid.includes('_') && lt[mid] <= now  // só fase de grupos
  );
  const koLockedMatches = Object.keys(lt).filter(mid =>
    mid.includes('_') && lt[mid] <= now   // só mata-mata
  );

  // 3. Calcular groupLockTimes (1o jogo de cada grupo) como Timestamps
  const groupLockTimes = {};
  GK.forEach(g => {
    const gTimes = [0,1,2,3,4,5].map(i => lt[g+i]).filter(Boolean);
    if(gTimes.length > 0)
      groupLockTimes[g] = admin.firestore.Timestamp.fromMillis(Math.min(...gTimes));
  });

  // 4. firstMatchTime = inicio do torneio (para travar bonus)
  const allGroupTimes = Object.values(groupLockTimes);
  const firstMatchTime = allGroupTimes.length > 0
    ? allGroupTimes.reduce((a,b) => (a.toMillis()<b.toMillis()?a:b))
    : null;

  // 5. Atualizar Firestore
  const wcData = {
    lt,
    results,
    lockedMatches,
    koLockedMatches,
    groupLockTimes,
    lastSync: admin.firestore.FieldValue.serverTimestamp()
  };
  if(firstMatchTime) wcData.firstMatchTime = firstMatchTime;

  await db.doc('config/wc').set(wcData, { merge: true });

  console.log(`  ✓ Grupos travados: ${lockedMatches.length}/72`);
  console.log(`  ✓ Mata-mata travados: ${koLockedMatches.length}`);
  console.log(`  ✓ Resultados: ${Object.keys(results).length}`);
  console.log(`  ✓ Grupos com horario: ${Object.keys(groupLockTimes).length}/12`);
  console.log(`  ✓ Sincronizado com sucesso`);
}

syncLocks()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
