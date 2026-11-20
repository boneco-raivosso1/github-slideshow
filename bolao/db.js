'use strict';
// Banco de dados Postgres.
// - Em produção (Render): usa DATABASE_URL (ex.: banco gratuito do Neon).
// - No computador / testes: sem DATABASE_URL, usa o PGlite (Postgres embutido),
//   guardando os dados na pasta data/ (ou só na memória com DB_PATH=memory).
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pools (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    points_exact INTEGER NOT NULL DEFAULT 3,
    points_result INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS pool_members (
    pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (pool_id, user_id)
  );
  ALTER TABLE pool_members ADD COLUMN IF NOT EXISTS paid INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY,
    pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_at TEXT NOT NULL,           -- ISO 8601 em UTC
    home_score INTEGER,
    away_score INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Prazo dos palpites: X minutos antes de cada jogo e/ou um prazo final fixo
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS close_minutes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS deadline_at TEXT;

  -- Inscrição pelo próprio participante e confirmação de pagamento
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS open_join INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS require_payment INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS entry_fee TEXT NOT NULL DEFAULT '';
  ALTER TABLE pools ADD COLUMN IF NOT EXISTS pix_key TEXT NOT NULL DEFAULT '';

  -- Pontos de rodadas anteriores (fora do app) e jogo ao vivo com placar parcial
  ALTER TABLE users ADD COLUMN IF NOT EXISTS carry_points INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE matches ADD COLUMN IF NOT EXISTS live INTEGER NOT NULL DEFAULT 0;

  -- Rodadas importadas automaticamente (pasta seeds/), para não importar duas vezes
  CREATE TABLE IF NOT EXISTS imports (
    key TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_matches_pool ON matches(pool_id, kickoff_at);

  CREATE TABLE IF NOT EXISTS predictions (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    home INTEGER NOT NULL,
    away INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, user_id)
  );
`;

// Permite escrever "?" nas consultas; converte para $1, $2... do Postgres
const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

let backend; // { query(sql, params), transaction(fn), close() }

async function init() {
  if (backend) return;
  if (process.env.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, v => Number(v)); // BIGINT -> número
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    backend = {
      query: (sql, params) => pool.query(sql, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn((sql, params) => client.query(sql, params));
          await client.query('COMMIT');
          return r;
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const where = process.env.DB_PATH || path.join(__dirname, 'data', 'pgdata');
    const pg = where === 'memory' ? new PGlite() : new PGlite(where);
    backend = {
      query: (sql, params) => pg.query(sql, params),
      transaction: fn => pg.transaction(tx => fn((sql, params) => tx.query(sql, params))),
      close: () => pg.close(),
    };
  }
  for (const stmt of SCHEMA.split(';')) if (stmt.trim()) await backend.query(stmt, []);
}

function makeApi(q) {
  const all = async (sql, ...p) => (await q(toPg(sql), p)).rows;
  return {
    all,
    get: async (sql, ...p) => (await all(sql, ...p))[0],
    run: (sql, ...p) => q(toPg(sql), p),
  };
}

const api = makeApi((sql, p) => backend.query(sql, p));

// Executa várias operações juntas: ou tudo dá certo, ou nada é salvo.
const tx = fn => backend.transaction(q => fn(makeApi(q)));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Garante que exista pelo menos um administrador.
async function ensureAdmin() {
  if (await api.get('SELECT 1 FROM users WHERE is_admin = 1')) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  await api.run('INSERT INTO users (username, name, password_hash, is_admin) VALUES (?, ?, ?, 1)',
    username, 'Administrador', hashPassword(password));
  console.log('\n=== Administrador criado ===');
  console.log(`Usuário: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Senha:   ${password}   (troque depois em "Minha conta")`);
  console.log('============================\n');
}

module.exports = { init, ...api, tx, hashPassword, verifyPassword, ensureAdmin, close: () => backend && backend.close() };
