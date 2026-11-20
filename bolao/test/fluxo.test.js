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
  assert.match(decodeURIComponent(r.location), /passaram do prazo/);
  r = await admin.post('/admin/jogos/1', { home_team: 'Flamengo', away_team: 'Palmeiras', kickoff: '2020-01-01T00:00', home_score: '2', away_score: '1' });
  assert.match(decodeURIComponent(r.location), /Resultado salvo/);

  const page = (await maria.get('/boloes/1')).text;
  // João: exato (3 pts) / Maria: vencedor (1 pt)
  assert.match(page, /João<\/td><td><strong>3<\/strong>/);
  assert.match(page, /Maria<\/td><td><strong>1<\/strong>/);
  assert.ok(page.indexOf('João</td>') < page.indexOf('Maria</td>'));

  // tabela com palpites de todos: só jogos fechados (jogo 2 ainda aberto não aparece)
  const galera = (await maria.get('/boloes/1/galera')).text;
  assert.match(galera, /Flamengo <strong>2×1<\/strong> Palmeiras/);
  assert.doesNotMatch(galera, /Grêmio/);
  assert.match(galera, /cell exact">2×1<small>\+3/);   // João
  assert.match(galera, /cell result">1×0<small>\+1/);  // Maria
  assert.equal((await joao.get('/boloes/2/galera')).status, 404);

  // ranking geral soma os bolões
  const geral = (await joao.get('/ranking')).text;
  assert.match(geral, /Ranking geral/);
  assert.ok(geral.indexOf('João</td>') < geral.indexOf('Maria</td>'));

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

test('prazo dos palpites: minutos antes do jogo e prazo final', async () => {
  const admin = client();
  await admin.post('/login', { username: 'admin', password: 'segredo' });
  // fecha 30 min antes de cada jogo
  let r = await admin.post('/admin/boloes', { name: 'Quinta', description: '', points_exact: '3', points_result: '1', close_minutes: '30', deadline: '' });
  const poolId = Number(r.location.match(/boloes\/(\d+)/)[1]);
  await admin.post('/admin/usuarios', { name: 'Zé', username: 'zezinho', password: '1234', pools: String(poolId) });
  await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'A', away_team: 'B', kickoff: isoLocal(20) }); // fecha 10 min atrás
  await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'C', away_team: 'D', kickoff: isoLocal(90) }); // fecha em 60 min
  const page = (await admin.get(`/admin/boloes/${poolId}`)).text;
  const ids = [...page.matchAll(/action="\/admin\/jogos\/(\d+)"/g)].map(m => m[1]);

  const ze = client();
  await ze.post('/login', { username: 'zezinho', password: '1234' });
  r = await ze.post(`/boloes/${poolId}/palpites`, { [`h_${ids[0]}`]: '1', [`a_${ids[0]}`]: '0', [`h_${ids[1]}`]: '2', [`a_${ids[1]}`]: '2' });
  const msg = decodeURIComponent(r.location);
  assert.match(msg, /1 palpite\(s\) salvo/);
  assert.match(msg, /1 jogo\(s\) já passaram do prazo/);
  // depois do prazo, a galera já pode ver os palpites do jogo A
  assert.equal((await ze.get(`/boloes/${poolId}/jogos/${ids[0]}`)).status, 200);
  assert.match((await ze.get(`/boloes/${poolId}`)).text, /fecham 30 min antes/);

  // prazo final que já passou fecha todos os jogos, mesmo os mais tarde
  await admin.post(`/admin/boloes/${poolId}`, { name: 'Quinta', description: '', points_exact: '3', points_result: '1', close_minutes: '0', deadline: isoLocal(-5) });
  r = await ze.post(`/boloes/${poolId}/palpites`, { [`h_${ids[1]}`]: '3', [`a_${ids[1]}`]: '0' });
  assert.match(decodeURIComponent(r.location), /passaram do prazo/);

  // removendo o prazo final, volta a abrir
  await admin.post(`/admin/boloes/${poolId}`, { name: 'Quinta', description: '', points_exact: '3', points_result: '1', close_minutes: '0', deadline: '' });
  r = await ze.post(`/boloes/${poolId}/palpites`, { [`h_${ids[1]}`]: '3', [`a_${ids[1]}`]: '0' });
  assert.match(decodeURIComponent(r.location), /1 palpite\(s\) salvo/);
});

