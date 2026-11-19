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

// ---------- Componentes ----------

const initials = name => {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};

// "Escudo" com as iniciais do time, numa cor fixa por nome
function crest(name) {
  let hash = 0;
  for (const c of String(name)) hash = (hash * 31 + c.codePointAt(0)) >>> 0;
  return `<span class="crest" style="--hue:${hash % 360}" aria-hidden="true">${h(initials(name))}</span>`;
}

const tag = (txt, kind = '') => `<span class="tag ${kind}">${txt}</span>`;
const STATUS_TAG = { open: '', live: 'gray', done: 'gray' };

function pointsBadge(pts, pool) {
  if (pts == null) return '';
  if (pts === pool.points_exact) return tag(`Placar exato · +${pts}`, 'gold');
  if (pts > 0) return tag(`Acertou vencedor · +${pts}`);
  return tag(`Errou · +${pts}`, 'red');
}

function pageHead({ eyebrow, title, sub, actions = '' }) {
  return `
  <div class="page-head">
    <div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}
  </div>`;
}

function statCard(label, value, icon, extra = '') {
  return `<div class="card stat"><div><div class="label">${label}</div><div class="value">${value}</div>${extra}</div><div class="stat-icon">${icon}</div></div>`;
}

const back = (href, label) => `<a class="back" href="${href}">← ${h(label)}</a>`;

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

function flashBox(flash) {
  if (!flash) return '';
  return `<div class="flash ${flash.type}">${h(flash.msg)}</div>`;
}

// ---------- Layout ----------

function navItems(user) {
  return user.is_admin
    ? [['admin', '/admin', '▦', 'Painel', 'Painel'], ['boloes', '/boloes', '⚽', 'Meus palpites', 'Palpites'],
       ['ranking', '/ranking', '🏆', 'Ranking geral', 'Ranking'], ['conta', '/conta', '⚙', 'Minha conta', 'Conta']]
    : [['boloes', '/boloes', '⚽', 'Meus bolões', 'Início'], ['ranking', '/ranking', '🏆', 'Ranking geral', 'Ranking'],
       ['conta', '/conta', '⚙', 'Minha conta', 'Conta']];
}

const BRAND = `<div class="brand-mark">⚽</div><div class="brand-name">BOLÃO DA GALERA<small>PALPITE • DISPUTA • RESENHA</small></div>`;

function htmlDoc(title, inner) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07130f">
<title>${h(title)} · Bolão da Galera</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
${inner}
</body>
</html>`;
}

function layout({ title, user, flash, body, active, crumb }) {
  if (!user) {
    return htmlDoc(title, `<main class="auth"><div class="auth-box"><a class="brand" href="/">${BRAND}</a>${flashBox(flash)}${body}</div></main>`);
  }
  const items = navItems(user);
  return htmlDoc(title, `
