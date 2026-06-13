/**
 * Bolão Copa 2026 — Sincronizador Ao Vivo
 * GitHub Actions — roda a cada 5 minutos
 * Busca placar em tempo real da ESPN e grava no Firestore /config/live
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

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
  'Turkiye':'Turquia','USA':'EUA'
};

function teamName(n) { return ESPN_TM[n] || n; }

// Formata horário do jogo em horário de Brasília (UTC-3)
function formatMatchTime(dateStr) {
  if (!dateStr) return 'A confirmar';
  const d = new Date(dateStr);
  const BRT_OFFSET = -3 * 60 * 60 * 1000;
  const local = new Date(d.getTime() + BRT_OFFSET);
  const day   = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const mins  = String(local.getUTCMinutes()).padStart(2, '0');

  // Verificar se é hoje (também em BRT)
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
    // Intervalo normal
    if (d === 'halftime' || d === 'half time' || d === 'ht' || d === 'half') return '⏸ Intervalo';
    // Intervalo prorrogação
    if (d.includes('end of extra') || d.includes('extra time half')) return '⏸ Int. Prorrogação';
    // Pênaltis
    if (d.includes('penalty') || d.includes('penalties') || d.includes('shootout') || d.includes('pso')) return '⚽ Pênaltis';
    // Prorrogação (period >= 3 ou keyword)
    if (period >= 3 || d.includes('extra') || d.includes('overtime')) return '⏱ Prorrogação ' + (clock || '').trim();
    // Usa period da ESPN para 1T/2T (mais confiável que o texto)
    const t = period === 2 ? '2T' : '1T';
    return '🔴 ' + t + ' ' + (clock || '').trim();
  }
  if (state === 'post') return '✅ Encerrado';
  return formatMatchTime(matchDate);
}

async function syncLive() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Sincronizando dados ao vivo...`);

  // Datas de "hoje" e "ontem" em horário de Brasília (UTC-3)
  // Busca os dois dias porque um jogo iniciado às 23h BRT pode
  // ser classificado pela ESPN sob a data UTC seguinte
  const BRT_OFFSET = -3 * 60 * 60 * 1000;
  const nowBRT   = new Date(Date.now() + BRT_OFFSET);
  const todayBRT = nowBRT.toISOString().slice(0,10).replace(/-/g,'');
  const yestBRT  = new Date(nowBRT.getTime() - 24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');

  let events = [];
  try {
    for (const dateStr of [yestBRT, todayBRT]) {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=${dateStr}`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!res.ok) throw new Error(`ESPN HTTP ${res.status} (${dateStr})`);
      const data = await res.json();
      events.push(...(data.events || []));
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

  // Remover duplicados (mesmo jogo pode vir nas duas datas)
  const seenIds = new Set();
  events = events.filter(ev => {
    if (seenIds.has(ev.id)) return false;
    seenIds.add(ev.id);
    return true;
  });

  // Filtrar: manter apenas jogos de "hoje BRT" + jogos ao vivo/recém-encerrados de "ontem BRT"
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  events = events.filter(ev => {
    const comp  = ev.competitions?.[0];
    const state = comp?.status?.type?.state || 'pre';
    const evDateBRT = new Date(new Date(ev.date).getTime() + BRT_OFFSET).toISOString().slice(0,10).replace(/-/g,'');

    if (evDateBRT === todayBRT) return true;
    // Jogo de "ontem BRT": só mantém se ainda ao vivo ou terminou há pouco
    if (state === 'in') return true;
    if (state === 'post') {
      const elapsed = Date.now() - new Date(ev.date).getTime();
      return elapsed < TWO_HOURS + (3*60*60*1000); // até ~2h após o fim (considerando ~2h de jogo)
    }
    return false;
  });

  const games = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const status = comp.status;
    const state  = status?.type?.state || 'pre';
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeName  = teamName(home.team?.displayName || home.team?.name || '');
    const awayName  = teamName(away.team?.displayName || away.team?.name || '');
    const homeScore = home.score !== undefined ? String(home.score) : '-';
    const awayScore = away.score !== undefined ? String(away.score) : '-';

    // IDs dos times para cruzar com o gol
    const homeId = home.team?.id || '';
    const awayId  = away.team?.id || '';

    const details = comp.details || [];
    const goals = details
      .filter(d => {
        const t = (d.type?.text || '').toLowerCase();
        // Exclui cobranças da disputa de pênaltis (shootout) — não são "gols" do jogo
        if (t.includes('shootout')) return false;
        return d.scoringPlay === true || t.includes('goal');
      })
      .map(d => {
        let teamStr = teamName(d.team?.displayName || d.team?.name || '');
        // Se o nome veio vazio, tenta cruzar pelo ID
        if (!teamStr && d.team?.id) {
          if (String(d.team.id) === String(homeId)) teamStr = homeName;
          else if (String(d.team.id) === String(awayId)) teamStr = awayName;
        }
        // Nome do jogador: tenta athletesInvolved primeiro
        let player = d.athletesInvolved?.[0]?.displayName
                   || d.athletesInvolved?.[0]?.shortName
                   || '';
        // Fallback: extrai do texto do lance, ex: "Goal! Team. Player Name ..."
        if (!player && d.text) {
          // Remove prefixos comuns e tenta pegar o nome próprio
          const m = d.text.match(/(?:Goal!?\s*[^.]*\.\s*)([A-Z][\wÀ-ÿ'\-]+(?:\s[A-Z][\wÀ-ÿ'\-]+)*)/);
          if (m && m[1]) player = m[1].trim();
        }
        return {
          team:   teamStr,
          player,
          clock:  d.clock?.displayValue || ''
        };
      });

    games.push({
      id: ev.id,
      home: homeName,
      away: awayName,
      homeScore,
      awayScore,
      state,
      period:      comp.status?.period || 1,
      clock:       status?.displayClock || '',
      statusLabel: statusLabel(state, status?.type?.shortDetail, status?.displayClock, ev.date, comp.status?.period || 1),
      isLive:      state === 'in',
      isFinished:  state === 'post',
      date:        ev.date,
      goals
    });
  }

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
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncLive()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