test('primeiro acesso, entrar no bolão e confirmação de pagamento', async () => {
  const admin = client();
  await admin.post('/login', { username: 'admin', password: 'segredo' });
  let r = await admin.post('/admin/boloes', { name: 'Pix da Quinta', description: '', points_exact: '3', points_result: '1',
    close_minutes: '0', deadline: '', open_join: '1', require_payment: '1', entry_fee: 'R$ 10', pix_key: 'chave-teste' });
  const poolId = Number(r.location.match(/boloes\/(\d+)/)[1]);
  await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'Bahia', away_team: 'Vitória', kickoff: isoLocal(60) });
  const page = (await admin.get(`/admin/boloes/${poolId}`)).text;
  const matchId = page.match(/action="\/admin\/jogos\/(\d+)"/)[1];

  // tela de login tem o botão de primeiro acesso
  assert.match((await client().get('/login')).text, /Primeiro acesso/);

  // cadastro: validações e criação
  const ana = client(), bia = client();
  r = await ana.post('/cadastro', { name: 'Ana', username: 'an', password: '1234', password2: '1234' });
  assert.equal(r.status, 400);
  r = await ana.post('/cadastro', { name: 'Ana', username: 'ana', password: '1234', password2: '4321' });
  assert.match(r.text, /não conferem/);
  r = await ana.post('/cadastro', { name: 'Ana', username: 'ana', password: '1234', password2: '1234' });
  assert.equal(r.location.split('?')[0], '/boloes');
  r = await bia.post('/cadastro', { name: 'Bia', username: 'ANA', password: '1234', password2: '1234' });
  assert.match(r.text, /já existe/);
  await bia.post('/cadastro', { name: 'Bia', username: 'bia', password: '1234', password2: '1234' });

  // bolões abertos aparecem; bolões fechados para entrada não
  const home = (await ana.get('/boloes')).text;
  assert.match(home, /Pix da Quinta/);
  assert.match(home, /chave-teste/);
  assert.doesNotMatch(home, /Brasileirão/);
  assert.match(decodeURIComponent((await ana.post('/boloes/1/entrar')).location), /não está aberto/);

  // as duas entram e palpitam
  for (const c of [ana, bia]) {
    assert.match(decodeURIComponent((await c.post(`/boloes/${poolId}/entrar`)).location), /Você entrou/);
    await c.post(`/boloes/${poolId}/palpites`, { [`h_${matchId}`]: '2', [`a_${matchId}`]: '0' });
  }
  assert.match((await ana.get(`/boloes/${poolId}`)).text, /ainda não estão valendo/);

  // admin confirma só a Ana
  // a lista de pendentes vem em ordem alfabética: o primeiro "Confirmar pagamento" é da Ana
  const adminPage = (await admin.get(`/admin/boloes/${poolId}`)).text;
  const anaId = Number(adminPage.match(/pagamento\/(\d+)">\s*<input type="hidden" name="paid" value="1">/)[1]);
  r = await admin.post(`/admin/boloes/${poolId}/pagamento/${anaId}`, { paid: '1' });
  assert.match(decodeURIComponent(r.location), /confirmado/);

  // jogo termina 2x0: só a Ana pontua; Bia aparece como não confirmada
  await run("UPDATE matches SET kickoff_at = '2020-01-01T00:00:00.000Z', home_score = 2, away_score = 0 WHERE id = ?", Number(matchId));
  const pool = (await bia.get(`/boloes/${poolId}`)).text;
  assert.match(pool, /Ana<\/td><td><strong>3<\/strong>/);
  assert.doesNotMatch(pool, /Bia<\/td><td><strong>/);
  assert.match(pool, /Palpites confirmados \(1\)/);
  assert.match(pool, /Palpites não confirmados \(1\)/);
  const galera = (await bia.get(`/boloes/${poolId}/galera`)).text;
  assert.match(galera, /cell void/);
  assert.match((await bia.get(`/boloes/${poolId}/jogos/${matchId}`)).text, /Não confirmado/);

  // salvar a lista de participantes não apaga a confirmação
  const users = [...(await admin.get(`/admin/boloes/${poolId}`)).text.matchAll(/name="users" value="(\d+)" checked/g)].map(m => m[1]);
  await admin.post(`/admin/boloes/${poolId}/membros`, { users });
  assert.match((await bia.get(`/boloes/${poolId}`)).text, /Palpites confirmados \(1\)/);

  // desfazer a confirmação tira a Ana da classificação
  await admin.post(`/admin/boloes/${poolId}/pagamento/${anaId}`, { paid: '0' });
  assert.doesNotMatch((await bia.get(`/boloes/${poolId}`)).text, /Ana<\/td><td><strong>/);
});

