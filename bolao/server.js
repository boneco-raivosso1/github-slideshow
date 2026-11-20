'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { init, all, get, run, tx, hashPassword, verifyPassword, ensureAdmin } = require('./db');
const V = require('./views');
const ESC = require('./escudos');
const { parseReport, titleCase, slug } = require('./importer');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 30;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// ---------------------------------------------------------------- utilidades

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new Error('Corpo muito grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const body = {};
      for (const [k, v] of params) {
        if (k in body) body[k] = [].concat(body[k], v); else body[k] = v;
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

const asList = v => (v == null ? [] : [].concat(v));
const asIds = v => asList(v).map(Number).filter(n => Number.isInteger(n) && n > 0);
const str = (v, max = 100) => String(v ?? '').trim().slice(0, max);

function intOrNull(v, min = 0, max = 99) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined; // undefined = inválido
}

// Diferença (ms) entre o horário local do fuso configurado e UTC no instante t
function tzOffsetMs(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: V.TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return local - Math.floor(t / 60000) * 60000;
}

// "2026-11-20T16:00" (horário de Brasília) -> ISO em UTC
function localInputToISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = asUTC - tzOffsetMs(asUTC);
  t = asUTC - tzOffsetMs(t);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------- pontuação

function scorePrediction(pred, match, pool) {
  if (match.home_score == null || match.away_score == null || pred.home == null) return null;
  if (pred.home === match.home_score && pred.away === match.away_score) return pool.points_exact;
  if (Math.sign(pred.home - pred.away) === Math.sign(match.home_score - match.away_score)) return pool.points_result;
  return 0;
}

// Todos os participantes do bolão, com a informação se o palpite deles vale
// (se o bolão exige pagamento, só valem os confirmados).
async function poolMembers(pool) {
  const rows = await all(`SELECT u.id, u.name, u.username, pm.paid FROM pool_members pm JOIN users u ON u.id = pm.user_id
                          WHERE pm.pool_id = ? ORDER BY u.name`, pool.id);
  for (const r of rows) r.counts = !pool.require_payment || !!r.paid;
  return rows;
}

async function computeRanking(pool) {
  const members = (await poolMembers(pool)).filter(m => m.counts);
  const preds = await all(`SELECT p.user_id, p.home, p.away, m.home_score, m.away_score
                     FROM predictions p JOIN matches m ON m.id = p.match_id
                     WHERE m.pool_id = ? AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL`, pool.id);
  const table = new Map(members.map(u => [u.id, { id: u.id, name: u.name, points: 0, exact: 0, result: 0 }]));
  for (const p of preds) {
    const row = table.get(p.user_id);
    if (!row) continue;
    const pts = scorePrediction(p, p, pool);
    row.points += pts;
    if (pts === pool.points_exact && p.home === p.home_score && p.away === p.away_score) row.exact++;
    else if (pts > 0) row.result++;
  }
  return rankRows([...table.values()]);
}

// Ordena por pontos (desempate: placares exatos) e calcula a posição, com empates.
function rankRows(rows) {
  rows.sort((a, b) => b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name, 'pt-BR'));
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.pos = prev && prev.points === r.points && prev.exact === r.exact ? prev.pos : i + 1;
  });
  return rows;
}

