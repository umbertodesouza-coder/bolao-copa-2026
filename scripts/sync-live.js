/**
 * Bolão Copa 2026 — Sincronizador Ao Vivo + Histórico
 * GitHub Actions — roda a cada 5 minutos
 * - config/live: jogos de hoje (+ ontem se ainda relevantes)
 * - config/liveHistory: todos os jogos encerrados desde 11/jun (cache incremental)
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

const BRT_OFFSET = -3 * 60 * 60 * 1000;

const ESPN_TM = {
  'Mexico':'México','South Korea':'Coreia do Sul','Czech Republic':'Rep. Tcheca',
  'South Africa':'África do Sul','Canada':'Canadá','Switzerland':'Suíça',
  'Qatar':'Catar','Bosnia-Herzegovina':'Bósnia','Brazil':'Brasil',
  'Morocco':'Marrocos','Scotland':'Escócia','Haiti':'Haiti',
  'United States':'EUA','Paraguay':'Paraguai','Turkey':'Turquia',
  'Australia':'Austrália','Germany':'Alemanha','Ecuador':'Equador',
  'Ivory Coast':'Costa do Marfim','Curaçao':'Curaçao','Netherlands':'Holanda',
  'Japan':'Japão','Sweden':'Suécia','Tunisia':'Tunísia','Belgium':'Bélgica',
  'Iran':'Irã','Egypt':'Egito','New Zealand':'Nova Zelândia','Spain':'Espanha',
  'Uruguay':'Uruguai','Saudi Arabia':'Arábia Saudita','Cape Verde':'Cabo Verde',
  'France':'França','Senegal':'Senegal','Norway':'Noruega','Iraq':'Iraque',
  'Argentina':'Argentina','Austria':'Áustria','Algeria':'Argélia',
  'Jordan':'Jordânia','Portugal':'Portugal','Colombia':'Colômbia',
  'Uzbekistan':'Uzbequistão','DR Congo':'RD Congo','England':'Inglaterra',
  'Croatia':'Croácia','Ghana':'Gana','Panama':'Panamá',
  'Korea Republic':'Coreia do Sul','Czechia':'Rep. Tcheca',
  'Turkiye':'Turquia','Türkiye':'Turquia','Congo DR':'RD Congo','USA':'EUA'
};

function teamName(n) { return ESPN_TM[n] || n; }

function dateBRT(isoDate) {
  return new Date(new Date(isoDate).getTime() + BRT_OFFSET).toISOString().slice(0,10).replace(/-/g,'');
}

function formatMatchTime(dateStr) {
  if (!dateStr) return 'A confirmar';
  const d = new Date(dateStr);
  const local = new Date(d.getTime() + BRT_OFFSET);
  const day   = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const mins  = String(local.getUTCMinutes()).padStart(2, '0');

  const now   = new Date();
  const today = new Date(now.getTime() + BRT_OFFSET);
  const isToday = local.getUTCDate()  === today.getUTCDate() &&
                  local.getUTCMonth() === today.getUTCMonth() &&
                  local.getUTCFullYear() === today.getUTCFullYear();

  const timeStr = `${hours}h${mins}`;
  return isToday ? `⏰ Hoje · ${timeStr}` : `📅 ${day}/${month} · ${timeStr}`;
}

function statusLabel(state, detail, clock, matchDate, period) {
  if (state === 'in') {
    const d = (detail || '').toLowerCase();
    if (d === 'halftime' || d === 'half time' || d === 'ht' || d === 'half') return '⏸ Intervalo';
    if (d.includes('end of extra') || d.includes('extra time half')) return '⏸ Int. Prorrogação';
    if (d.includes('penalty') || d.includes('penalties') || d.includes('shootout') || d.includes('pso')) return '⚽ Pênaltis';
    if (period >= 3 || d.includes('extra') || d.includes('overtime')) return '⏱ Prorrogação ' + (clock || '').trim();
    const t = period === 2 ? '2T' : '1T';
    return '🔴 ' + t + ' ' + (clock || '').trim();
  }
  if (state === 'post') return '✅ Encerrado';
  return formatMatchTime(matchDate);
}

// ── Constrói o "card" de um jogo a partir do evento ESPN ───────────────────
function buildGameCard(ev, comp) {
  const status = comp.status;
  const state  = status?.type?.state || 'pre';
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeName  = teamName(home.team?.displayName || home.team?.name || '');
  const awayName  = teamName(away.team?.displayName || away.team?.name || '');
  const homeScore = home.score !== undefined ? String(home.score) : '-';
  const awayScore = away.score !== undefined ? String(away.score) : '-';

  const homeId = home.team?.id || '';
  const awayId = away.team?.id || '';

  const details = comp.details || [];
  const goals = details
    .filter(d => {
      const t = (d.type?.text || '').toLowerCase();
      if (t.includes('shootout')) return false;
      return d.scoringPlay === true || t.includes('goal');
    })
    .map(d => {
      const typeText = (d.type?.text || '').toLowerCase();
      const isOwnGoal = typeText.includes('own goal');

      let teamStr = teamName(d.team?.displayName || d.team?.name || '');
      if (!teamStr && d.team?.id) {
        if (String(d.team.id) === String(homeId)) teamStr = homeName;
        else if (String(d.team.id) === String(awayId)) teamStr = awayName;
      }
      let player = d.athletesInvolved?.[0]?.displayName
                 || d.athletesInvolved?.[0]?.shortName
                 || '';
      if (!player && d.text) {
        const m = d.text.match(/(?:Goal!?\s*[^.]*\.\s*)([A-Z][\wÀ-ÿ'\-]+(?:\s[A-Z][\wÀ-ÿ'\-]+)*)/);
        if (m && m[1]) player = m[1].trim();
      }
      return {
        team:   teamStr,
        player,
        clock:  d.clock?.displayValue || '',
        ownGoal: isOwnGoal
      };
    });

  // ── Cobranças de pênalti (disputa por shootout) ─────────────────────────────
  // Captura cada cobrança individualmente (autor + se converteu), funcionando
  // TANTO durante o jogo ao vivo (state='in', disputa em andamento) QUANTO
  // depois de encerrado (state='post'). Nunca conta para o placar/artilharia
  // — é só para exibição da disputa em tempo real.
  const shootoutDetails = details.filter(d => (d.type?.text || '').toLowerCase().includes('shootout'));
  const shootoutKicks = shootoutDetails.map(d => {
    let teamStr = teamName(d.team?.displayName || d.team?.name || '');
    if (!teamStr && d.team?.id) {
      if (String(d.team.id) === String(homeId)) teamStr = homeName;
      else if (String(d.team.id) === String(awayId)) teamStr = awayName;
    }
    let player = d.athletesInvolved?.[0]?.displayName
               || d.athletesInvolved?.[0]?.shortName
               || '';
    // Heurística: scoringPlay=true indica cobrança convertida
    const scored = d.scoringPlay === true;
    return { team: teamStr, player, scored };
  });
  let penH = 0, penA = 0;
  shootoutKicks.forEach(k => {
    if (k.scored) {
      if (k.team === homeName) penH++;
      else if (k.team === awayName) penA++;
    }
  });

  const shortDetail = comp.status?.type?.shortDetail || '';
  const inShootout = state === 'in' && (shootoutDetails.length > 0 || /penalt|shootout|pso/i.test(shortDetail));
  const wentToPenalties = state === 'post' && (
    shootoutDetails.length > 0 ||
    /pen|pso|shoot/i.test(shortDetail)
  );

  return {
    id: ev.id,
    home: homeName,
    away: awayName,
    homeScore,
    awayScore,
    state,
    period:      comp.status?.period || 1,
    clock:       status?.displayClock || '',
    statusLabel: wentToPenalties
      ? '✅ Encerrado (pên.)'
      : statusLabel(state, status?.type?.shortDetail, status?.displayClock, ev.date, comp.status?.period || 1),
    isLive:      state === 'in',
    isFinished:  state === 'post',
    penalties:   wentToPenalties,
    inShootout:  inShootout,
    shootoutKicks: shootoutKicks.length ? shootoutKicks : null,
    penScore:    shootoutKicks.length ? { h: penH, a: penA } : null,
    date:        ev.date,
    goals
  };
}

async function fetchEspnDay(dateStr) {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=${dateStr}`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} (${dateStr})`);
  const data = await res.json();
  return data.events || [];
}

async function syncLive() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Sincronizando dados ao vivo...`);

  const nowBRT   = new Date(Date.now() + BRT_OFFSET);
  const todayBRT = nowBRT.toISOString().slice(0,10).replace(/-/g,'');
  const yestBRT  = new Date(nowBRT.getTime() - 24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');

  let events = [];
  try {
    for (const dateStr of [yestBRT, todayBRT]) {
      const evs = await fetchEspnDay(dateStr);
      events.push(...evs);
    }
  } catch (e) {
    console.error('Erro ESPN:', e.message);
    await db.doc('config/live').set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: e.message,
      games: []
    }, { merge: true });
    return;
  }

  const seenIds = new Set();
  events = events.filter(ev => {
    if (seenIds.has(ev.id)) return false;
    seenIds.add(ev.id);
    return true;
  });

  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const eventsForToday = events.filter(ev => {
    const comp  = ev.competitions?.[0];
    const state = comp?.status?.type?.state || 'pre';
    const evDate = dateBRT(ev.date);

    if (evDate === todayBRT) return true;
    if (state === 'in') return true;
    if (state === 'post') {
      const elapsed = Date.now() - new Date(ev.date).getTime();
      return elapsed < TWO_HOURS + (3*60*60*1000);
    }
    return false;
  });

  const games = eventsForToday
    .map(ev => { const comp = ev.competitions?.[0]; return comp ? buildGameCard(ev, comp) : null; })
    .filter(Boolean);

  games.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(a.date) - new Date(b.date);
  });

  const hasLive  = games.some(g => g.isLive);
  const hasGames = games.length > 0;

  await db.doc('config/live').set({
    games, hasLive, hasGames,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    error: null
  });

  console.log(`  ✓ ${games.length} jogo(s) hoje | ${games.filter(g=>g.isLive).length} ao vivo`);

  try {
    const historyRef  = db.doc('config/liveHistory');
    const historySnap = await historyRef.get();
    const history = historySnap.exists ? historySnap.data() : {};
    history.days = history.days || {};

    function mergeIntoHistory(ds, cards) {
      if (!cards.length) return;
      const existing = history.days[ds] || [];
      const byId = {};
      existing.forEach(g => { byId[g.id] = g; });
      cards.forEach(g => { byId[g.id] = g; });
      history.days[ds] = Object.values(byId).sort((a,b) => new Date(a.date) - new Date(b.date));
    }

    const startDate   = new Date('2026-06-11T00:00:00Z');
    const yestDateObj = new Date(`${yestBRT.slice(0,4)}-${yestBRT.slice(4,6)}-${yestBRT.slice(6,8)}T00:00:00Z`);

    let backfilled = 0;
    for (let d = new Date(startDate); d <= yestDateObj; d.setDate(d.getDate()+1)) {
      const ds = d.toISOString().slice(0,10).replace(/-/g,'');
      if (history.days[ds]) continue;
      try {
        const evs = await fetchEspnDay(ds);
        const cards = evs
          .map(ev => { const comp = ev.competitions?.[0]; return comp ? buildGameCard(ev, comp) : null; })
          .filter(g => g && g.isFinished);
        history.days[ds] = cards;
        backfilled++;
      } catch (e) {
        console.warn(`  Histórico ${ds}: erro ${e.message}`);
      }
    }

    const finishedToday = games.filter(g => g.isFinished && dateBRT(g.date) === todayBRT);
    const finishedYest  = games.filter(g => g.isFinished && dateBRT(g.date) === yestBRT);
    mergeIntoHistory(todayBRT, finishedToday);
    mergeIntoHistory(yestBRT,  finishedYest);

    history.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await historyRef.set(history);

    const totalDays  = Object.keys(history.days).length;
    const totalGames = Object.values(history.days).reduce((s, arr) => s + (arr?.length||0), 0);
    console.log(`  ✓ Histórico: ${totalDays} dia(s) (+${backfilled} novo(s)) · ${totalGames} jogo(s) encerrado(s) no total`);
  } catch (e) {
    console.warn('  Aviso — histórico não atualizado:', e.message);
  }

  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncLive()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