test('importar rodada a partir do relatório do WhatsApp', async () => {
  const admin = client();
  await admin.post('/login', { username: 'admin', password: 'segredo' });
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, 'rodada35.txt'), 'utf8');

  // sem senha inicial: erro e o texto continua no formulário
  let r = await admin.post('/admin/importar', { text, name: '', points_exact: '4', points_result: '1', kickoff: isoLocal(600), password: '' });
  assert.equal(r.status, 400);

  r = await admin.post('/admin/importar', { text, name: '', points_exact: '4', points_result: '1', kickoff: isoLocal(600), password: '1234' });
  const msg = decodeURIComponent(r.location);
  assert.match(msg, /10 jogos, 8 participantes, 80 palpites/);
  assert.match(msg, /paulo\.rossi/);
  const poolId = Number(r.location.match(/boloes\/(\d+)/)[1]);

  const adminPage = (await admin.get(`/admin/boloes/${poolId}`)).text;
  assert.match(adminPage, /Brasileirão — Rodada 35/);
  assert.match(adminPage, /Ao vivo/);

  // participante importado entra com a senha inicial e vê a classificação parcial (MIR 0x0 ao vivo)
  const eduardo = client();
  assert.equal((await eduardo.post('/login', { username: 'eduardo', password: '1234' })).location, '/boloes');
  const pool = (await eduardo.get(`/boloes/${poolId}`)).text;
  for (const n of ['Camargo', 'Eduardo', 'Fagner', 'Paulo Rossi']) assert.match(pool, new RegExp(`${n}</td><td><strong>1</strong>`));
  for (const n of ['Bambam', 'Clodivildo', 'Renato', 'Samuel']) assert.match(pool, new RegExp(`${n}</td><td><strong>0</strong>`));
  assert.match(pool, /Coritiba/);           // jogos futuros abertos para palpite
  assert.match(pool, /name="h_\d+" value="1"/); // palpite importado já preenchido

  // ranking geral = pontos anteriores + rodada
  const geral = (await eduardo.get('/ranking')).text;
  assert.match(geral, /Eduardo<\/td><td><strong>38<\/strong>/);
  assert.match(geral, /Paulo Rossi<\/td><td><strong>16<\/strong>/);
  assert.ok(geral.indexOf('Eduardo</td>') < geral.indexOf('Bambam</td>'));
  assert.match(geral, /Anteriores/);

  // encerrar o jogo ao vivo: vira "Encerrado"
  const mid = adminPage.match(/action="\/admin\/jogos\/(\d+)"/)[1];
  r = await admin.post(`/admin/jogos/${mid}`, { home_team: 'Mirassol', away_team: 'Atlético-MG', kickoff: isoLocal(-60), home_score: '1', away_score: '1' });
  assert.match(decodeURIComponent(r.location), /Resultado salvo/);
  assert.match((await eduardo.get(`/boloes/${poolId}`)).text, /Eduardo<\/td><td><strong>4<\/strong>/);
});