// ---------------------------------------------------------------- sessões

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    token, userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
}

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = await get(`SELECT u.id, u.username, u.name, u.is_admin, u.active
                         FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, token, Date.now());
  return row || null;
}

// ---------------------------------------------------------------- roteador

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function redirect(res, to, flash) {
  if (flash) {
    const [type, msg] = flash;
    to += (to.includes('?') ? '&' : '?') + `${type}=${encodeURIComponent(msg)}`;
  }
  res.writeHead(303, { Location: to });
  res.end();
}

function flashFrom(url) {
  if (url.searchParams.get('ok')) return { type: 'ok', msg: url.searchParams.get('ok') };
  if (url.searchParams.get('err')) return { type: 'err', msg: url.searchParams.get('err') };
  return null;
}

const CSS_PATH = path.join(__dirname, 'public', 'style.css');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // Escudos dos times
    if (req.method === 'GET' && url.pathname.startsWith('/escudos/')) {
      const file = url.pathname.slice('/escudos/'.length);
      if (!ESC.FILE_RE.test(file) || !fs.existsSync(path.join(ESC.DIR, file))) { res.writeHead(404); return res.end(); }
      const types = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': types[file.split('.').pop()], 'Cache-Control': 'public, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return fs.createReadStream(path.join(ESC.DIR, file)).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'max-age=300' });
      return fs.createReadStream(CSS_PATH).pipe(res);
    }

    // Proteção básica contra envio de formulários a partir de outros sites
    if (req.method === 'POST' && req.headers.origin) {
      let originHost = null;
      try { originHost = new URL(req.headers.origin).host; } catch { /* inválido */ }
      if (originHost !== req.headers.host) return send(res, 403, 'Origem não permitida');
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
      const user = await currentUser(req);
      if (!r.opts.public && !user) return redirect(res, '/login');
      if (r.opts.admin && !user.is_admin) return send(res, 403, V.messagePage({ user, title: 'Acesso negado', msg: 'Essa área é só para o administrador.' }));
      const body = req.method === 'POST' ? await readBody(req) : {};
      return await r.handler({ req, res, url, params, body, user, flash: flashFrom(url) });
    }
    send(res, 404, V.messagePage({ user: await currentUser(req), title: 'Página não encontrada', msg: 'Não achamos o que você procurava.' }));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, V.messagePage({ title: 'Erro', msg: 'Algo deu errado. Tente novamente.' }));
  }
});

// ---------------------------------------------------------------- rotas: login

route('GET', '/', { public: true }, ({ res, user }) => {
  if (!user) return redirect(res, '/login');
  redirect(res, user.is_admin ? '/admin' : '/boloes');
});

route('GET', '/login', { public: true }, ({ res, user }) => {
  if (user) return redirect(res, '/');
  send(res, 200, V.loginPage({}));
});

route('POST', '/login', { public: true }, async ({ res, body }) => {
  const username = str(body.username, 50);
  const u = await get('SELECT * FROM users WHERE lower(username) = lower(?)', username);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
    return send(res, 401, V.loginPage({ error: 'Usuário ou senha incorretos.', username }));
  }
  if (!u.active) return send(res, 403, V.loginPage({ error: 'Sua conta está desativada. Fale com o administrador.', username }));
  await run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  await createSession(res, u.id);
  redirect(res, u.is_admin ? '/admin' : '/boloes');
});

// Primeiro acesso: a própria pessoa cria usuário e senha
route('GET', '/cadastro', { public: true }, ({ res, user }) => {
  if (user) return redirect(res, '/');
  send(res, 200, V.signupPage({}));
});

route('POST', '/cadastro', { public: true }, async ({ res, body }) => {
  const name = str(body.name, 60), username = str(body.username, 30), password = String(body.password || '');
  const fail = error => send(res, 400, V.signupPage({ error, name, username }));
  if (!name) return fail('Informe seu nome.');
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return fail('Usuário inválido: use de 3 a 30 letras, números, ponto, traço ou _ (sem espaços).');
  if (password.length < 4) return fail('A senha precisa ter pelo menos 4 caracteres.');
  if (password !== body.password2) return fail('As senhas não conferem.');
  if (await get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) return fail(`O usuário "${username}" já existe. Escolha outro.`);
  const { id } = await get('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?) RETURNING id', username, name, hashPassword(password));
  await createSession(res, id);
  redirect(res, '/boloes', ['ok', `Conta criada! Bem-vindo(a), ${name}. Agora escolha o bolão e toque em "Participar".`]);
});

route('POST', '/logout', { public: true }, async ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) await run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  redirect(res, '/login');
});

route('GET', '/conta', ({ res, user, flash }) => send(res, 200, V.accountPage({ user, flash })));

route('POST', '/conta/senha', async ({ res, user, body }) => {
  const u = await get('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!verifyPassword(String(body.current || ''), u.password_hash)) return redirect(res, '/conta', ['err', 'Senha atual incorreta.']);
  const pw = String(body.password || '');
  if (pw.length < 4) return redirect(res, '/conta', ['err', 'A nova senha precisa ter pelo menos 4 caracteres.']);
  if (pw !== body.password2) return redirect(res, '/conta', ['err', 'As senhas novas não conferem.']);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), user.id);
  redirect(res, '/conta', ['ok', 'Senha alterada!']);
});

// ---------------------------------------------------------------- rotas: participante

// Horário do primeiro jogo cadastrado no bolão (usado no prazo "antes do primeiro jogo")
const FIRST_KICKOFF = '(SELECT MIN(mm.kickoff_at) FROM matches mm WHERE mm.pool_id = p.id) AS first_kickoff';

// Tentativas erradas de senha de bolão: 5 erros bloqueiam por 10 minutos
const joinAttempts = new Map();

async function poolForUser(poolId, user) {
  const pool = await get(`SELECT p.*, ${FIRST_KICKOFF} FROM pools p WHERE p.id = ?`, poolId);
  if (!pool) return null;
  const member = await get('SELECT paid FROM pool_members WHERE pool_id = ? AND user_id = ?', poolId, user.id);
  return member || user.is_admin ? { pool, member: !!member, paid: !!(member && member.paid) } : null;
}

// Participar de um bolão aberto
route('POST', '/boloes/:id/entrar', async ({ res, user, params, body }) => {
  const pool = await get('SELECT * FROM pools WHERE id = ? AND open_join = 1', params.id);
  if (!pool) return redirect(res, '/boloes', ['err', 'Esse bolão não está aberto para entrada. Fale com o administrador.']);
  if (pool.join_password) {
    const key = `${user.id}:${pool.id}`;
    const at = joinAttempts.get(key);
    if (at && at.count >= 5 && at.until > Date.now()) {
      return redirect(res, '/boloes#disponiveis', ['err', 'Muitas tentativas erradas. Espere 10 minutos ou peça a senha ao administrador.']);
    }
    if (String(body.password ?? '').trim() !== pool.join_password) {
      const next = at && at.until > Date.now() ? at.count + 1 : 1;
      joinAttempts.set(key, { count: next, until: Date.now() + 10 * 60000 });
      return redirect(res, '/boloes#disponiveis', ['err', `Senha do bolão ${pool.name} incorreta.`]);
    }
    joinAttempts.delete(key);
  }
  await run(ADD_MEMBER, pool.id, user.id);
  redirect(res, `/boloes/${pool.id}`, ['ok', pool.require_payment
    ? `Você entrou no ${pool.name}! Já pode palpitar. Seus palpites passam a valer quando o pagamento for confirmado.`
    : `Você entrou no ${pool.name}! Já pode palpitar.`]);
});

route('GET', '/boloes', async ({ res, user, flash }) => {
  const pools = await all(`SELECT p.*, ${FIRST_KICKOFF}, pm.paid FROM pools p JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = ?
                           ORDER BY p.name`, user.id);
  const matches = await all(`SELECT m.*, (x.user_id IS NOT NULL) AS has_pred
                             FROM matches m JOIN pool_members pm ON pm.pool_id = m.pool_id AND pm.user_id = ?
                             LEFT JOIN predictions x ON x.match_id = m.id AND x.user_id = ?`, user.id, user.id);
  const summary = { points: 0, exact: 0, pending: 0, main: null };
  for (const p of pools) {
    const open = matches.filter(m => m.pool_id === p.id && V.matchStatus(m, p).key === 'open');
    p.open_count = open.length;
    p.pending_count = open.filter(m => !m.has_pred).length;
    const ranking = await computeRanking(p);
    const me = ranking.find(r => r.id === user.id) || { pos: 0, points: 0, exact: 0 };
    Object.assign(p, { members: ranking.length, pos: me.pos, points: me.points, exact: me.exact,
      ranked: matches.some(m => m.pool_id === p.id && m.home_score != null) });
    summary.points += me.points; summary.exact += me.exact; summary.pending += p.pending_count;
  }
  // Destaque: o bolão com mais palpites pendentes; senão, o primeiro
  const main = [...pools].sort((a, b) => b.pending_count - a.pending_count)[0];
  if (main) summary.main = { ...main, pending: main.pending_count, open: main.open_count };
  const available = await all(`SELECT p.*, (SELECT COUNT(*)::int FROM pool_members x WHERE x.pool_id = p.id) AS members
    FROM pools p WHERE p.open_join = 1
    AND NOT EXISTS (SELECT 1 FROM pool_members pm WHERE pm.pool_id = p.id AND pm.user_id = ?) ORDER BY p.name`, user.id);
  send(res, 200, V.memberHome({ user, flash, pools, summary, available }));
});

route('GET', '/boloes/:id', async ({ res, user, params, flash }) => {
  const access = await poolForUser(params.id, user);
  if (!access) return send(res, 404, V.messagePage({ user, title: 'Bolão não encontrado', msg: 'Você não participa deste bolão.' }));
  const { pool } = access;
  if (!access.member) return redirect(res, `/admin/boloes/${pool.id}`);
  const matches = await all(`SELECT m.*, p.home AS my_home, p.away AS my_away
                       FROM matches m LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
                       WHERE m.pool_id = ? ORDER BY m.kickoff_at, m.id`, user.id, pool.id);
  for (const m of matches) m.points = scorePrediction({ home: m.my_home, away: m.my_away }, m, pool);
  // Fechados: mais recentes primeiro
  matches.sort((a, b) => (a.kickoff_at || '9999').localeCompare(b.kickoff_at || '9999') || a.id - b.id);
  const open = matches.filter(m => V.matchStatus(m, pool).key === 'open');
  const closed = matches.filter(m => V.matchStatus(m, pool).key !== 'open').reverse();
  send(res, 200, V.memberPool({ user, flash, pool, matches: [...open, ...closed], ranking: await computeRanking(pool),
    members: await poolMembers(pool), paid: access.paid }));
});

route('POST', '/boloes/:id/palpites', async ({ res, user, params, body }) => {
  const access = await poolForUser(params.id, user);
  if (!access || !access.member) return redirect(res, '/boloes', ['err', 'Você não participa deste bolão.']);
  const { pool } = access;
  const matches = await all('SELECT * FROM matches WHERE pool_id = ?', params.id);
  let saved = 0, late = 0, invalid = 0;
  await tx(async ({ run }) => {
    for (const m of matches) {
      const hk = `h_${m.id}`, ak = `a_${m.id}`;
      if (!(hk in body) && !(ak in body)) continue;
      const home = intOrNull(body[hk]), away = intOrNull(body[ak]);
      if (home === null && away === null) continue;
      if (home == null || away == null) { invalid++; continue; }
      if (Date.now() >= V.closesAt(m, pool)) { late++; continue; }
      await run(`INSERT INTO predictions (match_id, user_id, home, away) VALUES (?, ?, ?, ?)
           ON CONFLICT (match_id, user_id) DO UPDATE SET home = excluded.home, away = excluded.away, updated_at = now()`,
        m.id, user.id, home, away);
      saved++;
    }
  });
  const msgs = [];
  if (saved) msgs.push(`${saved} palpite(s) salvo(s).`);
  if (late) msgs.push(`${late} jogo(s) já passaram do prazo e não aceitam mais palpite.`);
  if (invalid) msgs.push(`${invalid} palpite(s) incompleto(s) ou inválido(s) foram ignorados.`);
  redirect(res, `/boloes/${params.id}`, [late || invalid ? 'err' : 'ok', msgs.join(' ') || 'Nenhum palpite enviado.']);
});

// Tabela com os palpites de todos nos jogos que já fecharam + classificação
route('GET', '/boloes/:id/galera', async ({ res, user, params }) => {
  const access = await poolForUser(params.id, user);
  if (!access) return send(res, 404, V.messagePage({ user, title: 'Bolão não encontrado', msg: 'Você não participa deste bolão.' }));
  const { pool } = access;
  const ranking = await computeRanking(pool);
  const pending = (await poolMembers(pool)).filter(m => !m.counts);
  const columns = [...ranking, ...pending.map(m => ({ id: m.id, name: m.name, points: null, unconfirmed: true }))];
  const matches = (await all('SELECT * FROM matches WHERE pool_id = ? ORDER BY kickoff_at DESC, id DESC', pool.id))
    .filter(m => V.matchStatus(m, pool).key !== 'open');
  const preds = await all(`SELECT p.match_id, p.user_id, p.home, p.away FROM predictions p
                           JOIN matches m ON m.id = p.match_id WHERE m.pool_id = ?`, pool.id);
  const byKey = new Map(preds.map(p => [`${p.match_id}:${p.user_id}`, p]));
  const grid = matches.map(m => ({
    match: m,
    cells: columns.map(u => {
      const p = byKey.get(`${m.id}:${u.id}`);
      return p ? { home: p.home, away: p.away, points: u.unconfirmed ? null : scorePrediction(p, m, pool), unconfirmed: !!u.unconfirmed } : null;
    }),
  }));
  const openCount = (await all('SELECT * FROM matches WHERE pool_id = ?', pool.id))
    .filter(m => V.matchStatus(m, pool).key === 'open').length;
  send(res, 200, V.poolGrid({ user, pool, ranking, columns, grid, openCount, member: access.member }));
});

// Ranking geral: soma dos pontos de todos os bolões
route('GET', '/ranking', async ({ res, user }) => {
  const pools = await all('SELECT * FROM pools ORDER BY created_at');
  const total = new Map();
  const newRow = (id, name, carry) => ({ id, name, carry, points: carry, exact: 0, result: 0, byPool: {} });
  // Pontos de rodadas anteriores, lançados pelo admin ou pela importação
  for (const u of await all('SELECT id, name, carry_points FROM users WHERE carry_points <> 0')) {
    total.set(u.id, newRow(u.id, u.name, u.carry_points));
  }
  const carryOf = new Map((await all('SELECT id, carry_points FROM users')).map(u => [u.id, u.carry_points]));
  for (const pool of pools) {
    for (const r of await computeRanking(pool)) {
      const t = total.get(r.id) || newRow(r.id, r.name, carryOf.get(r.id) || 0);
      t.points += r.points; t.exact += r.exact; t.result += r.result;
      t.byPool[pool.id] = r.points;
      total.set(r.id, t);
    }
  }
  send(res, 200, V.generalRanking({ user, pools, ranking: rankRows([...total.values()]) }));
});

route('GET', '/boloes/:id/jogos/:mid', async ({ res, user, params }) => {
  const access = await poolForUser(params.id, user);
  const match = access && await get('SELECT * FROM matches WHERE id = ? AND pool_id = ?', params.mid, params.id);
  if (!match) return send(res, 404, V.messagePage({ user, title: 'Jogo não encontrado', msg: 'Esse jogo não existe ou você não tem acesso.' }));
  if (!user.is_admin && V.matchStatus(match, access.pool).key === 'open') {
    return send(res, 403, V.messagePage({ user, title: 'Ainda não', msg: 'Os palpites da galera só aparecem depois que os palpites desse jogo fecham.' }));
  }
  const rows = await all(`SELECT u.id AS user_id, u.name, p.home, p.away, pm.paid
                    FROM pool_members pm JOIN users u ON u.id = pm.user_id
                    LEFT JOIN predictions p ON p.match_id = ? AND p.user_id = u.id
                    WHERE pm.pool_id = ? ORDER BY u.name`, match.id, params.id);
  for (const r of rows) {
    r.counts = !access.pool.require_payment || !!r.paid;
    r.points = r.counts ? scorePrediction(r, match, access.pool) : null;
  }
  rows.sort((a, b) => (b.counts - a.counts) || (b.points ?? -1) - (a.points ?? -1) || a.name.localeCompare(b.name, 'pt-BR'));
  send(res, 200, V.matchPredictions({ user, pool: access.pool, match, rows }));
});

// ---------------------------------------------------------------- rotas: admin

const ADMIN = { admin: true };
// Adiciona (bolão, participante) se ambos existirem; ignora se já for membro.
const ADD_MEMBER = `INSERT INTO pool_members (pool_id, user_id)
  SELECT p.id, u.id FROM pools p, users u WHERE p.id = ?::int AND u.id = ?::int
  ON CONFLICT DO NOTHING`;

route('GET', '/admin', ADMIN, async ({ res, user, flash }) => {
  const users = await all(`SELECT u.*, (SELECT COUNT(*)::int FROM pool_members pm WHERE pm.user_id = u.id) AS pools
                     FROM users u ORDER BY u.is_admin DESC, u.name`);
  const pools = await all(`SELECT p.*, (SELECT COUNT(*)::int FROM pool_members pm WHERE pm.pool_id = p.id) AS members,
                     (SELECT COUNT(*)::int FROM matches m WHERE m.pool_id = p.id) AS matches
                     FROM pools p ORDER BY p.created_at DESC`);
  const allPools = new Map((await all(`SELECT p.*, ${FIRST_KICKOFF} FROM pools p`)).map(p => [p.id, p]));
  const matches = await all('SELECT * FROM matches');
  const stats = {
    matches: matches.length,
    awaiting: matches.filter(m => V.matchStatus(m, allPools.get(m.pool_id)).key === 'live').length,
    predictions: (await get('SELECT COUNT(*)::int AS n FROM predictions')).n,
  };
  send(res, 200, V.adminHome({ user, flash, users, pools, stats }));
});

// --- participantes

route('POST', '/admin/usuarios', ADMIN, async ({ res, body }) => {
  const name = str(body.name, 60), username = str(body.username, 30), password = String(body.password || '');
  if (!name || !/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return redirect(res, '/admin', ['err', 'Nome ou usuário inválido.']);
  if (password.length < 4) return redirect(res, '/admin', ['err', 'A senha precisa ter pelo menos 4 caracteres.']);
  if (await get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) return redirect(res, '/admin', ['err', `O usuário "${username}" já existe.`]);
  await tx(async ({ get, run }) => {
    const { id } = await get('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?) RETURNING id', username, name, hashPassword(password));
    for (const pid of asIds(body.pools)) await run(ADD_MEMBER, pid, id);
  });
  redirect(res, '/admin', ['ok', `Participante ${name} criado. Passe para ele(a): usuário "${username}" e a senha que você definiu.`]);
});

route('GET', '/admin/usuarios/:id', ADMIN, async ({ res, user, params, flash }) => {
  const target = await get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return redirect(res, '/admin', ['err', 'Participante não encontrado.']);
  const pools = await all('SELECT id, name FROM pools ORDER BY name');
  const memberOf = new Set((await all('SELECT pool_id FROM pool_members WHERE user_id = ?', target.id)).map(r => r.pool_id));
  send(res, 200, V.adminUser({ user, flash, target, pools, memberOf }));
});

route('POST', '/admin/usuarios/:id', ADMIN, async ({ res, user, params, body }) => {
  const target = await get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return redirect(res, '/admin', ['err', 'Participante não encontrado.']);
  const name = str(body.name, 60);
  if (!name) return redirect(res, `/admin/usuarios/${target.id}`, ['err', 'Informe o nome.']);
  const password = String(body.password || '');
  if (password && password.length < 4) return redirect(res, `/admin/usuarios/${target.id}`, ['err', 'A senha precisa ter pelo menos 4 caracteres.']);
  const active = target.id === user.id ? 1 : (body.active ? 1 : 0);
  const carry = intOrNull(body.carry_points ?? '', -9999, 99999);
  if (carry === undefined) return redirect(res, `/admin/usuarios/${target.id}`, ['err', 'Pontos anteriores inválidos.']);
  await tx(async ({ all, run }) => {
    await run('UPDATE users SET name = ?, active = ?, carry_points = ? WHERE id = ?', name, active, carry ?? 0, target.id);
    if (password) {
      await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), target.id);
      if (target.id !== user.id) await run('DELETE FROM sessions WHERE user_id = ?', target.id);
    }
    if (!active) await run('DELETE FROM sessions WHERE user_id = ?', target.id);
    const keep = new Set(asIds(body.pools));
    for (const { pool_id } of await all('SELECT pool_id FROM pool_members WHERE user_id = ?', target.id)) {
      if (!keep.has(pool_id)) await run('DELETE FROM pool_members WHERE pool_id = ? AND user_id = ?', pool_id, target.id);
    }
    for (const pid of keep) await run(ADD_MEMBER, pid, target.id);
  });
  redirect(res, `/admin/usuarios/${target.id}`, ['ok', 'Alterações salvas.']);
});

route('POST', '/admin/usuarios/:id/excluir', ADMIN, async ({ res, user, params }) => {
  if (params.id === user.id) return redirect(res, '/admin', ['err', 'Você não pode excluir a si mesmo.']);
  await run('DELETE FROM users WHERE id = ?', params.id);
  redirect(res, '/admin', ['ok', 'Participante excluído.']);
});

// --- zerar o app: apaga todos os bolões e todos os usuários que não são administradores

route('POST', '/admin/zerar', ADMIN, async ({ res, body }) => {
  if (String(body.confirm || '').trim().toUpperCase() !== 'ZERAR') {
    return redirect(res, '/admin#zerar', ['err', 'Nada foi apagado. Para zerar o app, digite ZERAR no campo de confirmação.']);
  }
  const counts = await tx(async ({ get, run }) => {
    const pools = (await get('SELECT COUNT(*)::int AS n FROM pools')).n;
    const users = (await get('SELECT COUNT(*)::int AS n FROM users WHERE is_admin = 0')).n;
    await run('DELETE FROM pools');                    // jogos, palpites e participações vão junto
    await run('DELETE FROM users WHERE is_admin = 0'); // sessões vão junto
    await run('UPDATE users SET carry_points = 0');
    return { pools, users };
  });
  redirect(res, '/admin', ['ok', `App zerado: ${counts.pools} bolão(ões) e ${counts.users} usuário(s) apagados. Só os administradores ficaram.`]);
});

// --- importar rodada a partir do relatório do WhatsApp

route('GET', '/admin/importar', ADMIN, ({ res, user, flash }) => send(res, 200, V.importPage({ user, flash })));

// Cria bolão, jogos, participantes e palpites a partir de um relatório já lido.
// password: senha inicial dos participantes novos (null = senha aleatória; o admin define depois).
async function importReport({ report, name, pe, pr, kickoff, password, seedKey = null }) {
  const startedAt = new Date(Date.now() - 45 * 60000).toISOString();
  const generalByName = new Map(report.general.map(g => [g.name.toUpperCase(), g.points]));
  const created = [];
  let predCount = 0, skipped = 0;
  const poolId = await tx(async ({ get, run }) => {
    if (seedKey) await run('INSERT INTO imports (key) VALUES (?)', seedKey);
    const { id: pid } = await get(`INSERT INTO pools (name, description, points_exact, points_result, open_join, require_payment)
      VALUES (?, ?, ?, ?, 1, 1) RETURNING id`, name, report.title ? `Importado de: ${report.title}` : '', pe, pr);
    const matchIds = new Map();
    for (const m of report.matches) {
      const finished = m.finished && m.home_score != null;
      const live = !finished && m.started && m.home_score != null;
      const { id } = await get(`INSERT INTO matches (pool_id, home_team, away_team, kickoff_at, home_score, away_score, live)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, pid, m.home_team, m.away_team, m.started ? startedAt : kickoff,
        finished || live ? m.home_score : null, finished || live ? m.away_score : null, live ? 1 : 0);
      matchIds.set(`${m.home_abbr}-${m.away_abbr}`, id);
    }
    for (const p of report.people) {
      const display = titleCase(p.name);
      let u = await get('SELECT id FROM users WHERE lower(name) = lower(?) OR lower(username) = lower(?)', display, slug(display));
      if (!u) {
        let username = slug(display), n = 2;
        while (await get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) username = `${slug(display)}${n++}`;
        const pw = password || crypto.randomBytes(12).toString('base64url');
        u = await get('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?) RETURNING id', username, display, hashPassword(pw));
        created.push(username);
      }
      await run('INSERT INTO pool_members (pool_id, user_id, paid) VALUES (?, ?, 1) ON CONFLICT (pool_id, user_id) DO UPDATE SET paid = 1', pid, u.id);
      const general = generalByName.get(p.name.toUpperCase());
      if (general != null) await run('UPDATE users SET carry_points = ? WHERE id = ?', general - p.round_points, u.id);
      for (const pr of p.preds) {
        const mid = matchIds.get(`${pr.home_abbr}-${pr.away_abbr}`);
        if (!mid) { skipped++; continue; }
        await run(`INSERT INTO predictions (match_id, user_id, home, away) VALUES (?, ?, ?, ?)
          ON CONFLICT (match_id, user_id) DO UPDATE SET home = excluded.home, away = excluded.away`, mid, u.id, pr.home, pr.away);
        predCount++;
      }
    }
    return pid;
  });
  return { poolId, created, predCount, skipped };
}

