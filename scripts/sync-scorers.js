/**
 * Bolão Copa 2026 — Sync Artilheiros
 * GitHub Actions — busca top scorers da API-Football
 * league=1, season=2026 (FIFA World Cup)
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID || 'copa-do-mundo-3c309'
});
const db = admin.firestore();

const API_KEY = process.env.API_FOOTBALL_KEY;
const LEAGUE  = process.env.API_FOOTBALL_LEAGUE  || '1';
const SEASON  = process.env.API_FOOTBALL_SEASON  || '2026';

async function syncScorers() {
  console.log(`[${new Date().toISOString()}] Buscando artilheiros league=${LEAGUE} season=${SEASON}...`);

  if (!API_KEY) {
    console.error('API_FOOTBALL_KEY não definida');
    process.exit(1);
  }

  const url = `https://v3.football.api-sports.io/players/topscorers?league=${LEAGUE}&season=${SEASON}`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_KEY }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  // ── Validar erros lógicos mesmo com HTTP 200 ─────────────────────────────
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API errors: ${JSON.stringify(data.errors)}`);
  }

  // Log quota restante
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  const limit     = res.headers.get('x-ratelimit-requests-limit');
  console.log(`  Quota: ${remaining ?? '?'}/${limit ?? '?'} requests restantes hoje`);

  // Metadados de auditoria — gravados sempre
  const meta = {
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAtISO: new Date().toISOString(),
    source:       'api-football',
    league:       LEAGUE,
    season:       SEASON
  };

  if (!data.response || data.response.length === 0) {
    console.log('  Nenhum artilheiro retornado ainda (torneio não iniciou?)');
    await db.doc('config/scorers').set({
      ...meta,
      players: [],
      status:  'empty',
      message: 'Artilharia disponível após o início da Copa'
    });
    return;
  }

  const players = data.response.slice(0, 20).map((item, idx) => ({
    rank:    idx + 1,
    name:    item.player?.name    ?? '',
    photo:   item.player?.photo   ?? '',
    country: item.statistics?.[0]?.team?.name ?? '',
    goals:   item.statistics?.[0]?.goals?.total       ?? 0,
    assists: item.statistics?.[0]?.goals?.assists      ?? 0,
    matches: item.statistics?.[0]?.games?.appearences  ?? 0,
    penalty: item.statistics?.[0]?.penalty?.scored     ?? 0
  }));

  await db.doc('config/scorers').set({
    ...meta,
    players,
    status: 'ok',
    total:  data.response.length
  });

  console.log(`  ✓ ${players.length} artilheiros salvos`);
  console.log(`  ✓ Líder: ${players[0]?.name} (${players[0]?.goals} gols)`);
  console.log(`  ✓ updatedAtISO: ${meta.updatedAtISO}`);
}

syncScorers()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERRO CRÍTICO:', e.message); process.exit(1); });
