'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, tx, hashPassword, verifyPassword, ensureAdmin } = require('./db');
const V = require('./views');

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

function computeRanking(pool) {
  const members = all(`SELECT u.id, u.name FROM pool_members pm JOIN users u ON u.id = pm.user_id
                       WHERE pm.pool_id = ? ORDER BY u.name`, pool.id);
  const preds = all(`SELECT p.user_id, p.home, p.away, m.home_score, m.away_score
                     FROM predictions p JOIN matches m ON m.id = p.match_id
                     WHERE m.pool_id = ? AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL`, pool.id);
  const table = new Map(members.map(u => [u.id, { ...u, points: 0, exact: 0, result: 0 }]));
  for (const p of preds) {
    const row = table.get(p.user_id);
    if (!row) continue;
    const pts = scorePrediction(p, p, pool);
    row.points += pts;
    if (pts === pool.points_exact && p.home === p.home_score && p.away === p.away_score) row.exact++;
    else if (pts > 0) row.result++;
  }
  const rows = [...table.values()].sort((a, b) =>
    b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name, 'pt-BR'));
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.pos = prev && prev.points === r.points && prev.exact === r.exact ? prev.pos : i + 1;
  });
  return rows;
}

// ---------------------------------------------------------------- sessões

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    token, userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = get(`SELECT u.id, u.username, u.name, u.is_admin, u.active, s.expires_at
                   FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return row;
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
      const user = currentUser(req);
      if (!r.opts.public && !user) return redirect(res, '/login');
      if (r.opts.admin && !user.is_admin) return send(res, 403, V.messagePage({ user, title: 'Acesso negado', msg: 'Essa área é só para o administrador.' }));
      const body = req.method === 'POST' ? await readBody(req) : {};
      return await r.handler({ req, res, url, params, body, user, flash: flashFrom(url) });
    }
    send(res, 404, V.messagePage({ user: currentUser(req), title: 'Página não encontrada', msg: 'Não achamos o que você procurava.' }));
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

route('POST', '/login', { public: true }, ({ res, body }) => {
  const username = str(body.username, 50);
  const u = get('SELECT * FROM users WHERE username = ?', username);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
    return send(res, 401, V.loginPage({ error: 'Usuário ou senha incorretos.', username }));
  }
  if (!u.active) return send(res, 403, V.loginPage({ error: 'Sua conta está desativada. Fale com o administrador.', username }));
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  createSession(res, u.id);
  redirect(res, u.is_admin ? '/admin' : '/boloes');
});

route('POST', '/logout', { public: true }, ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  redirect(res, '/login');
});

route('GET', '/conta', ({ res, user, flash }) => send(res, 200, V.accountPage({ user, flash })));

route('POST', '/conta/senha', ({ res, user, body }) => {
  const u = get('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!verifyPassword(String(body.current || ''), u.password_hash)) return redirect(res, '/conta', ['err', 'Senha atual incorreta.']);
  const pw = String(body.password || '');
  if (pw.length < 4) return redirect(res, '/conta', ['err', 'A nova senha precisa ter pelo menos 4 caracteres.']);
  if (pw !== body.password2) return redirect(res, '/conta', ['err', 'As senhas novas não conferem.']);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), user.id);
  redirect(res, '/conta', ['ok', 'Senha alterada!']);
});

// ---------------------------------------------------------------- rotas: participante

function poolForUser(poolId, user) {
  const pool = get('SELECT * FROM pools WHERE id = ?', poolId);
  if (!pool) return null;
  const member = get('SELECT 1 FROM pool_members WHERE pool_id = ? AND user_id = ?', poolId, user.id);
  return member || user.is_admin ? { pool, member: !!member } : null;
}

route('GET', '/boloes', ({ res, user, flash }) => {
  const now = new Date().toISOString();
  const pools = all(`
    SELECT p.*,
      (SELECT COUNT(*) FROM matches m WHERE m.pool_id = p.id AND m.kickoff_at > ?) AS open_count,
      (SELECT COUNT(*) FROM matches m WHERE m.pool_id = p.id AND m.kickoff_at > ?
         AND NOT EXISTS (SELECT 1 FROM predictions x WHERE x.match_id = m.id AND x.user_id = ?)) AS pending_count
    FROM pools p JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = ?
    ORDER BY p.name`, now, now, user.id, user.id);
  send(res, 200, V.memberHome({ user, flash, pools }));
});

route('GET', '/boloes/:id', ({ res, user, params, flash }) => {
  const access = poolForUser(params.id, user);
  if (!access) return send(res, 404, V.messagePage({ user, title: 'Bolão não encontrado', msg: 'Você não participa deste bolão.' }));
  const { pool } = access;
  if (!access.member) return redirect(res, `/admin/boloes/${pool.id}`);
  const matches = all(`SELECT m.*, p.home AS my_home, p.away AS my_away
                       FROM matches m LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
                       WHERE m.pool_id = ? ORDER BY m.kickoff_at, m.id`, user.id, pool.id);
  for (const m of matches) m.points = scorePrediction({ home: m.my_home, away: m.my_away }, m, pool);
  // Fechados: mais recentes primeiro
  matches.sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at));
  const open = matches.filter(m => V.matchStatus(m).key === 'open');
  const closed = matches.filter(m => V.matchStatus(m).key !== 'open').reverse();
  send(res, 200, V.memberPool({ user, flash, pool, matches: [...open, ...closed], ranking: computeRanking(pool) }));
});

route('POST', '/boloes/:id/palpites', ({ res, user, params, body }) => {
  const access = poolForUser(params.id, user);
  if (!access || !access.member) return redirect(res, '/boloes', ['err', 'Você não participa deste bolão.']);
  const matches = all('SELECT * FROM matches WHERE pool_id = ?', params.id);
  let saved = 0, late = 0, invalid = 0;
  tx(() => {
    for (const m of matches) {
      const hk = `h_${m.id}`, ak = `a_${m.id}`;
      if (!(hk in body) && !(ak in body)) continue;
      const home = intOrNull(body[hk]), away = intOrNull(body[ak]);
      if (home === null && away === null) continue;
      if (home == null || away == null) { invalid++; continue; }
      if (Date.now() >= Date.parse(m.kickoff_at)) { late++; continue; }
      run(`INSERT INTO predictions (match_id, user_id, home, away) VALUES (?, ?, ?, ?)
           ON CONFLICT (match_id, user_id) DO UPDATE SET home = excluded.home, away = excluded.away, updated_at = datetime('now')`,
        m.id, user.id, home, away);
      saved++;
    }
  });
  const msgs = [];
  if (saved) msgs.push(`${saved} palpite(s) salvo(s).`);
  if (late) msgs.push(`${late} jogo(s) já começaram e não aceitam mais palpite.`);
  if (invalid) msgs.push(`${invalid} palpite(s) incompleto(s) ou inválido(s) foram ignorados.`);
  redirect(res, `/boloes/${params.id}`, [late || invalid ? 'err' : 'ok', msgs.join(' ') || 'Nenhum palpite enviado.']);
});

route('GET', '/boloes/:id/jogos/:mid', ({ res, user, params }) => {
  const access = poolForUser(params.id, user);
  const match = access && get('SELECT * FROM matches WHERE id = ? AND pool_id = ?', params.mid, params.id);
  if (!match) return send(res, 404, V.messagePage({ user, title: 'Jogo não encontrado', msg: 'Esse jogo não existe ou você não tem acesso.' }));
  if (!user.is_admin && V.matchStatus(match).key === 'open') {
    return send(res, 403, V.messagePage({ user, title: 'Ainda não', msg: 'Os palpites da galera só aparecem depois que o jogo começa.' }));
  }
  const rows = all(`SELECT u.id AS user_id, u.name, p.home, p.away
                    FROM pool_members pm JOIN users u ON u.id = pm.user_id
                    LEFT JOIN predictions p ON p.match_id = ? AND p.user_id = u.id
                    WHERE pm.pool_id = ? ORDER BY u.name`, match.id, params.id);
  for (const r of rows) r.points = scorePrediction(r, match, access.pool);
  rows.sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || a.name.localeCompare(b.name, 'pt-BR'));
  send(res, 200, V.matchPredictions({ user, pool: access.pool, match, rows }));
});

// ---------------------------------------------------------------- rotas: admin

const ADMIN = { admin: true };

route('GET', '/admin', ADMIN, ({ res, user, flash }) => {
  const users = all(`SELECT u.*, (SELECT COUNT(*) FROM pool_members pm WHERE pm.user_id = u.id) AS pools
                     FROM users u ORDER BY u.is_admin DESC, u.name`);
  const pools = all(`SELECT p.*, (SELECT COUNT(*) FROM pool_members pm WHERE pm.pool_id = p.id) AS members,
                     (SELECT COUNT(*) FROM matches m WHERE m.pool_id = p.id) AS matches
                     FROM pools p ORDER BY p.created_at DESC`);
  send(res, 200, V.adminHome({ user, flash, users, pools }));
});

// --- participantes

route('POST', '/admin/usuarios', ADMIN, ({ res, body }) => {
  const name = str(body.name, 60), username = str(body.username, 30), password = String(body.password || '');
  if (!name || !/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return redirect(res, '/admin', ['err', 'Nome ou usuário inválido.']);
  if (password.length < 4) return redirect(res, '/admin', ['err', 'A senha precisa ter pelo menos 4 caracteres.']);
  if (get('SELECT 1 FROM users WHERE username = ?', username)) return redirect(res, '/admin', ['err', `O usuário "${username}" já existe.`]);
  tx(() => {
    const { lastInsertRowid: id } = run('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)', username, name, hashPassword(password));
    for (const pid of asIds(body.pools)) run('INSERT OR IGNORE INTO pool_members (pool_id, user_id) SELECT id, ? FROM pools WHERE id = ?', id, pid);
  });
  redirect(res, '/admin', ['ok', `Participante ${name} criado. Passe para ele(a): usuário "${username}" e a senha que você definiu.`]);
});

route('GET', '/admin/usuarios/:id', ADMIN, ({ res, user, params, flash }) => {
  const target = get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return redirect(res, '/admin', ['err', 'Participante não encontrado.']);
  const pools = all('SELECT id, name FROM pools ORDER BY name');
  const memberOf = new Set(all('SELECT pool_id FROM pool_members WHERE user_id = ?', target.id).map(r => r.pool_id));
  send(res, 200, V.adminUser({ user, flash, target, pools, memberOf }));
});

route('POST', '/admin/usuarios/:id', ADMIN, ({ res, user, params, body }) => {
  const target = get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return redirect(res, '/admin', ['err', 'Participante não encontrado.']);
  const name = str(body.name, 60);
  if (!name) return redirect(res, `/admin/usuarios/${target.id}`, ['err', 'Informe o nome.']);
  const password = String(body.password || '');
  if (password && password.length < 4) return redirect(res, `/admin/usuarios/${target.id}`, ['err', 'A senha precisa ter pelo menos 4 caracteres.']);
  const active = target.id === user.id ? 1 : (body.active ? 1 : 0);
  tx(() => {
    run('UPDATE users SET name = ?, active = ? WHERE id = ?', name, active, target.id);
    if (password) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), target.id);
      if (target.id !== user.id) run('DELETE FROM sessions WHERE user_id = ?', target.id);
    }
    if (!active) run('DELETE FROM sessions WHERE user_id = ?', target.id);
    run('DELETE FROM pool_members WHERE user_id = ?', target.id);
    for (const pid of asIds(body.pools)) run('INSERT OR IGNORE INTO pool_members (pool_id, user_id) SELECT id, ? FROM pools WHERE id = ?', target.id, pid);
  });
  redirect(res, `/admin/usuarios/${target.id}`, ['ok', 'Alterações salvas.']);
});

route('POST', '/admin/usuarios/:id/excluir', ADMIN, ({ res, user, params }) => {
  if (params.id === user.id) return redirect(res, '/admin', ['err', 'Você não pode excluir a si mesmo.']);
  run('DELETE FROM users WHERE id = ?', params.id);
  redirect(res, '/admin', ['ok', 'Participante excluído.']);
});

// --- bolões

function poolFields(body) {
  const points_exact = intOrNull(body.points_exact, 0, 100);
  const points_result = intOrNull(body.points_result, 0, 100);
  return { name: str(body.name, 80), description: str(body.description, 200), points_exact, points_result };
}

route('POST', '/admin/boloes', ADMIN, ({ res, body }) => {
  const f = poolFields(body);
  if (!f.name || f.points_exact == null || f.points_result == null) return redirect(res, '/admin', ['err', 'Preencha nome e pontuação corretamente.']);
  const { lastInsertRowid } = run('INSERT INTO pools (name, description, points_exact, points_result) VALUES (?, ?, ?, ?)',
    f.name, f.description, f.points_exact, f.points_result);
  redirect(res, `/admin/boloes/${lastInsertRowid}`, ['ok', 'Bolão criado! Agora adicione os jogos e os participantes.']);
});

route('GET', '/admin/boloes/:id', ADMIN, ({ res, user, params, flash }) => {
  const pool = get('SELECT * FROM pools WHERE id = ?', params.id);
  if (!pool) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  const users = all('SELECT id, name, username FROM users WHERE active = 1 ORDER BY name');
  const memberIds = new Set(all('SELECT user_id FROM pool_members WHERE pool_id = ?', pool.id).map(r => r.user_id));
  const matches = all(`SELECT m.*, (SELECT COUNT(*) FROM predictions p WHERE p.match_id = m.id) AS pred_count
                       FROM matches m WHERE m.pool_id = ? ORDER BY m.kickoff_at, m.id`, pool.id);
  send(res, 200, V.adminPool({ user, flash, pool, users, memberIds, matches, ranking: computeRanking(pool) }));
});

route('POST', '/admin/boloes/:id', ADMIN, ({ res, params, body }) => {
  const f = poolFields(body);
  if (!f.name || f.points_exact == null || f.points_result == null) return redirect(res, `/admin/boloes/${params.id}`, ['err', 'Preencha nome e pontuação corretamente.']);
  run('UPDATE pools SET name = ?, description = ?, points_exact = ?, points_result = ? WHERE id = ?',
    f.name, f.description, f.points_exact, f.points_result, params.id);
  redirect(res, `/admin/boloes/${params.id}`, ['ok', 'Configurações salvas.']);
});

route('POST', '/admin/boloes/:id/excluir', ADMIN, ({ res, params }) => {
  run('DELETE FROM pools WHERE id = ?', params.id);
  redirect(res, '/admin', ['ok', 'Bolão excluído.']);
});

route('POST', '/admin/boloes/:id/membros', ADMIN, ({ res, params, body }) => {
  if (!get('SELECT 1 FROM pools WHERE id = ?', params.id)) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  tx(() => {
    run('DELETE FROM pool_members WHERE pool_id = ?', params.id);
    for (const uid of asIds(body.users)) run('INSERT OR IGNORE INTO pool_members (pool_id, user_id) SELECT ?, id FROM users WHERE id = ?', params.id, uid);
  });
  redirect(res, `/admin/boloes/${params.id}`, ['ok', 'Participantes atualizados.']);
});

route('POST', '/admin/boloes/:id/jogos', ADMIN, ({ res, params, body }) => {
  if (!get('SELECT 1 FROM pools WHERE id = ?', params.id)) return redirect(res, '/admin', ['err', 'Bolão não encontrado.']);
  const home = str(body.home_team, 50), away = str(body.away_team, 50), kickoff = localInputToISO(body.kickoff);
  if (!home || !away || !kickoff) return redirect(res, `/admin/boloes/${params.id}`, ['err', 'Preencha os dois times e a data/hora.']);
  run('INSERT INTO matches (pool_id, home_team, away_team, kickoff_at) VALUES (?, ?, ?, ?)', params.id, home, away, kickoff);
  redirect(res, `/admin/boloes/${params.id}`, ['ok', `Jogo ${home} × ${away} adicionado.`]);
});

route('POST', '/admin/jogos/:id', ADMIN, ({ res, params, body }) => {
  const m = get('SELECT * FROM matches WHERE id = ?', params.id);
  if (!m) return redirect(res, '/admin', ['err', 'Jogo não encontrado.']);
  const back = `/admin/boloes/${m.pool_id}`;
  const home = str(body.home_team, 50), away = str(body.away_team, 50), kickoff = localInputToISO(body.kickoff);
  const hs = intOrNull(body.home_score), as = intOrNull(body.away_score);
  if (!home || !away || !kickoff) return redirect(res, back, ['err', 'Preencha os dois times e a data/hora.']);
  if (hs === undefined || as === undefined || (hs === null) !== (as === null)) {
    return redirect(res, back, ['err', 'Placar inválido: preencha os gols dos dois times (ou deixe os dois em branco).']);
  }
  run('UPDATE matches SET home_team = ?, away_team = ?, kickoff_at = ?, home_score = ?, away_score = ? WHERE id = ?',
    home, away, kickoff, hs, as, m.id);
  redirect(res, back, ['ok', hs != null ? `Resultado salvo: ${home} ${hs} × ${as} ${away}.` : 'Jogo atualizado.']);
});

route('POST', '/admin/jogos/:id/excluir', ADMIN, ({ res, params }) => {
  const m = get('SELECT pool_id FROM matches WHERE id = ?', params.id);
  if (!m) return redirect(res, '/admin', ['err', 'Jogo não encontrado.']);
  run('DELETE FROM matches WHERE id = ?', params.id);
  redirect(res, `/admin/boloes/${m.pool_id}`, ['ok', 'Jogo excluído.']);
});

// ---------------------------------------------------------------- start

if (require.main === module) {
  ensureAdmin();
  server.listen(PORT, () => console.log(`Bolão rodando em http://localhost:${PORT}`));
}

module.exports = { server, scorePrediction, localInputToISO };