const defaultPoolName = report => {
  const parts = report.title.split('—').map(s => s.trim()).filter(Boolean);
  return (parts.length > 1 ? titleCase(parts.slice(1).join(' — ')) : titleCase(report.title)) || 'Rodada importada';
};

route('POST', '/admin/importar', ADMIN, async ({ res, user, body }) => {
  const fail = error => send(res, 400, V.importPage({ user, flash: { type: 'err', msg: error }, form: body }));
  const report = parseReport(body.text);
  if (!report.matches.length) return fail('Não encontrei os jogos. O texto precisa ter a parte *RESULTADOS* com linhas como "CFC x SAN — Coritiba x Santos (não iniciado)".');
  if (!report.people.length) return fail('Não encontrei os palpites. O texto precisa ter a parte *PONTOS DE CADA UM*.');
  const name = str(body.name, 80) || defaultPoolName(report);
  const pe = intOrNull(body.points_exact ?? '4', 0, 100), pr = intOrNull(body.points_result ?? '1', 0, 100);
  if (pe == null || pr == null) return fail('Pontuação inválida.');
  const kickoff = localInputToISO(body.kickoff);
  if (report.matches.some(m => !m.started) && !kickoff) return fail('Informe a data e hora dos jogos que ainda não começaram.');
  const password = String(body.password || '');
  if (password.length < 4) return fail('A senha inicial dos novos participantes precisa ter pelo menos 4 caracteres.');

  const r = await importReport({ report, name, pe, pr, kickoff, password });
  const msg = [`Rodada importada: ${report.matches.length} jogos, ${report.people.length} participantes, ${r.predCount} palpites.`];
  if (r.created.length) msg.push(`Novos usuários (senha inicial que você definiu): ${r.created.join(', ')}.`);
  if (report.general.length) msg.push('Pontos de rodadas anteriores lançados no Ranking geral.');
  if (r.skipped) msg.push(`${r.skipped} palpite(s) ignorado(s) por jogo não reconhecido.`);
  redirect(res, `/admin/boloes/${r.poolId}`, ['ok', msg.join(' ')]);
});

