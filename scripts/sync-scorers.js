/**
 * Bolão Copa 2026 — Sync Artilheiros (Híbrido)
 * GitHub Actions — roda a cada 4 horas
 *
 * Estratégia híbrida:
 *  1) Tenta o endpoint de líderes da ESPN (fonte "oficial")
 *  2) SEMPRE mantém um acumulador próprio, construído a partir dos gols
 *     que o sync-live.js já captura em config/live (jogos finalizados)
 *  3) Mescla as duas fontes: ESPN tem prioridade quando disponível,
 *     o acumulador próprio cobre jogadores/gols que a ESPN ainda não listou
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

// Mapeamento ESPN → nomes do bolão (mesmo do sync-locks e sync-live)
const ESPN_TM = {
  'Mexico':'México','South Korea':'Coreia do Sul','Czech Republic':'Rep. Tcheca',
  'Czechia':'Rep. Tcheca','South Africa':'África do Sul','Canada':'Canadá',
  'Switzerland':'Suíça','Qatar':'Catar','Bosnia-Herzegovina':'Bósnia',
  'Brazil':'Brasil','Morocco':'Marrocos','Scotland':'Escócia','Haiti':'Haiti',
  'United States':'EUA','USA':'EUA','Paraguay':'Paraguai','Turkey':'Turquia',
  'Turkiye':'Turquia','Türkiye':'Turquia','Australia':'Austrália','Germany':'Alemanha',
  'Ecuador':'Equador','Ivory Coast':'Costa do Marfim','Curaçao':'Curaçao',
  'Netherlands':'Holanda','Japan':'Japão','Sweden':'Suécia','Tunisia':'Tunísia',
  'Belgium':'Bélgica','Iran':'Irã','Egypt':'Egito','New Zealand':'Nova Zelândia',
  'Spain':'Espanha','Uruguay':'Uruguai','Saudi Arabia':'Arábia Saudita',
  'Cape Verde':'Cabo Verde','France':'França','Senegal':'Senegal',
  'Norway':'Noruega','Iraq':'Iraque','Argentina':'Argentina','Austria':'Áustria',
  'Algeria':'Argélia','Jordan':'Jordânia','Portugal':'Portugal',
  'Colombia':'Colômbia','Uzbekistan':'Uzbequistão','DR Congo':'RD Congo',
  'Congo DR':'RD Congo','England':'Inglaterra','Croatia':'Croácia','Ghana':'Gana',
  'Panama':'Panamá','Korea Republic':'Coreia do Sul','Curacao':'Curaçao'
};

function countryName(n) { return ESPN_TM[n] || n; }

// Normaliza nome para comparação (sem acento, minúsculo, sem espaços extras)
function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 1) Buscar líderes da ESPN ──────────────────────────────────────────────
async function fetchEspnLeaders() {
  try {
    const res = await fetch(
      'https://site.web.api.espn.com/apis/site/v3/sports/soccer/fifa.world/leaders?season=2026',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    const data = await res.json();

    const categories = data.categories || data.leaders || [];
    const goalsCategory = categories.find(c =>
      (c.name || '').toLowerCase().includes('goal') ||
      (c.displayName || '').toLowerCase().includes('goal') ||
      (c.abbreviation || '').toLowerCase() === 'g'
    );

    if (!goalsCategory || !goalsCategory.leaders || goalsCategory.leaders.length === 0) {
      return { players: [], status: 'empty' };
    }

    const players = goalsCategory.leaders.slice(0, 30).map((entry) => {
      const athlete = entry.athlete || entry.person || {};
      const team    = athlete.team || entry.team || {};

      const name    = athlete.displayName || athlete.fullName || athlete.shortName || '';
      const country = countryName(team.displayName || team.name || team.abbreviation || '');
      const goals   = Math.round(entry.value || 0);
      const photo   = athlete.headshot?.href || athlete.headshot?.url || '';

      return { name, photo, country, goals };
    }).filter(p => p.name && p.goals > 0);

    return { players, status: players.length ? 'ok' : 'empty' };
  } catch (e) {
    console.error('  Erro ESPN leaders:', e.message);
    return { players: [], status: 'error', message: e.message };
  }
}

// ── 2) Acumulador próprio a partir de config/live ──────────────────────────
async function updateOwnAccumulator() {
  const accumRef = await db.doc('config/scorersAccum').get();
  const accum = accumRef.exists ? accumRef.data() : { players: {}, processedMatches: [] };
  accum.players = accum.players || {};
  accum.processedMatches = accum.processedMatches || [];

  const liveSnap = await db.doc('config/live').get();
  const games = liveSnap.exists ? (liveSnap.data().games || []) : [];

  let newGoalsAdded = 0;
  for (const g of games) {
    if (!g.isFinished) continue;             // só processa jogos encerrados
    if (accum.processedMatches.includes(g.id)) continue; // já contabilizado
    const goals = g.goals || [];
    for (const gol of goals) {
      if (!gol.player) continue;
      const key = normName(gol.player) + '|' + normName(gol.team || '');
      if (!accum.players[key]) {
        accum.players[key] = { name: gol.player, country: gol.team || '', goals: 0 };
      }
      accum.players[key].goals++;
      newGoalsAdded++;
    }
    accum.processedMatches.push(g.id);
  }

  if (newGoalsAdded > 0 || !accumRef.exists) {
    await db.doc('config/scorersAccum').set(accum);
  }
  console.log(`  ✓ Acumulador próprio: +${newGoalsAdded} gol(s) novo(s), ${accum.processedMatches.length} jogo(s) processado(s) no total`);

  return Object.values(accum.players);
}

// ── 3) Mesclar ESPN + acumulador próprio ───────────────────────────────────
function mergePlayers(espnPlayers, ownPlayers) {
  const merged = {};

  // Base: acumulador próprio (sempre presente, fonte garantida)
  ownPlayers.forEach(p => {
    const key = normName(p.name) + '|' + normName(p.country);
    merged[key] = { name: p.name, country: p.country, goals: p.goals, photo: '', source: 'own' };
  });

  // ESPN tem prioridade quando disponível: sobrescreve contagem se tiver o jogador
  espnPlayers.forEach(p => {
    const key = normName(p.name) + '|' + normName(p.country);
    if (merged[key]) {
      merged[key].goals = Math.max(merged[key].goals, p.goals); // usa o maior dos dois
      merged[key].photo = p.photo || merged[key].photo;
      merged[key].source = 'espn+own';
    } else {
      merged[key] = { ...p, source: 'espn' };
    }
  });

  return Object.values(merged)
    .filter(p => p.goals > 0)
    .sort((a, b) => b.goals - a.goals)
    .slice(0, 20)
    .map((p, idx) => ({ rank: idx + 1, name: p.name, photo: p.photo || '', country: p.country, goals: p.goals, assists: 0, matches: 0, source: p.source }));
}

async function syncScorers() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Sincronizando artilheiros (híbrido)...`);

  const meta = {
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAtISO: new Date().toISOString(),
    season:       '2026'
  };

  // 1) ESPN
  const espnResult = await fetchEspnLeaders();
  console.log(`  ESPN status: ${espnResult.status} (${espnResult.players.length} jogador(es))`);

  // 2) Acumulador próprio (sempre executa)
  const ownPlayers = await updateOwnAccumulator();

  // 3) Mesclar
  const players = mergePlayers(espnResult.players, ownPlayers);

  if (players.length === 0) {
    console.log('  Nenhum gol registrado ainda.');
    await db.doc('config/scorers').set({
      ...meta, players: [], status: 'empty',
      espnStatus: espnResult.status,
      message: 'Nenhum gol marcado ainda'
    });
    return;
  }

  await db.doc('config/scorers').set({
    ...meta, players,
    status: 'ok',
    espnStatus: espnResult.status,
    total: players.length
  });

  console.log(`  ✓ ${players.length} artilheiro(s) salvos`);
  console.log(`  ✓ Líder: ${players[0]?.name} (${players[0]?.goals} gol(s)) — ${players[0]?.country} [${players[0]?.source}]`);
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncScorers()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO CRÍTICO:', e.message); process.exit(1); });
