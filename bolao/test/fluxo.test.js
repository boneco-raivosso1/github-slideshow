'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Por padrão usa o Postgres embutido em memória.
// Para testar contra um Postgres real (banco vazio!): TEST_DATABASE_URL=postgres://... npm test
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else { delete process.env.DATABASE_URL; process.env.DB_PATH = 'memory'; }
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'segredo';

const { init, ensureAdmin, run, close } = require('../db');
const { server, scorePrediction, localInputToISO } = require('../server');

let base;
before(async () => {
  await init();
  await ensureAdmin();
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await close(); });

// Cliente simples que guarda o cookie de sessão
function client() {
  let cookie = '';
  async function req(method, p, form) {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [].concat(v).map(x => [k, x]))).toString() : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  return { get: p => req('GET', p), post: (p, f) => req('POST', p, f) };
}

const isoLocal = offsetMin => {
  // datetime-local no fuso de São Paulo (UTC-3)
  const d = new Date(Date.now() + offsetMin * 60000 - 3 * 3600000);
  return d.toISOString().slice(0, 16);
};

test('pontuação', () => {
  const pool = { points_exact: 3, points_result: 1 };
  const m = { home_score: 2, away_score: 1 };
  assert.equal(scorePrediction({ home: 2, away: 1 }, m, pool), 3);
  assert.equal(scorePrediction({ home: 3, away: 0 }, m, pool), 1);
  assert.equal(scorePrediction({ home: 1, away: 1 }, m, pool), 0);
  assert.equal(scorePrediction({ home: 0, away: 0 }, { home_score: 1, away_score: 1 }, pool), 1);
  assert.equal(scorePrediction({ home: 1, away: 0 }, { home_score: null, away_score: null }, pool), null);
});

test('conversão de horário de Brasília para UTC', () => {
  assert.equal(localInputToISO('2026-11-20T16:00'), '2026-11-20T19:00:00.000Z');
  assert.equal(localInputToISO('lixo'), null);
});

test('fluxo completo: admin, participante, palpite, resultado e ranking', async () => {
  const admin = client();
  assert.equal((await admin.get('/admin')).location, '/login');
  assert.equal((await admin.post('/login', { username: 'admin', password: 'errada' })).status, 401);
  assert.equal((await admin.post('/login', { username: 'admin', password: 'segredo' })).location, '/admin');

  // cria bolões
  let r = await admin.post('/admin/boloes', { name: 'Brasileirão', description: '', points_exact: '3', points_result: '1' });
  assert.match(r.location, /^\/admin\/boloes\/1/);
  await admin.post('/admin/boloes', { name: 'Champions', description: '', points_exact: '5', points_result: '2' });

  // participantes: joão só no Brasileirão, maria nos dois
  await admin.post('/admin/usuarios', { name: 'João', username: 'joao', password: '1234', pools: '1' });
  r = await admin.post('/admin/usuarios', { name: 'Maria', username: 'maria', password: '1234', pools: ['1', '2'] });
  assert.match(decodeURIComponent(r.location), /Maria criado/);
  r = await admin.post('/admin/usuarios', { name: 'Outro', username: 'joao', password: '1234' });
  assert.match(decodeURIComponent(r.location), /já existe/);

  // jogos: um futuro e um que já começou
  await admin.post('/admin/boloes/1/jogos', { home_team: 'Flamengo', away_team: 'Palmeiras', kickoff: isoLocal(120) });
  await admin.post('/admin/boloes/1/jogos', { home_team: 'Grêmio', away_team: 'Inter', kickoff: isoLocal(240) });
  await admin.post('/admin/boloes/2/jogos', { home_team: 'Real', away_team: 'City', kickoff: isoLocal(120) });

  const joao = client(), maria = client();
  assert.equal((await joao.post('/login', { username: 'joao', password: '1234' })).location, '/boloes');
  await maria.post('/login', { username: 'maria', password: '1234' });

  // joão não acessa a área de admin nem o bolão da Champions
  assert.equal((await joao.get('/admin')).status, 403);
  assert.equal((await joao.get('/boloes/2')).status, 404);
  assert.match((await joao.get('/boloes')).text, /Brasileirão/);
  assert.doesNotMatch((await joao.get('/boloes')).text, /Champions/);

  // palpites
  r = await joao.post('/boloes/1/palpites', { h_1: '2', a_1: '1', h_2: '0', a_2: '0' });
  assert.match(decodeURIComponent(r.location), /2 palpite\(s\) salvo/);
  await maria.post('/boloes/1/palpites', { h_1: '1', a_1: '0', h_2: '1', a_2: '' });
  assert.equal((await joao.post('/boloes/2/palpites', { h_3: '1', a_3: '1' })).location.startsWith('/boloes?err'), true);

  // palpites da galera ficam escondidos antes do jogo
  assert.equal((await maria.get('/boloes/1/jogos/1')).status, 403);

  // jogo 1 "começa" e termina 2x1
  await run("UPDATE matches SET kickoff_at = '2020-01-01T00:00:00.000Z' WHERE id = 1");
  r = await joao.post('/boloes/1/palpites', { h_1: '5', a_1: '0' });
  assert.match(decodeURIComponent(r.location), /já começaram/);
  r = await admin.post('/admin/jogos/1', { home_team: 'Flamengo', away_team: 'Palmeiras', kickoff: '2020-01-01T00:00', home_score: '2', away_score: '1' });
  assert.match(decodeURIComponent(r.location), /Resultado salvo/);

  const page = (await maria.get('/boloes/1')).text;
  // João: exato (3 pts) / Maria: vencedor (1 pt)
  assert.match(page, /João<\/td><td><strong>3<\/strong>/);
  assert.match(page, /Maria<\/td><td><strong>1<\/strong>/);
  assert.ok(page.indexOf('João</td>') < page.indexOf('Maria</td>'));

  const detail = (await maria.get('/boloes/1/jogos/1')).text;
  assert.match(detail, /2 × 1/);
  assert.match(detail, /Placar exato/);

  // desativar conta derruba a sessão
  await admin.post('/admin/usuarios/2', { name: 'João', pools: '1' });
  assert.equal((await joao.get('/boloes')).location, '/login');
  assert.equal((await joao.post('/login', { username: 'joao', password: '1234' })).status, 403);

  // troca de senha
  r = await maria.post('/conta/senha', { current: '1234', password: 'nova123', password2: 'nova123' });
  assert.match(decodeURIComponent(r.location), /Senha alterada/);
});

test('bloqueia POST vindo de outro site', async () => {
  const res = await fetch(base + '/login', { method: 'POST', headers: { origin: 'http://malicioso.com' }, body: '' });
  assert.equal(res.status, 403);
});