// Rodadas que vêm junto com o código (pasta seeds/): cada arquivo é importado uma única vez
// quando o site inicia. Se o admin apagar o bolão depois, ele não volta.
const SEEDS_DIR = process.env.SEEDS_DIR || path.join(__dirname, 'seeds');
async function runSeeds(dir = SEEDS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  const done = [];
  for (const f of files) {
    if (await get('SELECT 1 FROM imports WHERE key = ?', f)) continue;
    const seed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const report = parseReport(seed.text);
    if (!report.matches.length || !report.people.length) { console.warn(`Seed ${f}: relatório sem jogos ou palpites, ignorado.`); continue; }
    const r = await importReport({
      report, name: seed.name || defaultPoolName(report), pe: seed.points_exact ?? 4, pr: seed.points_result ?? 1,
      kickoff: localInputToISO(seed.kickoff) || new Date(Date.now() + 864e5).toISOString(), password: null, seedKey: f,
    });
    console.log(`Seed ${f}: bolão "${seed.name}" criado (${r.predCount} palpites, ${r.created.length} usuário(s) novo(s)).`);
    done.push({ file: f, ...r });
  }
  return done;
}

// --- bolões

function poolFields(body) {
  const points_exact = intOrNull(body.points_exact, 0, 100);
  const points_result = intOrNull(body.points_result, 0, 100);
  const close_minutes = intOrNull(body.close_minutes ?? '0', 0, 1440) ?? 0;
  const deadlineRaw = String(body.deadline ?? '').trim();
  const deadline_at = deadlineRaw ? localInputToISO(deadlineRaw) : null;
  const roundStartRaw = String(body.round_start ?? '').trim();
  const valid = !!(str(body.name, 80) && points_exact != null && points_result != null && close_minutes != null
    && (!deadlineRaw || deadline_at) && (!roundStartRaw || localInputToISO(roundStartRaw)));
  return { valid, name: str(body.name, 80), description: str(body.description, 200), points_exact, points_result, close_minutes, deadline_at,
    open_join: body.open_join ? 1 : 0, require_payment: body.require_payment ? 1 : 0,
    join_password: str(body.join_password, 40), close_mode: body.close_mode === 'first' ? 'first' : 'each',
    round_start_at: roundStartRaw ? localInputToISO(roundStartRaw) : null,
    entry_fee: str(body.entry_fee, 30), pix_key: str(body.pix_key, 120) };
}

