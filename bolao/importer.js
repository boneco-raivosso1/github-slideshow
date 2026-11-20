'use strict';
// Lê o relatório de rodada no formato usado no WhatsApp, por exemplo:
//
//   🏆 *BET QUALITY — BRASILEIRÃO — RODADA 35* 🏆
//   *RESULTADOS*
//   MIR 0 x 0 CAM — Mirassol x Atlético-MG (em andamento)
//   CFC x SAN — Coritiba x Santos (não iniciado)
//   *CLASSIFICAÇÃO GERAL*
//   🥇 EDUARDO — 38 pts
//   *PONTOS DE CADA UM*
//   *CAMARGO — 1 pt*
//   MIR ( 1 ) x ( 1 ) CAM ❌ +1

const clean = line => line
  .replace(/[*_~]/g, '')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
  .replace(/[–—]/g, '—')
  .replace(/\s+/g, ' ')
  .trim();

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

const RE_RESULT = /^([A-Z0-9]{2,4}) (?:(\d+) )?x (?:(\d+) )?([A-Z0-9]{2,4}) ?— ?(.+?) x (.+?)(?: \(([^)]*)\))?$/i;
const RE_PRED = /^([A-Z0-9]{2,4}) ?\( ?(\d+) ?\) ?x ?\( ?(\d+) ?\) ?([A-Z0-9]{2,4})\b/i;
const RE_PERSON = /^(.+?) ?— ?(-?\d+) ?pts?\.?$/i;
const RE_RANK = /^(?:\d+ ?[º°o]\.? ?)?(.+?) ?— ?(-?\d+) ?pts?\.?$/i;

function parseReport(text) {
  const out = { title: '', matches: [], people: [], general: [] };
  let section = '';
  let person = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const up = norm(line);

    if (!out.title && /RODADA/.test(up)) { out.title = line.replace(/^—|—$/g, '').trim(); continue; }
    if (up === 'RESULTADOS' || up === 'JOGOS') { section = 'results'; continue; }
    if (up.startsWith('RANKING DA RODADA')) { section = 'round'; continue; }
    if (up.startsWith('CLASSIFICACAO GERAL')) { section = 'general'; continue; }
    if (up.startsWith('PONTOS DE CADA UM') || up.startsWith('PALPITES')) { section = 'people'; continue; }

    if (section === 'results') {
      const m = RE_RESULT.exec(line);
      if (m) {
        const status = norm(m[7] || '');
        out.matches.push({
          home_abbr: m[1].toUpperCase(), away_abbr: m[4].toUpperCase(),
          home_team: m[5].trim(), away_team: m[6].trim(),
          started: !/NAO INICIADO|AGENDADO/.test(status) && (m[2] != null || /ANDAMENTO|AO VIVO|ENCERRADO|FINALIZADO|FIM/.test(status)),
          finished: /ENCERRADO|FINALIZADO|FIM/.test(status),
          home_score: m[2] != null ? Number(m[2]) : null,
          away_score: m[3] != null ? Number(m[3]) : null,
        });
      }
    } else if (section === 'general') {
      const m = RE_RANK.exec(line);
      if (m) out.general.push({ name: m[1].trim(), points: Number(m[2]) });
    } else if (section === 'people') {
      const p = RE_PRED.exec(line);
      if (p && person) {
        person.preds.push({ home_abbr: p[1].toUpperCase(), away_abbr: p[4].toUpperCase(), home: Number(p[2]), away: Number(p[3]) });
        continue;
      }
      const h = RE_PERSON.exec(line);
      if (h && !/placar exato|acertou|errou/i.test(line)) {
        person = { name: h[1].trim(), round_points: Number(h[2]), preds: [] };
        out.people.push(person);
      }
    }
  }
  return out;
}

// "PAULO ROSSI" -> "Paulo Rossi"
function titleCase(name) {
  return name.toLocaleLowerCase('pt-BR').replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase('pt-BR'));
}

// "Paulo Rossi" -> "paulo.rossi"
function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 26) || 'jogador';
}

module.exports = { parseReport, titleCase, slug };
