'use strict';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// Escapa HTML
function h(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  const s = new Date(iso).toLocaleString('pt-BR', {
    timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const fmtDay = t => new Date(t).toLocaleDateString('pt-BR', { timeZone: TIMEZONE });
const fmtTime = t => new Date(t).toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

// Prazo de um jogo: só a hora se for no mesmo dia do jogo
function fmtClose(m, pool) {
  const t = closesAt(m, pool);
  return fmtDay(t) === fmtDay(m.kickoff_at) ? fmtTime(t) : fmtDate(t);
}

// Momento em que os palpites de um jogo fecham (ms): o que vier primeiro entre
// "X minutos antes do jogo" e o prazo final do bolão.
function closesAt(m, pool) {
  let t = Date.parse(m.kickoff_at) - (pool.close_minutes || 0) * 60000;
  if (pool.deadline_at) t = Math.min(t, Date.parse(pool.deadline_at));
  return t;
}

function matchStatus(m, pool) {
  if (m.home_score != null && m.away_score != null) return { key: 'done', label: 'Encerrado' };
  if (Date.now() >= closesAt(m, pool)) return { key: 'live', label: 'Palpites fechados' };
  return { key: 'open', label: 'Aberto para palpites' };
}

function closeRule(pool) {
  const parts = [];
  if (pool.close_minutes) parts.push(`fecham ${pool.close_minutes} min antes de cada jogo`);
  if (pool.deadline_at) parts.push(`prazo final: ${fmtDate(pool.deadline_at)}`);
  return parts.length ? `Palpites ${parts.join(' · ')}.` : 'Palpites fecham no horário de início de cada jogo.';
}

function deadlineFields(pool) {
  return `
    <fieldset><legend>Prazo dos palpites</legend>
      <label>Fechar quantos minutos antes de cada jogo?
        <input type="number" name="close_minutes" value="${pool ? pool.close_minutes : 0}" min="0" max="1440" required></label>
      <label>Prazo final para todos os jogos (opcional)
        <input type="datetime-local" name="deadline" value="${pool && pool.deadline_at ? toLocalInput(pool.deadline_at) : ''}"></label>
      <p class="small muted">Ex.: 30 minutos → jogo das 19:30 fecha às 19:00. Com prazo final, vale o que fechar primeiro.</p>
    </fieldset>`;
}

function pointsBadge(pts, pool) {
  if (pts == null) return '';
  const cls = pts === pool.points_exact ? 'exact' : pts > 0 ? 'result' : 'miss';
  const txt = pts === pool.points_exact ? 'Placar exato' : pts > 0 ? 'Acertou vencedor' : 'Errou';
  return `<span class="badge ${cls}">${txt} · +${pts}</span>`;
}

function flashBox(flash) {
  if (!flash) return '';
  return `<div class="flash ${flash.type}">${h(flash.msg)}</div>`;
}

function layout({ title, user, flash, body }) {
  const nav = user ? `
    <nav>
      ${user.is_admin ? '<a href="/admin">Administração</a>' : ''}
      <a href="/boloes">Meus bolões</a>
      <a href="/conta">Minha conta</a>
      <form method="post" action="/logout" class="inline"><button class="link">Sair</button></form>
    </nav>` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Bolão</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">⚽ Bolão da Galera</a>
  ${user ? `<span class="who">Olá, ${h(user.name)}</span>` : ''}
  ${nav}
</header>
<main>
${flashBox(flash)}
${body}
</main>
</body>
</html>`;
}

// ---------- Páginas públicas ----------

function loginPage({ error, username }) {
  return layout({
    title: 'Entrar',
    flash: error ? { type: 'err', msg: error } : null,
    body: `
    <section class="card narrow">
      <h1>Entrar</h1>
      <form method="post" action="/login" class="stack">
        <label>Usuário <input name="username" value="${h(username)}" autocomplete="username" required autofocus></label>
        <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
        <button>Entrar</button>
      </form>
      <p class="muted small">Não tem usuário? Peça ao administrador do bolão.</p>
    </section>`,
  });
}

function messagePage({ user, title, msg }) {
  return layout({ title, user, body: `<section class="card narrow"><h1>${h(title)}</h1><p>${h(msg)}</p><p><a href="/">Voltar ao início</a></p></section>` });
}

// ---------- Área do participante ----------

function memberHome({ user, flash, pools }) {
  const list = pools.length ? pools.map(p => `
    <a class="card pool-link" href="/boloes/${p.id}">
      <h2>${h(p.name)}</h2>
      ${p.description ? `<p class="muted">${h(p.description)}</p>` : ''}
      <p class="small">${p.open_count} jogo(s) aberto(s) · ${p.pending_count} sem seu palpite</p>
    </a>`).join('') : user.is_admin
    ? `<div class="card"><p>Esta tela mostra os bolões em que você <strong>palpita</strong>, e você não está marcado como participante de nenhum.</p>
       <p>Para cadastrar jogos, ver os palpites da galera e lançar resultados, vá em <a href="/admin">Administração</a> e toque no bolão.</p>
       <p class="small muted">Se também quiser palpitar, o ideal é criar um participante só para você e entrar com ele.</p></div>`
    : '<p class="card muted">Você ainda não foi adicionado a nenhum bolão.</p>';
  return layout({ title: 'Meus bolões', user, flash, body: `<h1>Meus bolões</h1><div class="grid">${list}</div>` });
}

function memberPool({ user, flash, pool, matches, ranking }) {
  const open = matches.filter(m => matchStatus(m, pool).key === 'open');
  const closed = matches.filter(m => matchStatus(m, pool).key !== 'open');

  const openCards = open.map(m => `
    <div class="match">
      <div class="when">${fmtDate(m.kickoff_at)} · <strong class="closes">palpite até ${fmtClose(m, pool)}</strong></div>
      <div class="teams">
        <span class="team home">${h(m.home_team)}</span>
        <input class="score" type="number" min="0" max="99" inputmode="numeric" name="h_${m.id}" value="${m.my_home ?? ''}" aria-label="Gols ${h(m.home_team)}">
        <span class="x">×</span>
        <input class="score" type="number" min="0" max="99" inputmode="numeric" name="a_${m.id}" value="${m.my_away ?? ''}" aria-label="Gols ${h(m.away_team)}">
        <span class="team away">${h(m.away_team)}</span>
      </div>
      <div class="status">${m.my_home == null ? '<span class="badge warn">Sem palpite</span>' : '<span class="badge ok">Palpite salvo</span>'}</div>
    </div>`).join('');

  const closedCards = closed.map(m => {
    const st = matchStatus(m, pool);
    return `
    <div class="match">
      <div class="when">${fmtDate(m.kickoff_at)} · <span class="muted">${st.label}</span></div>
      <div class="teams">
        <span class="team home">${h(m.home_team)}</span>
        <span class="final">${st.key === 'done' ? `${m.home_score} × ${m.away_score}` : '– × –'}</span>
        <span class="team away">${h(m.away_team)}</span>
      </div>
      <div class="status">
        Seu palpite: <strong>${m.my_home != null ? `${m.my_home} × ${m.my_away}` : '—'}</strong>
        ${pointsBadge(m.points, pool)}
        <a class="small" href="/boloes/${pool.id}/jogos/${m.id}">ver palpites da galera</a>
      </div>
    </div>`;
  }).join('');

  return layout({
    title: pool.name, user, flash, body: `
    <h1>${h(pool.name)}</h1>
    ${pool.description ? `<p class="muted">${h(pool.description)}</p>` : ''}
    <p class="small muted">Pontuação: placar exato = ${pool.points_exact} pts · acertar vencedor/empate = ${pool.points_result} pt(s).<br>${h(closeRule(pool))}</p>
    <div class="cols">
      <div>
        <section class="card">
          <h2>Próximos jogos</h2>
          ${open.length ? `
          <form method="post" action="/boloes/${pool.id}/palpites">
            ${openCards}
            <button class="wide">Salvar palpites</button>
          </form>
          <p class="small muted">Você pode alterar seus palpites até o prazo de cada jogo.</p>`
          : '<p class="muted">Nenhum jogo aberto para palpites no momento.</p>'}
        </section>
        ${closed.length ? `<section class="card"><h2>Jogos fechados</h2>${closedCards}</section>` : ''}
      </div>
      <aside>${rankingTable(ranking, user)}</aside>
    </div>`,
  });
}

function rankingTable(ranking, user) {
  if (!ranking.length) return '';
  return `
  <section class="card">
    <h2>Classificação</h2>
    <table class="rank">
      <thead><tr><th>#</th><th>Participante</th><th title="Pontos">Pts</th><th title="Placares exatos">PE</th><th title="Acertos de vencedor/empate">AV</th></tr></thead>
      <tbody>
      ${ranking.map(r => `
        <tr class="${user && r.id === user.id ? 'me' : ''}">
          <td>${r.pos}º</td><td>${h(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.exact}</td><td>${r.result}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="small muted">PE = placares exatos · AV = acertos de vencedor/empate</p>
  </section>`;
}

function matchPredictions({ user, pool, match, rows }) {
  const st = matchStatus(match, pool);
  return layout({
    title: `${match.home_team} × ${match.away_team}`, user, body: `
    <p><a href="${user.is_admin && !rows.some(r => r.user_id === user.id) ? `/admin/boloes/${pool.id}` : `/boloes/${pool.id}`}">← ${h(pool.name)}</a></p>
    <section class="card">
      <div class="when">${fmtDate(match.kickoff_at)} · ${st.label}</div>
      <div class="teams big">
        <span class="team home">${h(match.home_team)}</span>
        <span class="final">${st.key === 'done' ? `${match.home_score} × ${match.away_score}` : '– × –'}</span>
        <span class="team away">${h(match.away_team)}</span>
      </div>
      <table class="rank">
        <thead><tr><th>Participante</th><th>Palpite</th><th>Pontos</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.user_id === user.id ? 'me' : ''}">
            <td>${h(r.name)}</td>
            <td>${r.home != null ? `${r.home} × ${r.away}` : '<span class="muted">não palpitou</span>'}</td>
            <td>${r.points != null ? pointsBadge(r.points, pool) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`,
  });
}

function accountPage({ user, flash }) {
  return layout({
    title: 'Minha conta', user, flash, body: `
    <section class="card narrow">
      <h1>Minha conta</h1>
      <p>Usuário: <strong>${h(user.username)}</strong></p>
      <h2>Trocar senha</h2>
      <form method="post" action="/conta/senha" class="stack">
        <label>Senha atual <input type="password" name="current" autocomplete="current-password" required></label>
        <label>Nova senha <input type="password" name="password" minlength="4" autocomplete="new-password" required></label>
        <label>Repita a nova senha <input type="password" name="password2" minlength="4" autocomplete="new-password" required></label>
        <button>Salvar nova senha</button>
      </form>
    </section>`,
  });
}

// ---------- Administração ----------

function adminHome({ user, flash, users, pools }) {
  return layout({
    title: 'Administração', user, flash, body: `
    <h1>Administração</h1>
    <div class="cols even">
      <section class="card">
        <h2>Bolões</h2>
        ${pools.length ? `<ul class="list">${pools.map(p => `
          <li><a href="/admin/boloes/${p.id}">${h(p.name)}</a>
          <span class="muted small">${p.members} participante(s) · ${p.matches} jogo(s)</span></li>`).join('')}</ul>`
        : '<p class="muted">Nenhum bolão ainda.</p>'}
        <h3>Novo bolão</h3>
        <form method="post" action="/admin/boloes" class="stack">
          <label>Nome <input name="name" placeholder="Ex.: Brasileirão 2026" required></label>
          <label>Descrição <input name="description" placeholder="Opcional"></label>
          <div class="row">
            <label>Pts placar exato <input type="number" name="points_exact" value="3" min="0" max="100" required></label>
            <label>Pts vencedor/empate <input type="number" name="points_result" value="1" min="0" max="100" required></label>
          </div>
          ${deadlineFields(null)}
          <button>Criar bolão</button>
        </form>
      </section>
      <section class="card">
        <h2>Participantes</h2>
        <ul class="list">${users.map(u => `
          <li><a href="/admin/usuarios/${u.id}">${h(u.name)}</a>
          <span class="muted small">@${h(u.username)}${u.is_admin ? ' · admin' : ''}${u.active ? '' : ' · <strong>desativado</strong>'} · ${u.pools} bolão(ões)</span></li>`).join('')}
        </ul>
        <h3>Novo participante</h3>
        <form method="post" action="/admin/usuarios" class="stack">
          <label>Nome <input name="name" placeholder="Ex.: João Silva" required></label>
          <label>Usuário (login) <input name="username" pattern="[A-Za-z0-9_.\\-]{3,30}" title="3 a 30 caracteres: letras, números, ponto, traço ou _" required></label>
          <label>Senha inicial <input name="password" minlength="4" required></label>
          ${pools.length ? `<fieldset><legend>Pode participar de:</legend>
            ${pools.map(p => `<label class="check"><input type="checkbox" name="pools" value="${p.id}"> ${h(p.name)}</label>`).join('')}
          </fieldset>` : ''}
          <button>Criar participante</button>
        </form>
      </section>
    </div>`,
  });
}

function adminUser({ user, flash, target, pools, memberOf }) {
  return layout({
    title: target.name, user, flash, body: `
    <p><a href="/admin">← Administração</a></p>
    <section class="card narrow">
      <h1>${h(target.name)} <span class="muted small">@${h(target.username)}</span></h1>
      <form method="post" action="/admin/usuarios/${target.id}" class="stack">
        <label>Nome <input name="name" value="${h(target.name)}" required></label>
        <label>Nova senha <input name="password" minlength="4" placeholder="Deixe em branco para não alterar"></label>
        ${target.id !== user.id ? `<label class="check"><input type="checkbox" name="active" value="1" ${target.active ? 'checked' : ''}> Conta ativa (pode entrar no site)</label>` : ''}
        <fieldset><legend>Bolões que pode participar</legend>
          ${pools.length ? pools.map(p => `<label class="check"><input type="checkbox" name="pools" value="${p.id}" ${memberOf.has(p.id) ? 'checked' : ''}> ${h(p.name)}</label>`).join('') : '<p class="muted small">Nenhum bolão criado.</p>'}
        </fieldset>
        <button>Salvar</button>
      </form>
      ${target.id !== user.id ? `
      <form method="post" action="/admin/usuarios/${target.id}/excluir" onsubmit="return confirm('Excluir ${h(target.name)} e todos os palpites dele(a)?')">
        <button class="danger">Excluir participante</button>
      </form>` : ''}
    </section>`,
  });
}

// Converte ISO UTC para o valor de <input type="datetime-local"> no fuso configurado
function toLocalInput(iso) {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function adminPool({ user, flash, pool, users, memberIds, matches, ranking }) {
  const matchCards = matches.map(m => {
    const st = matchStatus(m, pool);
    return `
    <div class="match admin">
      <form method="post" action="/admin/jogos/${m.id}" class="match-form">
        <div class="row">
          <label>Mandante <input name="home_team" value="${h(m.home_team)}" required></label>
          <label class="sc">Gols <input class="score" type="number" min="0" max="99" name="home_score" value="${m.home_score ?? ''}"></label>
          <span class="x">×</span>
          <label class="sc">Gols <input class="score" type="number" min="0" max="99" name="away_score" value="${m.away_score ?? ''}"></label>
          <label>Visitante <input name="away_team" value="${h(m.away_team)}" required></label>
        </div>
        <div class="row">
          <label>Data e hora <input type="datetime-local" name="kickoff" value="${toLocalInput(m.kickoff_at)}" required></label>
          <span class="badge ${st.key}">${st.label}</span>
          <span class="small muted">palpites até ${fmtClose(m, pool)}</span>
          <span class="small muted">${m.pred_count}/${memberIds.size} palpites</span>
          <a class="small" href="/boloes/${pool.id}/jogos/${m.id}">ver palpites</a>
          <button>Salvar</button>
        </div>
      </form>
      <form method="post" action="/admin/jogos/${m.id}/excluir" class="inline" onsubmit="return confirm('Excluir este jogo e todos os palpites dele?')">
        <button class="link danger-text small">excluir jogo</button>
      </form>
    </div>`;
  }).join('');

  return layout({
    title: pool.name, user, flash, body: `
    <p><a href="/admin">← Administração</a></p>
    <h1>${h(pool.name)}</h1>
    <p class="small muted">${h(closeRule(pool))} <a href="#config">alterar</a></p>
    <div class="cols">
      <div>
        <section class="card">
          <h2>Adicionar jogo</h2>
          <form method="post" action="/admin/boloes/${pool.id}/jogos" class="stack">
            <div class="row">
              <label>Mandante <input name="home_team" required></label>
              <span class="x">×</span>
              <label>Visitante <input name="away_team" required></label>
            </div>
            <label>Data e hora do jogo <input type="datetime-local" name="kickoff" required></label>
            <button>Adicionar jogo</button>
          </form>
        </section>
        <section class="card">
          <h2>Jogos (${matches.length})</h2>
          <p class="small muted">Para lançar o resultado, preencha os gols e clique em Salvar. Deixe os gols em branco enquanto o jogo não terminar.</p>
          ${matchCards || '<p class="muted">Nenhum jogo cadastrado.</p>'}
        </section>
      </div>
      <aside>
        <section class="card">
          <h2>Participantes deste bolão</h2>
          <form method="post" action="/admin/boloes/${pool.id}/membros" class="stack">
            ${users.length ? users.map(u => `<label class="check"><input type="checkbox" name="users" value="${u.id}" ${memberIds.has(u.id) ? 'checked' : ''}> ${h(u.name)} <span class="muted small">@${h(u.username)}</span></label>`).join('') : '<p class="muted small">Cadastre participantes primeiro.</p>'}
            <button>Salvar participantes</button>
          </form>
        </section>
        ${rankingTable(ranking, null)}
        <section class="card" id="config">
          <h2>Configurações</h2>
          <form method="post" action="/admin/boloes/${pool.id}" class="stack">
            <label>Nome <input name="name" value="${h(pool.name)}" required></label>
            <label>Descrição <input name="description" value="${h(pool.description)}"></label>
            <div class="row">
              <label>Pts placar exato <input type="number" name="points_exact" value="${pool.points_exact}" min="0" max="100" required></label>
              <label>Pts vencedor/empate <input type="number" name="points_result" value="${pool.points_result}" min="0" max="100" required></label>
            </div>
            ${deadlineFields(pool)}
            <button>Salvar</button>
          </form>
          <form method="post" action="/admin/boloes/${pool.id}/excluir" onsubmit="return confirm('Excluir o bolão inteiro, com todos os jogos e palpites?')">
            <button class="danger">Excluir bolão</button>
          </form>
        </section>
      </aside>
    </div>`,
  });
}

module.exports = {
  h, fmtDate, matchStatus, closesAt, TIMEZONE,
  loginPage, messagePage, memberHome, memberPool, matchPredictions, accountPage,
  adminHome, adminUser, adminPool,
};