<div class="app">
  <aside class="sidebar">
    <a class="brand" href="/">${BRAND}</a>
    <div class="nav-label">Menu</div>
    <nav class="nav">
      ${items.map(([key, href, ico, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}"><span class="ico">${ico}</span>${label}</a>`).join('')}
    </nav>
    <div class="sidebar-bottom">
      <div class="profile-mini">
        <div class="avatar">${h(initials(user.name))}</div>
        <div><b>${h(user.name)}</b><small>${user.is_admin ? 'Administrador' : 'Participante'}</small></div>
      </div>
      <form method="post" action="/logout"><button class="btn ghost full">Sair</button></form>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <a class="topbar-brand" href="/"><span class="brand-mark sm">⚽</span></a>
      <div class="crumb">Bolão da Galera <span class="muted">/</span> <b>${h(crumb || title)}</b></div>
      <a class="avatar" href="/conta" title="Minha conta">${h(initials(user.name))}</a>
    </header>
    <main class="content">
      ${flashBox(flash)}
      ${body}
    </main>
  </div>
</div>
<nav class="mobile-nav">
  ${items.map(([key, href, ico, , short]) => `<a class="${key === active ? 'active' : ''}" href="${href}"><b>${ico}</b>${short}</a>`).join('')}
</nav>`);
}

// ---------- Páginas públicas ----------

function loginPage({ error, username }) {
  return layout({
    title: 'Entrar',
    flash: error ? { type: 'err', msg: error } : null,
    body: `
    <section class="card">
      <h1>Entrar</h1>
      <p class="muted">Seu palpite, sua torcida, sua galera.</p>
      <form method="post" action="/login" class="stack">
        <label>Usuário <input name="username" value="${h(username)}" autocomplete="username" required autofocus></label>
        <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn full">Entrar</button>
      </form>
      <p class="muted small">Não tem usuário? Peça ao administrador do bolão.</p>
    </section>`,
  });
}

function messagePage({ user, title, msg }) {
  return layout({ title, user, body: `<section class="card narrow"><h1>${h(title)}</h1><p>${h(msg)}</p><p><a class="link" href="/">Voltar ao início →</a></p></section>` });
}

// ---------- Área do participante ----------

function memberHome({ user, flash, pools, summary }) {
  if (!pools.length) {
    const body = user.is_admin
      ? `${pageHead({ eyebrow: 'Meus palpites', title: 'Você não palpita em nenhum bolão', sub: 'Esta tela mostra os bolões em que você participa como jogador.' })}
         <div class="card">
           <p>Para cadastrar jogos, ver os palpites da galera e lançar resultados, use o <a class="link" href="/admin">Painel</a>.</p>
           <p class="small muted">Se também quiser palpitar, o ideal é criar um participante só para você e entrar com ele.</p>
         </div>`
      : `${pageHead({ eyebrow: 'Área do participante', title: `Olá, ${h(user.name)}! 👋` })}
         <div class="empty">Você ainda não foi adicionado a nenhum bolão. Fale com o administrador.</div>`;
    return layout({ title: 'Meus bolões', user, flash, active: 'boloes', body });
  }

  const main = summary.main; // bolão em destaque
  const heroTitle = main.ranked ? `Você está na ${main.pos}ª posição!` : 'Bora palpitar!';
  const heroText = main.pending
    ? `Você tem ${main.pending} jogo(s) esperando seu palpite.`
    : main.open ? 'Seus palpites estão em dia. Agora é torcer!' : 'Nenhum jogo aberto para palpites agora.';

  const cards = pools.map(p => `
    <a class="match pool-card" href="/boloes/${p.id}">
      <div class="match-top"><span>${p.members} participante(s)</span>${p.pending_count ? tag(`${p.pending_count} sem palpite`, 'gold') : p.open_count ? tag('Palpites em dia') : tag('Sem jogos abertos', 'gray')}</div>
      <b class="pool-name">${h(p.name)}</b>
      ${p.description ? `<p class="muted small">${h(p.description)}</p>` : ''}
      <div class="match-foot"><span>${p.ranked ? `${p.pos}º lugar · ${p.points} pts` : 'Sem resultados ainda'}</span><span class="link">Abrir →</span></div>
    </a>`).join('');

  return layout({
    title: 'Meus bolões', user, flash, active: 'boloes', body: `
    ${pageHead({ eyebrow: 'Área do participante', title: `Olá, ${h(user.name)}! 👋`, sub: 'Seus palpites, sua classificação e sua galera.' })}
    <a class="hero" href="/boloes/${main.id}">
      <div class="eyebrow light">${h(main.name)}</div>
      <h2>${heroTitle}</h2>
      <p>${heroText}</p>
      <div class="hero-number">${main.points} <span>pontos</span></div>
    </a>
    <div class="grid stats">
      ${statCard('Sua posição', main.ranked ? `${main.pos}º` : '–', '🏆', `<span class="muted small">${h(main.name)}</span>`)}
      ${statCard('Pontos', summary.points, '★', '<span class="muted small">Em todos os bolões</span>')}
      ${statCard('Placares exatos', summary.exact, '🎯')}
      ${statCard('Palpites pendentes', summary.pending, '⏱', summary.pending ? tag('Corre lá!', 'gold') : '')}
    </div>
    <div class="card">
      <div class="panel-head"><h2>Seus bolões</h2></div>
      <div class="grid three-col">${cards}</div>
    </div>`,
  });
}

function memberPool({ user, flash, pool, matches, ranking }) {
  const open = matches.filter(m => matchStatus(m, pool).key === 'open');
  const closed = matches.filter(m => matchStatus(m, pool).key !== 'open');

  const openCards = open.map(m => `
    <div class="match">
      <div class="match-top"><span>${fmtDate(m.kickoff_at)}</span>${tag(`Palpite até ${fmtClose(m, pool)}`, 'gold')}</div>
      <div class="teams">
        <div class="team">${crest(m.home_team)}<span class="tname">${h(m.home_team)}</span></div>
        <div class="scoreline">
          <input class="score-input" type="number" min="0" max="99" inputmode="numeric" name="h_${m.id}" value="${m.my_home ?? ''}" placeholder="0" aria-label="Gols ${h(m.home_team)}">
          <b>×</b>
          <input class="score-input" type="number" min="0" max="99" inputmode="numeric" name="a_${m.id}" value="${m.my_away ?? ''}" placeholder="0" aria-label="Gols ${h(m.away_team)}">
        </div>
        <div class="team away"><span class="tname">${h(m.away_team)}</span>${crest(m.away_team)}</div>
      </div>
      <div class="match-foot"><span>${m.my_home == null ? 'Não enviado' : 'Palpite salvo ✓'}</span>${m.my_home == null ? tag('Sem palpite', 'red') : tag('Enviado')}</div>
    </div>`).join('');

  const closedCards = closed.map(m => {
    const st = matchStatus(m, pool);
    return `
    <div class="match">
      <div class="match-top"><span>${fmtDate(m.kickoff_at)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
      <div class="teams">
        <div class="team">${crest(m.home_team)}<span class="tname">${h(m.home_team)}</span></div>
        <span class="final">${st.key === 'done' ? `${m.home_score} × ${m.away_score}` : '– × –'}</span>
        <div class="team away"><span class="tname">${h(m.away_team)}</span>${crest(m.away_team)}</div>
      </div>
      <div class="match-foot">
        <span>Seu palpite: <strong>${m.my_home != null ? `${m.my_home} × ${m.my_away}` : '—'}</strong> ${pointsBadge(m.points, pool)}</span>
        <a class="link" href="/boloes/${pool.id}/jogos/${m.id}">palpites da galera →</a>
      </div>
    </div>`;
  }).join('');

  return layout({
    title: pool.name, user, flash, active: 'boloes', body: `
    ${back('/boloes', 'Meus bolões')}
    ${pageHead({ eyebrow: 'Bolão', title: h(pool.name), sub: pool.description ? h(pool.description) : '' })}
    <div class="notice">Pontuação: placar exato = ${pool.points_exact} pts · acertar vencedor/empate = ${pool.points_result} pt(s).<br>${h(closeRule(pool))}</div>
    <div class="grid two-col">
      <div>
        <section class="card">
          <div class="panel-head"><h2>Faça seus palpites</h2>${open.length ? tag('Aberto') : tag('Fechado', 'gray')}</div>
          ${open.length ? `
          <form method="post" action="/boloes/${pool.id}/palpites">
            <div class="match-list">${openCards}</div>
            <button class="btn full save">Salvar palpites</button>
          </form>
          <p class="small muted">Você pode alterar seus palpites até o prazo de cada jogo.</p>`
          : '<div class="empty">Nenhum jogo aberto para palpites no momento.</div>'}
        </section>
        ${closed.length ? `<section class="card">
          <div class="panel-head"><h2>Jogos fechados</h2>${tag(`${closed.length} jogo(s)`, 'gray')}</div>
          <a class="btn secondary full mb" href="/boloes/${pool.id}/galera">👀 Ver palpites de todo mundo</a>
          <div class="match-list">${closedCards}</div></section>` : ''}
      </div>
      <aside>${rankingTable(ranking, user, pool)}</aside>
    </div>`,
  });
}

function rankingTable(ranking, user, pool) {
  if (!ranking.length) return '';
  const medal = pos => (pos === 1 ? ' 🥇' : pos === 2 ? ' 🥈' : pos === 3 ? ' 🥉' : '');
  return `
  <section class="card">
    <div class="panel-head"><h2>Classificação</h2>${pool ? tag(`${ranking.length} participante(s)`, 'gray') : ''}</div>
    <div class="table-wrap">
    <table class="rank">
      <thead><tr><th>#</th><th>Participante</th><th title="Pontos">Pts</th><th title="Placares exatos">PE</th><th title="Acertos de vencedor/empate">AV</th></tr></thead>
      <tbody>
      ${ranking.map(r => `
        <tr class="${user && r.id === user.id ? 'me' : ''}">
          <td class="pos">${r.pos}º${r.points > 0 ? medal(r.pos) : ''}</td><td>${h(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.exact}</td><td>${r.result}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <p class="small muted">PE = placares exatos · AV = acertos de vencedor/empate</p>
    ${pool ? `<a class="link" href="/boloes/${pool.id}/galera">Ver palpites de todo mundo →</a>` : ''}
  </section>`;
}

function cellHtml(c, pool) {
  if (!c) return '<td class="cell none">—</td>';
  const cls = c.points == null ? 'wait' : c.points === pool.points_exact ? 'exact' : c.points > 0 ? 'result' : 'miss';
  return `<td class="cell ${cls}">${c.home}×${c.away}${c.points != null ? `<small>+${c.points}</small>` : ''}</td>`;
}

function poolGrid({ user, pool, ranking, grid, openCount, member }) {
  const table = grid.length ? `
    <div class="table-scroll">
      <table class="grid-table">
        <thead><tr><th class="sticky">Jogo</th>${ranking.map(u => `<th class="${u.id === user.id ? 'me' : ''}">${h(u.name)}</th>`).join('')}</tr></thead>
        <tbody>
          ${grid.map(({ match: m, cells }) => `
          <tr>
            <td class="sticky">
              <div class="gm">${h(m.home_team)} <strong>${m.home_score != null ? `${m.home_score}×${m.away_score}` : '×'}</strong> ${h(m.away_team)}</div>
              <div class="small muted">${fmtDate(m.kickoff_at)}</div>
            </td>
            ${cells.map(c => cellHtml(c, pool)).join('')}
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td class="sticky"><strong>Total</strong></td>${ranking.map(u => `<td class="cell total">${u.points}</td>`).join('')}</tr></tfoot>
      </table>
    </div>
    <p class="small muted legend">
      <span class="cell exact">placar exato</span> <span class="cell result">acertou vencedor</span>
      <span class="cell miss">errou</span> <span class="cell wait">aguardando resultado</span> — = não palpitou
    </p>` : '<div class="empty">Nenhum jogo fechado ainda. Os palpites aparecem aqui assim que o prazo de cada jogo acabar.</div>';
  return layout({
    title: `Palpites · ${pool.name}`, crumb: 'Palpites da galera', user, active: member ? 'boloes' : 'admin', body: `
    ${back(member ? `/boloes/${pool.id}` : `/admin/boloes/${pool.id}`, pool.name)}
    ${pageHead({ eyebrow: h(pool.name), title: 'Palpites da galera', sub: `Só aparecem os jogos com palpites já fechados${openCount ? ` (${openCount} jogo(s) ainda aberto(s))` : ''}.` })}
    <div class="grid two-col">
      <section class="card"><div class="panel-head"><h2>Todos os palpites</h2></div>
        ${grid.length && ranking.length > 2 ? '<p class="small muted">Arraste a tabela para o lado para ver todo mundo →</p>' : ''}
        ${table}</section>
      <aside>${rankingTable(ranking, user)}</aside>
    </div>`,
  });
}

function generalRanking({ user, pools, ranking }) {
  const leader = ranking[0];
  const body = ranking.length ? `
    <div class="hero static">
      <div class="eyebrow light">Ranking geral · todos os bolões</div>
      <h2>Quem será o campeão?</h2>
      <p>${leader && leader.points ? `${h(leader.name)} lidera com ${leader.points} ponto(s).` : 'Os pontos aparecem quando os primeiros resultados forem lançados.'}</p>
      <div class="hero-number">${ranking.length} <span>participantes</span></div>
    </div>
    <section class="card">
      <div class="panel-head"><h2>Classificação geral</h2>${tag(`${pools.length} bolão(ões)`, 'gray')}</div>
      <div class="table-scroll">
        <table class="rank">
          <thead><tr><th>#</th><th>Participante</th><th>Total</th><th title="Placares exatos">PE</th><th title="Acertos de vencedor/empate">AV</th>
            ${pools.map(p => `<th>${h(p.name)}</th>`).join('')}</tr></thead>
          <tbody>
            ${ranking.map(r => `<tr class="${r.id === user.id ? 'me' : ''}">
              <td class="pos">${r.pos}º</td><td>${h(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.exact}</td><td>${r.result}</td>
              ${pools.map(p => `<td>${r.byPool[p.id] ?? '<span class="muted">–</span>'}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="small muted">Soma dos pontos de todos os bolões. "–" = não participa daquele bolão. PE = placares exatos · AV = acertos de vencedor/empate.</p>
    </section>`
    : '<div class="empty">Ainda não há participantes em nenhum bolão.</div>';
  return layout({
    title: 'Ranking geral', user, active: 'ranking',
    body: `${pageHead({ eyebrow: 'Disputa', title: 'Ranking geral', sub: 'A soma de todos os bolões.' })}${body}`,
  });
}

function matchPredictions({ user, pool, match, rows }) {
  const st = matchStatus(match, pool);
  const fromAdmin = user.is_admin && !rows.some(r => r.user_id === user.id);
  return layout({
    title: `${match.home_team} × ${match.away_team}`, crumb: 'Palpites do jogo', user, active: fromAdmin ? 'admin' : 'boloes', body: `
    ${back(fromAdmin ? `/admin/boloes/${pool.id}` : `/boloes/${pool.id}`, pool.name)}
    <section class="card narrow-lg">
      <div class="match-top"><span>${fmtDate(match.kickoff_at)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
      <div class="teams big">
        <div class="team">${crest(match.home_team)}<span class="tname">${h(match.home_team)}</span></div>
        <span class="final">${st.key === 'done' ? `${match.home_score} × ${match.away_score}` : '– × –'}</span>
        <div class="team away"><span class="tname">${h(match.away_team)}</span>${crest(match.away_team)}</div>
      </div>
      <div class="table-wrap">
      <table class="rank">
        <thead><tr><th>Participante</th><th>Palpite</th><th>Pontos</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.user_id === user.id ? 'me' : ''}">
            <td>${h(r.name)}</td>
            <td>${r.home != null ? `<strong>${r.home} × ${r.away}</strong>` : '<span class="muted">não palpitou</span>'}</td>
            <td>${r.points != null ? pointsBadge(r.points, pool) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </section>`,
  });
}

function accountPage({ user, flash }) {
  return layout({
    title: 'Minha conta', user, flash, active: 'conta', body: `
    ${pageHead({ eyebrow: 'Preferências', title: 'Minha conta', sub: 'Dados de acesso e segurança.' })}
    <div class="grid two-col">
      <section class="card">
        <h2>Segurança</h2>
        <form method="post" action="/conta/senha" class="stack">
          <label>Senha atual <input type="password" name="current" autocomplete="current-password" required></label>
          <label>Nova senha <input type="password" name="password" minlength="4" autocomplete="new-password" required></label>
          <label>Repita a nova senha <input type="password" name="password2" minlength="4" autocomplete="new-password" required></label>
          <button class="btn">Alterar senha</button>
        </form>
      </section>
      <section class="card">
        <h2>Seu perfil</h2>
        <div class="profile-mini big"><div class="avatar">${h(initials(user.name))}</div>
          <div><b>${h(user.name)}</b><small>@${h(user.username)} · ${user.is_admin ? 'Administrador' : 'Participante'}</small></div></div>
        <form method="post" action="/logout"><button class="btn ghost full">Sair da conta</button></form>
      </section>
    </div>`,
  });
}

// ---------- Administração ----------

function adminHome({ user, flash, users, pools, stats }) {
  const players = users.filter(u => !u.is_admin);
  return layout({
    title: 'Painel', user, flash, active: 'admin', body: `
    ${pageHead({
      eyebrow: 'Painel de controle', title: `Bom jogo, ${h(user.name)}.`,
      sub: 'Acompanhe a atividade dos seus bolões em um só lugar.',
      actions: '<a class="btn" href="#novo-bolao">＋ Criar bolão</a><a class="btn secondary" href="#novo-participante">＋ Participante</a>',
    })}
    <div class="grid stats">
      ${statCard('Bolões', String(pools.length).padStart(2, '0'), '👥')}
      ${statCard('Participantes', String(players.length).padStart(2, '0'), '♙', `<span class="muted small">${players.filter(u => !u.active).length} desativado(s)</span>`)}
      ${statCard('Jogos cadastrados', String(stats.matches).padStart(2, '0'), '⚽', stats.awaiting ? tag(`${stats.awaiting} aguardando resultado`, 'gold') : '<span class="muted small">Resultados em dia</span>')}
      ${statCard('Palpites registrados', String(stats.predictions).padStart(2, '0'), '✓')}
    </div>
    <div class="grid two-col">
      <section class="card">
        <div class="panel-head"><h2>Seus bolões</h2><a class="link" href="#novo-bolao">＋ Novo</a></div>
        ${pools.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Bolão</th><th>Participantes</th><th>Jogos</th><th></th></tr></thead>
          <tbody>${pools.map(p => `<tr>
            <td><a class="strong-link" href="/admin/boloes/${p.id}">${h(p.name)}</a></td><td>${p.members}</td><td>${p.matches}</td>
            <td class="right"><a class="btn secondary sm" href="/admin/boloes/${p.id}">Gerenciar</a></td></tr>`).join('')}
          </tbody></table></div>`
        : '<div class="empty">Nenhum bolão ainda. Crie o primeiro abaixo.</div>'}
      </section>
      <section class="card">
        <div class="panel-head"><h2>Participantes</h2><a class="link" href="#novo-participante">＋ Novo</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Participante</th><th>Bolões</th><th>Status</th></tr></thead>
          <tbody>${users.map(u => `<tr>
            <td><a class="strong-link" href="/admin/usuarios/${u.id}">${h(u.name)}</a><div class="muted small">@${h(u.username)}</div></td>
            <td>${u.pools}</td>
            <td>${u.is_admin ? tag('Admin', 'gold') : u.active ? tag('Ativo') : tag('Desativado', 'red')}</td></tr>`).join('')}
          </tbody></table></div>
      </section>
    </div>
    <div class="grid two-col">
      <section class="card" id="novo-bolao">
        <h2>Novo bolão</h2>
        <form method="post" action="/admin/boloes" class="stack">
          <label>Nome do bolão <input name="name" placeholder="Ex.: Bolão de Quinta" required></label>
          <label>Descrição <input name="description" placeholder="Opcional"></label>
          <div class="row">
            <label>Pts placar exato <input type="number" name="points_exact" value="3" min="0" max="100" required></label>
            <label>Pts vencedor/empate <input type="number" name="points_result" value="1" min="0" max="100" required></label>
          </div>
          ${deadlineFields(null)}
          <button class="btn full">Criar bolão</button>
        </form>
      </section>
      <section class="card" id="novo-participante">
        <h2>Novo participante</h2>
        <form method="post" action="/admin/usuarios" class="stack">
          <label>Nome <input name="name" placeholder="Ex.: João Silva" required></label>
          <label>Usuário (login) <input name="username" placeholder="nome.usuario" pattern="[A-Za-z0-9_.\\-]{3,30}" title="3 a 30 caracteres: letras, números, ponto, traço ou _" required></label>
          <label>Senha inicial <input name="password" minlength="4" required></label>
          ${pools.length ? `<fieldset><legend>Pode participar de:</legend>
            ${pools.map(p => `<label class="check"><input type="checkbox" name="pools" value="${p.id}"> ${h(p.name)}</label>`).join('')}
          </fieldset>` : ''}
          <button class="btn full">Criar participante</button>
        </form>
      </section>
    </div>`,
  });
}

function adminUser({ user, flash, target, pools, memberOf }) {
  return layout({
    title: target.name, crumb: 'Participante', user, flash, active: 'admin', body: `
    ${back('/admin', 'Painel')}
    ${pageHead({ eyebrow: 'Participante', title: h(target.name), sub: `@${h(target.username)}` })}
    <section class="card narrow-lg">
      <form method="post" action="/admin/usuarios/${target.id}" class="stack">
        <label>Nome <input name="name" value="${h(target.name)}" required></label>
        <label>Nova senha <input name="password" minlength="4" placeholder="Deixe em branco para não alterar"></label>
        ${target.id !== user.id ? `<label class="check"><input type="checkbox" name="active" value="1" ${target.active ? 'checked' : ''}> Conta ativa (pode entrar no site)</label>` : ''}
        <fieldset><legend>Bolões que pode participar</legend>
          ${pools.length ? pools.map(p => `<label class="check"><input type="checkbox" name="pools" value="${p.id}" ${memberOf.has(p.id) ? 'checked' : ''}> ${h(p.name)}</label>`).join('') : '<p class="muted small">Nenhum bolão criado.</p>'}
        </fieldset>
        <button class="btn">Salvar</button>
      </form>
      ${target.id !== user.id ? `
      <form method="post" action="/admin/usuarios/${target.id}/excluir" onsubmit="return confirm('Excluir ${h(target.name)} e todos os palpites dele(a)?')">
        <button class="btn danger mt">Excluir participante</button>
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
      <div class="match-top"><span>${fmtDate(m.kickoff_at)} · palpites até ${fmtClose(m, pool)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
      <form method="post" action="/admin/jogos/${m.id}" class="match-form">
        <div class="row teams-edit">
          <label>Mandante <input name="home_team" value="${h(m.home_team)}" required></label>
          <label class="sc">Gols <input class="score-input" type="number" min="0" max="99" name="home_score" value="${m.home_score ?? ''}"></label>
          <span class="x">×</span>
          <label class="sc">Gols <input class="score-input" type="number" min="0" max="99" name="away_score" value="${m.away_score ?? ''}"></label>
          <label>Visitante <input name="away_team" value="${h(m.away_team)}" required></label>
        </div>
        <div class="row">
          <label>Data e hora <input type="datetime-local" name="kickoff" value="${toLocalInput(m.kickoff_at)}" required></label>
          <button class="btn">Salvar</button>
        </div>
      </form>
      <div class="match-foot">
        <span>${m.pred_count}/${memberIds.size} palpites · <a class="link" href="/boloes/${pool.id}/jogos/${m.id}">ver palpites</a></span>
        <form method="post" action="/admin/jogos/${m.id}/excluir" class="inline" onsubmit="return confirm('Excluir este jogo e todos os palpites dele?')">
          <button class="linkbtn danger-text">excluir jogo</button>
        </form>
      </div>
    </div>`;
  }).join('');

  return layout({
    title: pool.name, crumb: 'Gerenciar bolão', user, flash, active: 'admin', body: `
    ${back('/admin', 'Painel')}
    ${pageHead({
      eyebrow: 'Gerenciar bolão', title: h(pool.name), sub: `${h(closeRule(pool))} <a class="link" href="#config">alterar</a>`,
      actions: `<a class="btn" href="#novo-jogo">＋ Adicionar jogo</a><a class="btn secondary" href="/boloes/${pool.id}/galera">👀 Palpites da galera</a>`,
    })}
    <div class="grid two-col">
      <div>
        <section class="card" id="novo-jogo">
          <h2>Adicionar jogo</h2>
          <form method="post" action="/admin/boloes/${pool.id}/jogos" class="stack">
            <div class="row">
              <label>Mandante <input name="home_team" placeholder="Time da casa" required></label>
              <span class="x">×</span>
              <label>Visitante <input name="away_team" placeholder="Time visitante" required></label>
            </div>
            <label>Data e hora do jogo <input type="datetime-local" name="kickoff" required></label>
            <button class="btn full">Adicionar jogo</button>
          </form>
        </section>
        <section class="card">
          <div class="panel-head"><h2>Jogos e resultados</h2>${tag(`${matches.length} jogo(s)`, 'gray')}</div>
          <p class="small muted">Para lançar o resultado, preencha os gols e toque em Salvar. Deixe os gols em branco enquanto o jogo não terminar.</p>
          <div class="match-list">${matchCards || '<div class="empty">Nenhum jogo cadastrado.</div>'}</div>
        </section>
      </div>
      <aside>
        <section class="card">
          <h2>Participantes deste bolão</h2>
          <form method="post" action="/admin/boloes/${pool.id}/membros" class="stack">
            ${users.length ? users.map(u => `<label class="check"><input type="checkbox" name="users" value="${u.id}" ${memberIds.has(u.id) ? 'checked' : ''}> ${h(u.name)} <span class="muted small">@${h(u.username)}</span></label>`).join('') : '<p class="muted small">Cadastre participantes primeiro.</p>'}
            <button class="btn secondary">Salvar participantes</button>
          </form>
        </section>
        ${rankingTable(ranking, null, pool)}
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
            <button class="btn">Salvar</button>
          </form>
          <form method="post" action="/admin/boloes/${pool.id}/excluir" onsubmit="return confirm('Excluir o bolão inteiro, com todos os jogos e palpites?')">
            <button class="btn danger mt">Excluir bolão</button>
          </form>
        </section>
      </aside>
    </div>`,
  });
}

module.exports = {
  h, fmtDate, matchStatus, closesAt, TIMEZONE,
  loginPage, messagePage, memberHome, memberPool, matchPredictions, accountPage,
  adminHome, adminUser, adminPool, poolGrid, generalRanking,
};
