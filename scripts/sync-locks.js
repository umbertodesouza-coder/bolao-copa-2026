/**
 * Bolão Copa 2026 — Sincronizador de Travamentos e Ranking
 * GitHub Actions — roda a cada 5 minutos
 * Usa ESPN API (mesma fonte do Ao Vivo) — resultados em tempo real
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

// ── Mapeamento ESPN → nomes do bolão (com acentos, igual ao FLAGS do index.html) ──
const ESPN_TM = {
  'Mexico':'México','South Korea':'Coreia do Sul','Czech Republic':'Rep. Tcheca',
  'Czechia':'Rep. Tcheca','South Africa':'África do Sul','Canada':'Canadá',
  'Switzerland':'Suíça','Qatar':'Catar','Bosnia-Herzegovina':'Bósnia',
  'Bosnia and Herzegovina':'Bósnia','Bosnia & Herzegovina':'Bósnia',
  'Brazil':'Brasil','Morocco':'Marrocos','Scotland':'Escócia','Haiti':'Haiti',
  'United States':'EUA','USA':'EUA','Paraguay':'Paraguai','Turkey':'Turquia',
  'Turkiye':'Turquia','Türkiye':'Turquia','Australia':'Austrália','Germany':'Alemanha',
  'Ecuador':'Equador','Ivory Coast':'Costa do Marfim','Curaçao':'Curaçao','Curacao':'Curaçao',
  'Netherlands':'Holanda','Japan':'Japão','Sweden':'Suécia','Tunisia':'Tunísia',
  'Belgium':'Bélgica','Iran':'Irã','Egypt':'Egito','New Zealand':'Nova Zelândia',
  'Spain':'Espanha','Uruguay':'Uruguai','Saudi Arabia':'Arábia Saudita',
  'Cape Verde':'Cabo Verde','France':'França','Senegal':'Senegal',
  'Norway':'Noruega','Iraq':'Iraque','Argentina':'Argentina','Austria':'Áustria',
  'Algeria':'Argélia','Jordan':'Jordânia','Portugal':'Portugal',
  'Colombia':'Colômbia','Uzbekistan':'Uzbequistão','DR Congo':'RD Congo','Congo DR':'RD Congo',
  'England':'Inglaterra','Croatia':'Croácia','Ghana':'Gana','Panama':'Panamá',
  'Korea Republic':'Coreia do Sul'
};

function teamName(n) { return ESPN_TM[n] || n; }

// ── Estrutura dos grupos (com acentos, igual ao FLAGS do index.html) ──────────
const GD = {
  A:['México','Coreia do Sul','Rep. Tcheca','África do Sul'],
  B:['Canadá','Suíça','Catar','Bósnia'],
  C:['Brasil','Marrocos','Escócia','Haiti'],
  D:['EUA','Paraguai','Turquia','Austrália'],
  E:['Alemanha','Equador','Costa do Marfim','Curaçao'],
  F:['Holanda','Japão','Suécia','Tunísia'],
  G:['Bélgica','Irã','Egito','Nova Zelândia'],
  H:['Espanha','Uruguai','Arábia Saudita','Cabo Verde'],
  I:['França','Senegal','Noruega','Iraque'],
  J:['Argentina','Áustria','Argélia','Jordânia'],
  K:['Portugal','Colômbia','Uzbequistão','RD Congo'],
  L:['Inglaterra','Croácia','Gana','Panamá']
};
const GK = Object.keys(GD);

const ROUND_MAP = {
  'Round of 32':'r32','Last 32':'r32',
  'Round of 16':'r16','Last 16':'r16','Round of Sixteen':'r16',
  'Quarter-finals':'qf','Quarter-final':'qf','Quarterfinals':'qf','Quarter-Finals':'qf',
  'Semi-finals':'sf','Semi-final':'sf','Semifinals':'sf','Semi-Finals':'sf',
  'Third-place match':'tp','Third Place':'tp','Third place':'tp','Third-Place':'tp',
  'Bronze Final':'tp','3rd Place':'tp','Play-off for third place':'tp',
  'Final':'final','The Final':'final'
};

// ── Traduz placeholders ESPN (inglês) para português ─────────────────────────
function translatePlaceholder(name) {
  if (!name) return name;
  // "Third Place Group A/B/C/D/F" → "3º Lugar Grupo A/B/C/D/F"
  name = name.replace(/Third Place Group\s+/i, '3º Lugar Grupo ');
  // "Group A Winner" → "1º Grupo A"
  name = name.replace(/Group ([A-Z])\s+Winner/i, '1º Grupo $1');
  // "Group A 2nd Place" → "2º Grupo A"
  name = name.replace(/Group ([A-Z])\s+2nd Place/i, '2º Grupo $1');
  // "Round of 32 N Winner" → "Venc. 16-avos #N"
  name = name.replace(/Round of 32 (\d+) Winner/i, 'Venc. 16-avos #$1');
  // "Round of 16 N Winner" → "Venc. Oitavas #N"
  name = name.replace(/Round of 16 (\d+) Winner/i, 'Venc. Oitavas #$1');
  // "Quarterfinal N Winner" → "Venc. Quartas #N"
  name = name.replace(/Quarterfinal (\d+) Winner/i, 'Venc. Quartas #$1');
  return name;
}

function getMx(ts) {
  const m = [];
  for (let i = 0; i < ts.length; i++)
    for (let j = i+1; j < ts.length; j++)
      m.push({h:ts[i], a:ts[j]});
  return m;
}

function findMid(t1, t2) {
  for (const g of GK) {
    const mx = getMx(GD[g]);
    for (let i = 0; i < mx.length; i++) {
      const m = mx[i];
      if ((m.h===t1&&m.a===t2)||(m.h===t2&&m.a===t1)) return g+i;
    }
  }
  return null;
}

const ALL_MIDS = [];
GK.forEach(g => { getMx(GD[g]).forEach((_, i) => ALL_MIDS.push(g+i)); });

// ── Buscar partidas ESPN ──────────────────────────────────────────────────────
async function fetchESPN(dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=${dateStr}&limit=100`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

async function fetchAllMatches() {
  const start = new Date('2026-06-11');
  const end   = new Date('2026-07-20');
  const today = new Date();
  const future = new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000);
  const until = end < future ? end : future;

  const allEvents = [];
  for (let d = new Date(start); d <= until; d.setDate(d.getDate()+1)) {
    const ds = d.toISOString().slice(0,10).replace(/-/g,'');
    try {
      const evs = await fetchESPN(ds);
      allEvents.push(...evs);
    } catch(e) {
      console.warn(`  ESPN erro em ${ds}: ${e.message}`);
    }
  }
  return allEvents;
}

// ── Pontuação ─────────────────────────────────────────────────────────────────
const PH_SCORE = {
  group:{r:1,e:3}, r32:{r:2,e:6}, r16:{r:4,e:12},
  qf:{r:8,e:24}, sf:{r:16,e:48}, tp:{r:16,e:48}, final:{r:32,e:96}
};
const BF_PTS = { champion:10, runnerup:6, scorer:5 };

function scoreM(p, r, phase) {
  if (!p||!r||p.h===''||r.h===''||p.h==null||r.h==null) return -1;
  const ph=parseInt(p.h),pa=parseInt(p.a),rh=parseInt(r.h),ra=parseInt(r.a);
  if (isNaN(ph)||isNaN(pa)||isNaN(rh)||isNaN(ra)) return -1;
  const phObj = PH_SCORE[phase]||PH_SCORE.group;
  if (ph===rh&&pa===ra) return phObj.e;
  const pr=ph>pa?'H':ph<pa?'A':'D';
  const rr=rh>ra?'H':rh<ra?'A':'D';
  return pr===rr?phObj.r:0;
}

function calcRankScore(pred, results, koMatches, bonusRes) {
  if (!pred) return {pts:0,exact:0,res:0,filled:0};
  let pts=0,exact=0,res=0,filled=0;
  ALL_MIDS.forEach(id => {
    const p=pred.matches?.[id];
    if (p&&p.h!==''&&p.h!=null) filled++;
    const sc=scoreM(p,results?.[id],'group');
    if (sc===PH_SCORE.group.e){pts+=sc;exact++;}
    else if (sc>0){pts+=sc;res++;}
  });
  (koMatches||[]).forEach(m => {
    if (!m.score||!pred.ko?.[m.id]) return;
    const sc=scoreM(pred.ko[m.id],m.score,m.phase);
    const phObj=PH_SCORE[m.phase]||PH_SCORE.group;
    if (sc===phObj.e){pts+=sc;exact++;}
    else if (sc>0){pts+=sc;res++;}
  });
  Object.entries(BF_PTS).forEach(([k,p])=>{
    if (pred.bonus?.[k]&&bonusRes?.[k])
      if (pred.bonus[k].toLowerCase()===bonusRes[k].toLowerCase()) pts+=p;
  });
  return {pts,exact,res,filled};
}

async function syncRanking(results, koMatches, bonusRes) {
  console.log('  Calculando ranking...');
  const [usersSnap,predsSnap,paymentsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('predictions').get(),
    db.collection('payments').get()
  ]);
  const users={},preds={},payments={};
  usersSnap.forEach(d=>{users[d.id]=d.data();});
  predsSnap.forEach(d=>{preds[d.id]=d.data();});
  paymentsSnap.forEach(d=>{payments[d.id]=d.data();});

  const sortFn=(a,b)=>b.pts-a.pts||b.exact-a.exact||b.res-a.res;
  const groupEntries={},allEntries=[],allEntriesIncludingUnpaid=[];

  Object.keys(users).forEach(uid=>{
    const gid=users[uid].groupId||'bolao-inicial';
    const pay=payments[uid];
    const isPaid=pay&&pay.status==='approved';
    const sc=calcRankScore(preds[uid],results,koMatches,bonusRes);
    const entry={uid,name:users[uid].displayName||'Sem nome',
      pts:sc.pts,exact:sc.exact,res:sc.res,filled:sc.filled,paid:isPaid===true};
    allEntriesIncludingUnpaid.push(entry);
    if (isPaid){
      if (!groupEntries[gid]) groupEntries[gid]=[];
      groupEntries[gid].push(entry);
      allEntries.push(entry);
    }
  });

  Object.keys(groupEntries).forEach(gid=>groupEntries[gid].sort(sortFn));
  allEntries.sort(sortFn);
  allEntriesIncludingUnpaid.sort(sortFn);

  const groups={};
  Object.keys(groupEntries).forEach(gid=>{
    groups[gid]={entries:groupEntries[gid],totalUsers:groupEntries[gid].length,totalPaid:groupEntries[gid].length};
  });

  const totalUsers=Object.keys(users).length;
  const totalPaid=allEntries.length;

  await db.doc('config/ranking').set({
    entries:allEntries,entriesAll:allEntriesIncludingUnpaid,groups,
    totalUsers,totalPaid,
    updatedAt:admin.firestore.FieldValue.serverTimestamp(),
    calculatedAt:new Date().toISOString()
  });

  const top=allEntries[0];
  console.log(`  ✓ Ranking: ${totalPaid} pagos / ${totalUsers} total`);
  console.log(`  ✓ 1º lugar: ${top?.name||'—'} (${top?.pts||0}pts)`);
}

// ── Principal ─────────────────────────────────────────────────────────────────
async function syncLocks() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Iniciando sincronização via ESPN...`);

  let events;
  try {
    events = await fetchAllMatches();
  } catch(e) {
    console.error('Erro ao buscar ESPN:', e.message);
    await db.doc('config/wc').set({
      lastSync:admin.firestore.FieldValue.serverTimestamp(),
      syncStatus:'error', syncError:e.message
    },{merge:true});
    return;
  }

  const lt={}, results={}, koMatches=[];
  const roundCtrs={};
  let groupCount=0, koCount=0;

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const state  = comp.status?.type?.state || 'pre';
    const home   = comp.competitors?.find(c=>c.homeAway==='home');
    const away   = comp.competitors?.find(c=>c.homeAway==='away');
    if (!home||!away) continue;

    const t1     = teamName(home.team?.displayName||home.team?.name||'');
    const t2     = teamName(away.team?.displayName||away.team?.name||'');
    const lockTs = new Date(ev.date).getTime();
    const isPost = state==='post' || state==='in';
    const score  = (isPost&&home.score!=null) ? {h:String(home.score),a:String(away.score)} : null;

    // ── Fase de grupos ────────────────────────────────────────────────────────
    const mid = findMid(t1, t2);
    if (mid) {
      if (lockTs) lt[mid] = lockTs;
      if (score) {
        const gdGrp = mid.slice(0, mid.length - 1);
        const gdIdx = parseInt(mid.slice(mid.length - 1));
        const gdMatch = getMx(GD[gdGrp])[gdIdx];
        if (gdMatch && t1 !== gdMatch.h) {
          results[mid] = {h: score.a, a: score.h};
        } else {
          results[mid] = score;
        }
      }
      groupCount++;
      continue;
    }

    // Log de diagnóstico
    if (state === 'pre' || state === 'post' || state === 'in') {
      console.log(`  [DIAGNÓSTICO] Não mapeado: "${t1}" x "${t2}" (state=${state}, date=${ev.date?.slice(0,10)})`);
    }

    // ── Mata-mata ─────────────────────────────────────────────────────────────
    const noteText = comp.notes?.[0]?.text || comp.status?.type?.shortDetail || '';
    let phase = null;
    for (const [key, val] of Object.entries(ROUND_MAP)) {
      if (noteText.includes(key)) { phase = val; break; }
    }

    // Fallback 1: detectar fase pelos nomes dos times (ESPN usa placeholders)
    if (!phase) {
      const combined = (t1 + ' ' + t2).toLowerCase();
      if      (combined.includes('quarterfinal'))     phase = 'sf';
      else if (combined.includes('round of 16'))      phase = 'qf';
      else if (combined.includes('round of 32'))      phase = 'r16';
      else if (combined.includes('group') || combined.includes('place')) phase = 'r32';
    }

    // Fallback 2: detectar fase por data + contagem máxima por fase
    // R32=16 jogos, R16=8, QF=4, SF=2
    // Necessário porque o último jogo do R32 (22h30 BRT 03/jul = 01h30 UTC 04/jul)
    // e os primeiros do R16 (14h00 BRT 04/jul) aparecem todos como dia 04/jul no ESPN (UTC)
    if (!phase) {
      const md = ev.date?.slice(0, 10) || '';
      const r32Full = (roundCtrs['r32'] || 0) >= 16;
      const r16Full = (roundCtrs['r16'] || 0) >= 8;
      const qfFull  = (roundCtrs['qf']  || 0) >= 4;
      const sfFull  = (roundCtrs['sf']  || 0) >= 2;

      if      (md >= '2026-06-28' && md <= '2026-07-04') phase = r32Full ? 'r16' : 'r32';
      else if (md >= '2026-07-05' && md <= '2026-07-07') phase = r16Full ? 'qf'  : 'r16';
      else if (md >= '2026-07-09' && md <= '2026-07-12') phase = qfFull  ? 'sf'  : 'qf';
      else if (md >= '2026-07-14' && md <= '2026-07-15') phase = sfFull  ? 'tp'  : 'sf';
      else if (md === '2026-07-18')                       phase = 'tp';
      else if (md === '2026-07-19')                       phase = 'final';
    }

    if (!phase) continue;

    if (!roundCtrs[phase]) roundCtrs[phase] = 0;
    const kid = `${phase}_${roundCtrs[phase]++}`;

    // tbd verifica nomes ORIGINAIS (inglês ESPN) — antes de traduzir
    const tbd = n => !n||['winner','runner','loser','tbd','a definir','group ','place'].some(x=>n.toLowerCase().includes(x));

    // Traduz placeholders para português DEPOIS de verificar tbd
    const t1Pt = translatePlaceholder(t1);
    const t2Pt = translatePlaceholder(t2);

    if (lockTs) lt[kid] = lockTs;
    if (score)  results[kid] = score;
    koMatches.push({
      id:kid, phase, date:ev.date?.slice(0,10)||null, lt:lockTs||null,
      t1: t1Pt, t2: t2Pt, score,
      known: !tbd(t1) && !tbd(t2)  // usa nomes originais para tbd
    });
    koCount++;
  }

  const nowMs = Date.now();
  const lockedMatches   = Object.keys(lt).filter(id=>!id.includes('_')&&lt[id]<=nowMs);
  const koLockedMatches = Object.keys(lt).filter(id=>id.includes('_')&&lt[id]<=nowMs);

  const groupLockTimes = {};
  GK.forEach(g => {
    const times = [0,1,2,3,4,5].map(i=>lt[g+i]).filter(Boolean);
    if (times.length>0) groupLockTimes[g] = admin.firestore.Timestamp.fromMillis(Math.min(...times));
  });
  const allGroupTimes = Object.values(groupLockTimes);
  const firstMatchTime = allGroupTimes.length>0
    ? allGroupTimes.reduce((a,b)=>a.toMillis()<b.toMillis()?a:b) : null;

  const wcData = {
    lt, results, lockedMatches, koLockedMatches, groupLockTimes, koMatches,
    lastSync:admin.firestore.FieldValue.serverTimestamp(),
    syncStatus:'ok', syncError:null,
    syncSource:'espn',
    syncStats:{groupMatches:groupCount,koMatches:koCount,
      lockedCount:lockedMatches.length,koLockedCount:koLockedMatches.length}
  };
  if (firstMatchTime) wcData.firstMatchTime = firstMatchTime;
  await db.doc('config/wc').set(wcData, {merge:true});

  console.log(`  ✓ Grupos: ${groupCount}/72 | KO: ${koCount}`);
  console.log(`  ✓ Travados: ${lockedMatches.length} grupo | ${koLockedMatches.length} KO`);
  console.log(`  ✓ Resultados: ${Object.keys(results).length}`);
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);

  const wcSnap = await db.doc('config/wc').get();
  const bonusResults = wcSnap.exists ? (wcSnap.data().bonusResults||{}) : {};
  await syncRanking(results, koMatches, bonusResults);
}

syncLocks()
  .then(()=>process.exit(0))
  .catch(e=>{console.error('ERRO CRÍTICO:',e.message);process.exit(1);});
