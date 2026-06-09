/**
 * Bolão Copa 2026 — Sync Artilheiros via ESPN
 * GitHub Actions — roda a cada 6 horas
 * Mesma fonte do Ao Vivo e resultados — sem chave, sem limite de plano
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
  'Turkiye':'Turquia','Australia':'Austrália','Germany':'Alemanha',
  'Ecuador':'Equador','Ivory Coast':'Costa do Marfim','Curaçao':'Curaçao',
  'Netherlands':'Holanda','Japan':'Japão','Sweden':'Suécia','Tunisia':'Tunísia',
  'Belgium':'Bélgica','Iran':'Irã','Egypt':'Egito','New Zealand':'Nova Zelândia',
  'Spain':'Espanha','Uruguay':'Uruguai','Saudi Arabia':'Arábia Saudita',
  'Cape Verde':'Cabo Verde','France':'França','Senegal':'Senegal',
  'Norway':'Noruega','Iraq':'Iraque','Argentina':'Argentina','Austria':'Áustria',
  'Algeria':'Argélia','Jordan':'Jordânia','Portugal':'Portugal',
  'Colombia':'Colômbia','Uzbekistan':'Uzbequistão','DR Congo':'RD Congo',
  'England':'Inglaterra','Croatia':'Croácia','Ghana':'Gana','Panama':'Panamá',
  'Korea Republic':'Coreia do Sul','Curacao':'Curaçao'
};

function countryName(n) { return ESPN_TM[n] || n; }

async function syncScorers() {
  const now = Date.now();
  console.log(`[${new Date().toISOString()}] Buscando artilheiros via ESPN...`);

  const meta = {
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAtISO: new Date().toISOString(),
    source:       'espn',
    season:       '2026'
  };

  // ── Buscar endpoint de líderes da ESPN ──────────────────────────────────
  let data;
  try {
    const res = await fetch(
      'https://site.web.api.espn.com/apis/site/v3/sports/soccer/fifa.world/leaders?season=2026',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    data = await res.json();
  } catch(e) {
    console.error('Erro ESPN:', e.message);
    await db.doc('config/scorers').set({
      ...meta, players: [], status: 'error', message: e.message
    }, { merge: true });
    return;
  }

  // ── Localizar categoria de gols no JSON ─────────────────────────────────
  // ESPN pode retornar em diferentes estruturas dependendo da fase
  const categories = data.categories || data.leaders || [];
  const goalsCategory = categories.find(c =>
    (c.name || '').toLowerCase().includes('goal') ||
    (c.displayName || '').toLowerCase().includes('goal') ||
    (c.abbreviation || '').toLowerCase() === 'g'
  );

  if (!goalsCategory || !goalsCategory.leaders || goalsCategory.leaders.length === 0) {
    console.log('  Sem artilheiros disponíveis ainda (torneio não iniciou ou sem dados).');
    await db.doc('config/scorers').set({
      ...meta, players: [], status: 'empty',
      message: 'Artilharia disponível após o início da Copa'
    });
    return;
  }

  // ── Extrair e mapear jogadores ──────────────────────────────────────────
  const players = goalsCategory.leaders.slice(0, 20).map((entry, idx) => {
    // ESPN pode retornar o atleta inline ou via referência — tentamos ambos
    const athlete = entry.athlete || entry.person || {};
    const team    = athlete.team || entry.team || {};

    const name    = athlete.displayName || athlete.fullName || athlete.shortName || '';
    const country = countryName(team.displayName || team.name || team.abbreviation || '');
    const goals   = Math.round(entry.value || 0);
    const photo   = athlete.headshot?.href || athlete.headshot?.url || '';

    return {
      rank:    idx + 1,
      name,
      photo,
      country,
      goals,
      assists: 0,   // ESPN leaders geralmente não inclui assists no mesmo endpoint
      matches: 0
    };
  }).filter(p => p.name && p.goals > 0);

  if (players.length === 0) {
    console.log('  Nenhum artilheiro com gols ainda.');
    await db.doc('config/scorers').set({
      ...meta, players: [], status: 'empty',
      message: 'Nenhum gol marcado ainda'
    });
    return;
  }

  await db.doc('config/scorers').set({
    ...meta, players, status: 'ok', total: players.length
  });

  console.log(`  ✓ ${players.length} artilheiros salvos`);
  console.log(`  ✓ Líder: ${players[0]?.name} (${players[0]?.goals} gols) — ${players[0]?.country}`);
  console.log(`  ✓ Concluído em ${Date.now()-now}ms`);
}

syncScorers()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO CRÍTICO:', e.message); process.exit(1); });