test('escudo do time aparece quando existe o arquivo', async () => {
  // Rodada 35 (importada antes): todos os times têm escudo em public/escudos
  const eduardo = client();
  await eduardo.post('/login', { username: 'eduardo', password: '1234' });
  const id = (await eduardo.get('/boloes')).text.match(/href="\/boloes\/(\d+)"/)[1];
  const html = (await eduardo.get(`/boloes/${id}`)).text;
  assert.match(html, /<img class="crest img" src="\/escudos\/atletico-mineiro\.png"/);     // "Atlético-MG"
  assert.match(html, /<img class="crest img" src="\/escudos\/athletico-paranaense\.png"/); // "Athletico-PR"
  assert.match(html, /<img class="crest img" src="\/escudos\/bragantino\.png"/);           // "Red Bull Bragantino"
  assert.match(html, /<img class="crest img" src="\/escudos\/sao-paulo\.png"/);            // "São Paulo"

  // time sem escudo (jogo "C x D" do bolão Quinta): continua com as iniciais
  const ze = client();
  await ze.post('/login', { username: 'zezinho', password: '1234' });
  const zid = (await ze.get('/boloes')).text.match(/href="\/boloes\/(\d+)"/)[1];
  assert.match((await ze.get(`/boloes/${zid}`)).text, /class="crest" style="--hue/);

  const img = await fetch(base + '/escudos/flamengo.png');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/escudos/..%2Fserver.js')).status, 404);
  assert.equal((await fetch(base + '/escudos/nao-existe.png')).status, 404);
});

test('rodada da pasta seeds é importada uma única vez', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { runSeeds } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeds-'));
  try {
    const text = fs.readFileSync(path.join(__dirname, 'rodada35.txt'), 'utf8');
    fs.writeFileSync(path.join(dir, 'teste.json'), JSON.stringify({ name: 'Rodada Seed Teste', points_exact: 4, points_result: 1, kickoff: '2030-01-01T16:00', text }));
    const first = await runSeeds(dir);
    assert.equal(first.length, 1);
    assert.equal(first[0].predCount, 80);
    assert.deepEqual(await runSeeds(dir), []); // segunda vez: nada

    const admin = client();
    await admin.post('/login', { username: 'admin', password: 'segredo' });
    const page = (await admin.get(`/admin/boloes/${first[0].poolId}`)).text;
    assert.match(page, /Rodada Seed Teste/);
    assert.match(page, /Coritiba/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zerar o app apaga bolões e participantes, mantendo só os administradores', async () => {
  const admin = client();
  await admin.post('/login', { username: 'admin', password: 'segredo' });
  const ana = client();
  assert.equal((await ana.post('/login', { username: 'ana', password: '1234' })).location, '/boloes');

  // sem digitar ZERAR: nada acontece
  let r = await admin.post('/admin/zerar', { confirm: 'sim' });
  assert.match(decodeURIComponent(r.location), /Nada foi apagado/);
  assert.match((await admin.get('/admin')).text, /Pix da Quinta/);

  // participante não pode zerar
  assert.equal((await ana.post('/admin/zerar', { confirm: 'ZERAR' })).status, 403);

  r = await admin.post('/admin/zerar', { confirm: 'zerar' });
  assert.match(decodeURIComponent(r.location), /App zerado/);
  const page = (await admin.get('/admin')).text;
  assert.doesNotMatch(page, /Pix da Quinta|Rodada 35|Eduardo/);
  assert.match(page, /Nenhum bolão ainda/);
  assert.match(page, /Administrador/);
  assert.equal((await ana.get('/boloes')).location, '/login'); // sessão da participante caiu
  assert.equal((await client().post('/login', { username: 'ana', password: '1234' })).status, 401);
  assert.doesNotMatch((await admin.get('/ranking')).text, /Eduardo/);
});

test('senha do bolão e prazo único antes do primeiro jogo da rodada (jogos sem horário)', async () => {
  const admin = client();
  await admin.post('/login', { username: 'admin', password: 'segredo' });
  const cfg = extra => ({ name: 'Rodada 36', description: '', points_exact: '4', points_result: '1', open_join: '1', require_payment: '',
    join_password: 'gol36', close_mode: 'first', close_minutes: '30', round_start: isoLocal(60), ...extra });
  let r = await admin.post('/admin/boloes', cfg());
  const poolId = Number(r.location.match(/boloes\/(\d+)/)[1]);

  // jogos sem horário são aceitos no modo "antes do primeiro jogo"
  r = await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'Flamengo', away_team: 'Vasco', kickoff: '' });
  assert.match(decodeURIComponent(r.location), /adicionado/);
  await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'Santos', away_team: 'Bahia', kickoff: '' });
  const ids = [...(await admin.get(`/admin/boloes/${poolId}`)).text.matchAll(/action="\/admin\/jogos\/(\d+)"/g)].map(m => m[1]);
  assert.equal(ids.length, 2);

  // participantes veem o bolão com cadeado, mas não a senha
  const caio = client(), dani = client();
  await caio.post('/cadastro', { name: 'Caio', username: 'caio', password: '1234', password2: '1234' });
  await dani.post('/cadastro', { name: 'Dani', username: 'dani', password: '1234', password2: '1234' });
  const home = (await caio.get('/boloes')).text;
  assert.match(home, /Rodada 36/);
  assert.match(home, /Com senha/);
  assert.doesNotMatch(home, /gol36/);

  // senha errada não entra; certa entra
  assert.match(decodeURIComponent((await caio.post(`/boloes/${poolId}/entrar`, { password: 'errada' })).location), /incorreta/);
  assert.equal((await caio.get(`/boloes/${poolId}`)).status, 404);
  assert.match(decodeURIComponent((await caio.post(`/boloes/${poolId}/entrar`, { password: 'gol36' })).location), /Você entrou/);

  // 5 tentativas erradas bloqueiam, mesmo acertando depois
  for (let i = 0; i < 5; i++) await dani.post(`/boloes/${poolId}/entrar`, { password: `x${i}` });
  assert.match(decodeURIComponent((await dani.post(`/boloes/${poolId}/entrar`, { password: 'gol36' })).location), /Muitas tentativas/);

  // prazo: primeiro jogo daqui a 60 min, fecha 30 min antes → ainda aberto
  const page = (await caio.get(`/boloes/${poolId}`)).text;
  assert.match(page, /Todos os palpites fecham .* \(30 min antes do primeiro jogo da rodada\)/);
  assert.match(page, /Jogo da rodada/);
  r = await caio.post(`/boloes/${poolId}/palpites`, { [`h_${ids[0]}`]: '2', [`a_${ids[0]}`]: '1', [`h_${ids[1]}`]: '0', [`a_${ids[1]}`]: '0' });
  assert.match(decodeURIComponent(r.location), /2 palpite\(s\) salvo/);

  // primeiro jogo daqui a 20 min → fechou há 10 min: TODOS os jogos fecham juntos
  await admin.post(`/admin/boloes/${poolId}`, cfg({ round_start: isoLocal(20) }));
  r = await caio.post(`/boloes/${poolId}/palpites`, { [`h_${ids[1]}`]: '3', [`a_${ids[1]}`]: '0' });
  assert.match(decodeURIComponent(r.location), /passaram do prazo/);
  assert.equal((await caio.get(`/boloes/${poolId}/jogos/${ids[1]}`)).status, 200); // palpites da galera liberados

  // sem horário da rodada: vale o jogo mais cedo cadastrado
  await admin.post(`/admin/boloes/${poolId}`, cfg({ round_start: '' }));
  await admin.post(`/admin/jogos/${ids[0]}`, { home_team: 'Flamengo', away_team: 'Vasco', kickoff: isoLocal(90) });
  r = await caio.post(`/boloes/${poolId}/palpites`, { [`h_${ids[1]}`]: '3', [`a_${ids[1]}`]: '0' });
  assert.match(decodeURIComponent(r.location), /1 palpite\(s\) salvo/);

  // no modo "cada jogo", o horário volta a ser obrigatório
  await admin.post(`/admin/boloes/${poolId}`, cfg({ close_mode: 'each' }));
  r = await admin.post(`/admin/boloes/${poolId}/jogos`, { home_team: 'Grêmio', away_team: 'Inter', kickoff: '' });
  assert.match(decodeURIComponent(r.location), /Informe a data e hora/);
});