route('POST', '/admin/boloes', ADMIN, async ({ res, body }) => {
  const f = poolFields(body);
  if (!f.valid) return redirect(res, '/admin', ['err', 'Preencha nome, pontuação e prazo corretamente.']);
  const { id } = await get(`INSERT INTO pools (name, description, points_exact, points_result, close_minutes, deadline_at,
                              open_join, require_payment, entry_fee, pix_key, join_password, close_mode, round_start_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    f.name, f.description, f.points_exact, f.points_result, f.close_minutes, f.deadline_at,
    f.open_join, f.require_payment, f.entry_fee, f.pix_key, f.join_password, f.close_mode, f.round_start_at);
  redirect(res, `/admin/boloes/${id}`, ['ok', 'Bolão criado! Agora adicione os jogos e os participantes.']);
});

route('GET', '/admin/boloes/:id', ADMIN, async ({ res, user, params, flash }) => {
  const pool = await get(`SELECT p.*, ${FIRST_KICKOFF} FROM pools p WHERE p.id = ?`, params.id);
  if (!pool) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  const users = await all('SELECT id, name, username FROM users WHERE active = 1 ORDER BY name');
  const memberIds = new Set((await all('SELECT user_id FROM pool_members WHERE pool_id = ?', pool.id)).map(r => r.user_id));
  const matches = await all(`SELECT m.*, (SELECT COUNT(*)::int FROM predictions p WHERE p.match_id = m.id) AS pred_count
                       FROM matches m WHERE m.pool_id = ? ORDER BY m.kickoff_at, m.id`, pool.id);
  send(res, 200, V.adminPool({ user, flash, pool, users, memberIds, matches, ranking: await computeRanking(pool),
    members: await poolMembers(pool) }));
});

// Confirmar / desfazer pagamento de um participante
route('POST', '/admin/boloes/:id/pagamento/:uid', ADMIN, async ({ res, params, body }) => {
  const paid = body.paid === '1' ? 1 : 0;
  const r = await run('UPDATE pool_members SET paid = ? WHERE pool_id = ? AND user_id = ?', paid, params.id, params.uid);
  const u = await get('SELECT name FROM users WHERE id = ?', params.uid);
  if (!u || !(r.rowCount ?? r.affectedRows)) return redirect(res, `/admin/boloes/${params.id}`, ['err', 'Participante não encontrado neste bolão.']);
  redirect(res, `/admin/boloes/${params.id}#pagamentos`, ['ok', paid ? `Pagamento de ${u.name} confirmado. Os palpites dele(a) já valem.` : `Confirmação de ${u.name} desfeita.`]);
});

route('POST', '/admin/boloes/:id', ADMIN, async ({ res, params, body }) => {
  const f = poolFields(body);
  if (!f.valid) return redirect(res, `/admin/boloes/${params.id}`, ['err', 'Preencha nome, pontuação e prazo corretamente.']);
  await run(`UPDATE pools SET name = ?, description = ?, points_exact = ?, points_result = ?, close_minutes = ?, deadline_at = ?,
             open_join = ?, require_payment = ?, entry_fee = ?, pix_key = ?, join_password = ?, close_mode = ?, round_start_at = ?
             WHERE id = ?`,
    f.name, f.description, f.points_exact, f.points_result, f.close_minutes, f.deadline_at,
    f.open_join, f.require_payment, f.entry_fee, f.pix_key, f.join_password, f.close_mode, f.round_start_at, params.id);
  redirect(res, `/admin/boloes/${params.id}`, ['ok', 'Configurações salvas.']);
});

route('POST', '/admin/boloes/:id/excluir', ADMIN, async ({ res, params }) => {
  await run('DELETE FROM pools WHERE id = ?', params.id);
  redirect(res, '/admin', ['ok', 'Bolão excluído.']);
});

route('POST', '/admin/boloes/:id/membros', ADMIN, async ({ res, params, body }) => {
  if (!await get('SELECT 1 FROM pools WHERE id = ?', params.id)) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  await tx(async ({ all, run }) => {
    const keep = new Set(asIds(body.users));
    for (const { user_id } of await all('SELECT user_id FROM pool_members WHERE pool_id = ?', params.id)) {
      if (!keep.has(user_id)) await run('DELETE FROM pool_members WHERE pool_id = ? AND user_id = ?', params.id, user_id);
    }
    for (const uid of keep) await run(ADD_MEMBER, params.id, uid);
  });
  redirect(res, `/admin/boloes/${params.id}`, ['ok', 'Participantes atualizados.']);
});

// Horário do jogo: opcional quando o bolão fecha todos os palpites antes do primeiro jogo da rodada
function kickoffFrom(body, pool) {
  const raw = String(body.kickoff ?? '').trim();
  if (!raw) {
    return pool.close_mode === 'first' ? { ok: true, value: null }
      : { ok: false, msg: 'Informe a data e hora do jogo (ou, nas configurações do bolão, feche todos os palpites antes do primeiro jogo).' };
  }
  const value = localInputToISO(raw);
  return value ? { ok: true, value } : { ok: false, msg: 'Data e hora do jogo inválidas.' };
}

route('POST', '/admin/boloes/:id/jogos', ADMIN, async ({ res, params, body }) => {
  const pool = await get('SELECT * FROM pools WHERE id = ?', params.id);
  if (!pool) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  const home = str(body.home_team, 50), away = str(body.away_team, 50);
  if (!home || !away) return redirect(res, `/admin/boloes/${params.id}`, ['err', 'Preencha os dois times.']);
  const k = kickoffFrom(body, pool);
  if (!k.ok) return redirect(res, `/admin/boloes/${params.id}`, ['err', k.msg]);
  const kickoff = k.value;
  await run('INSERT INTO matches (pool_id, home_team, away_team, kickoff_at) VALUES (?, ?, ?, ?)', params.id, home, away, kickoff);
  redirect(res, `/admin/boloes/${params.id}`, ['ok', `Jogo ${home} × ${away} adicionado.`]);
});

route('POST', '/admin/jogos/:id', ADMIN, async ({ res, params, body }) => {
  const m = await get('SELECT * FROM matches WHERE id = ?', params.id);
  if (!m) return redirect(res, '/admin', ['err', 'Jogo não encontrado.']);
  const back = `/admin/boloes/${m.pool_id}`;
  const home = str(body.home_team, 50), away = str(body.away_team, 50);
  const hs = intOrNull(body.home_score), as = intOrNull(body.away_score);
  if (!home || !away) return redirect(res, back, ['err', 'Preencha os dois times.']);
  const k = kickoffFrom(body, await get('SELECT * FROM pools WHERE id = ?', m.pool_id));
  if (!k.ok) return redirect(res, back, ['err', k.msg]);
  const kickoff = k.value;
  if (hs === undefined || as === undefined || (hs === null) !== (as === null)) {
    return redirect(res, back, ['err', 'Placar inválido: preencha os gols dos dois times (ou deixe os dois em branco).']);
  }
  const live = body.live && hs != null ? 1 : 0;
  await run('UPDATE matches SET home_team = ?, away_team = ?, kickoff_at = ?, home_score = ?, away_score = ?, live = ? WHERE id = ?',
    home, away, kickoff, hs, as, live, m.id);
  redirect(res, back, ['ok', hs == null ? 'Jogo atualizado.'
    : live ? `Placar ao vivo atualizado: ${home} ${hs} × ${as} ${away}.` : `Resultado salvo: ${home} ${hs} × ${as} ${away}.`]);
});

route('POST', '/admin/jogos/:id/excluir', ADMIN, async ({ res, params }) => {
  const m = await get('SELECT pool_id FROM matches WHERE id = ?', params.id);
  if (!m) return redirect(res, '/admin', ['err', 'Jogo não encontrado.']);
  await run('DELETE FROM matches WHERE id = ?', params.id);
  redirect(res, `/admin/boloes/${m.pool_id}`, ['ok', 'Jogo excluído.']);
});

// ---------------------------------------------------------------- start

if (require.main === module) {
  (async () => {
    await init();
    await ensureAdmin();
    await runSeeds().catch(err => console.error('Falha ao importar seeds:', err));
    server.listen(PORT, () => console.log(`Bolão rodando em http://localhost:${PORT}`));
  })().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
}

module.exports = { server, scorePrediction, localInputToISO, runSeeds };
