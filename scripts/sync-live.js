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

function statusLabel(state, detail, clock, matchDate) {
  if (state === 'in') {
    if (detail && detail.toLowerCase().includes('half')) return '⏸ Intervalo';
    return '🔴 ' + (clock || detail || 'Ao Vivo');
  }
  if (state === 'post') return '✅ Encerrado';
  return formatMatchTime(matchDate); // ex: "⏰ 14h" ou "📅 11/06 · 17h"
}

async function syncLive() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Sincronizando dados ao vivo...`);

  let data;
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=${new Date().toISOString().slice(0,10).replace(/-/g,'')}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.error('Erro ESPN:', e.message);
    await db.doc('config/live').set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: e.message,
      games: []
    }, { merge: true });
    return;
  }

  const games = [];
  const events = data.events || [];

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

    const details = comp.details || [];
    const goals = details
      .filter(d => d.type?.text?.toLowerCase().includes('goal'))
      .map(d => ({
        team:   teamName(d.team?.displayName || ''),
        player: d.athletesInvolved?.[0]?.displayName || '',
        clock:  d.clock?.displayValue || ''
      }));

    games.push({
      id: ev.id,
      home: homeName,
      away: awayName,
      homeScore,
      awayScore,
      state,
      clock:       status?.displayClock || '',
      statusLabel: statusLabel(state, status?.type?.shortDetail, status?.displayClock, ev.date),
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
