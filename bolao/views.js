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
  if (!Number.isFinite(t)) return 'a definir';
  return m.kickoff_at && fmtDay(t) === fmtDay(m.kickoff_at) ? fmtTime(t) : fmtDate(t);
}

// Data do jogo, ou um rótulo quando o jogo não tem horário (bolão que fecha antes do primeiro jogo)
const when = m => (m.kickoff_at ? fmtDate(m.kickoff_at) : 'Jogo da rodada');

// Momento em que os palpites de um jogo fecham (ms).
// - close_mode 'first': todos fecham X min antes do primeiro jogo da rodada
//   (round_start_at informado pelo admin, ou o jogo mais cedo cadastrado: first_kickoff);
// - close_mode 'each': cada jogo fecha X min antes do seu horário.
// Um prazo final fixo (deadline_at), se houver, vale quando for antes.
// Sem nenhum horário, os palpites ficam abertos (Infinity).
function roundStart(pool) { return pool.round_start_at || pool.first_kickoff || null; }
function closesAt(m, pool) {
  const base = pool.close_mode === 'first' ? roundStart(pool) : (m.kickoff_at || pool.round_start_at);
  let t = base ? Date.parse(base) - (pool.close_minutes || 0) * 60000 : Infinity;
  if (pool.deadline_at) t = Math.min(t, Date.parse(pool.deadline_at));
  return t;
}

function matchStatus(m, pool) {
  if (m.home_score != null && m.away_score != null) return m.live ? { key: 'aovivo', label: '🔴 Ao vivo' } : { key: 'done', label: 'Encerrado' };
  if (Date.now() >= closesAt(m, pool)) return { key: 'live', label: 'Palpites fechados' };
  return { key: 'open', label: 'Aberto para palpites' };
}

function closeRule(pool) {
  if (pool.close_mode === 'first') {
    const base = roundStart(pool), min = pool.close_minutes || 0;
    const t = base ? Math.min(Date.parse(base) - min * 60000, pool.deadline_at ? Date.parse(pool.deadline_at) : Infinity) : null;
    return t ? `Todos os palpites fecham ${fmtDate(t)} (${min} min antes do primeiro jogo da rodada).`
      : `Todos os palpites fecham ${min} min antes do primeiro jogo da rodada (horário ainda não definido).`;
  }
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
const { crestUrl } = require('./escudos');

function crest(name) {
  const url = crestUrl(name);
  if (url) return `<img class="crest img" src="${url}" alt="" loading="lazy">`;
  let hash = 0;
  for (const c of String(name)) hash = (hash * 31 + c.codePointAt(0)) >>> 0;
  return `<span class="crest" style="--hue:${hash % 360}" aria-hidden="true">${h(initials(name))}</span>`;
}

const tag = (txt, kind = '') => `<span class="tag ${kind}">${txt}</span>`;
const STATUS_TAG = { open: '', live: 'gray', done: 'gray', aovivo: 'red' };

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

function joinFields(pool) {
  const on = (k, def) => (pool ? pool[k] : def) ? 'checked' : '';
  return `
    <fieldset><legend>Entrada e pagamento</legend>
      <label class="check"><input type="checkbox" name="open_join" value="1" ${on('open_join', true)}> Aparece na lista de bolões para todos os participantes</label>
      <label>Senha do bolão <input name="join_password" value="${h(pool ? pool.join_password : '')}" maxlength="40" autocomplete="off" placeholder="Em branco: entra sem senha"></label>
      <p class="small muted">Para entrar no bolão, o participante precisa digitar essa senha. Passe a senha só para quem pode participar.</p>
      <label class="check"><input type="checkbox" name="require_payment" value="1" ${on('require_payment', true)}> Só valem os palpites de quem tiver o pagamento confirmado</label>
      <div class="row">
        <label>Valor da entrada <input name="entry_fee" value="${h(pool ? pool.entry_fee : '')}" placeholder="Ex.: R$ 10,00"></label>
        <label>Chave Pix <input name="pix_key" value="${h(pool ? pool.pix_key : '')}" placeholder="Ex.: seu celular ou e-mail"></label>
      </div>
    </fieldset>`;
}

function deadlineFields(pool) {
  const mode = pool ? pool.close_mode : 'first';
  return `
    <fieldset><legend>Prazo dos palpites</legend>
      <label class="check"><input type="radio" name="close_mode" value="first" ${mode === 'first' ? 'checked' : ''}>
        <span>Todos os palpites fecham juntos, antes do <strong>primeiro jogo da rodada</strong></span></label>
      <label class="check"><input type="radio" name="close_mode" value="each" ${mode !== 'first' ? 'checked' : ''}>
        <span>Cada jogo fecha antes do seu próprio horário</span></label>
      <label>Horário do primeiro jogo da rodada
        <input type="datetime-local" name="round_start" value="${pool && pool.round_start_at ? toLocalInput(pool.round_start_at) : ''}"></label>
      <label>Fechar quantos minutos antes?
        <input type="number" name="close_minutes" value="${pool ? pool.close_minutes : 30}" min="0" max="1440" required></label>
      <input type="hidden" name="deadline" value="${pool && pool.deadline_at ? toLocalInput(pool.deadline_at) : ''}">
      <p class="small muted">Ex.: primeiro jogo sábado 16:30 e 30 minutos → <strong>todos os palpites fecham sábado 16:00</strong>.
        Assim os jogos não precisam de horário. Se deixar o horário em branco, vale o jogo mais cedo cadastrado.</p>
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

const BRAND = `<span class="brand-mark">⚽</span><span class="brand-name">BOLÃO<b>DA GALERA</b></span>`;

function htmlDoc(title, inner) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a0f18">
<title>${h(title)} · Bolão da Galera</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
${inner}
</body>
</html>`;
}

function layout({ title, user, flash, body, active }) {
  if (!user) {
    return htmlDoc(title, `<main class="auth"><div class="auth-box"><a class="brand" href="/">${BRAND}</a>${flashBox(flash)}${body}</div></main>`);
  }
  const items = navItems(user);
  return htmlDoc(title, `
<header class="site-header">
  <div class="hdr-inner">
    <a class="brand" href="/">${BRAND}</a>
    <nav class="hnav">
      ${items.map(([key, href, ico, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}"><span class="ico">${ico}</span>${label}</a>`).join('')}
    </nav>
    <div class="hdr-user">
      <a class="user-chip" href="/conta" title="Minha conta">
        <span class="avatar">${h(initials(user.name))}</span>
        <span class="user-txt"><b>${h(user.name)}</b><small>${user.is_admin ? 'Administrador' : 'Participante'}</small></span>
      </a>
      <form method="post" action="/logout" class="logout"><button class="btn ghost sm">Sair</button></form>
    </div>
  </div>
</header>
<main class="content">
  ${flashBox(flash)}
  ${body}
</main>
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
      <div class="divider"><span>ou</span></div>
      <a class="btn secondary full" href="/cadastro">✨ Primeiro acesso? Crie sua conta</a>
    </section>`,
  });
}

function signupPage({ error, name, username }) {
  return layout({
    title: 'Primeiro acesso',
    flash: error ? { type: 'err', msg: error } : null,
    body: `
    <section class="card">
      <h1>Primeiro acesso</h1>
      <p class="muted">Crie seu usuário e sua senha para entrar no bolão.</p>
      <form method="post" action="/cadastro" class="stack">
        <label>Seu nome (aparece na classificação) <input name="name" value="${h(name)}" placeholder="Ex.: João Silva" autocomplete="name" required autofocus></label>
        <label>Usuário (para entrar) <input name="username" value="${h(username)}" placeholder="Ex.: joao10" autocomplete="username" autocapitalize="none"
          pattern="[A-Za-z0-9_.\-]{3,30}" title="3 a 30 caracteres: letras, números, ponto, traço ou _ (sem espaços)" required></label>
        <label>Senha <input type="password" name="password" minlength="4" autocomplete="new-password" required></label>
        <label>Repita a senha <input type="password" name="password2" minlength="4" autocomplete="new-password" required></label>
        <button class="btn full">Criar conta e entrar</button>
      </form>
      <p class="muted small">Já tem conta? <a class="link" href="/login">Entrar</a></p>
    </section>`,
  });
}

// Chave Pix / valor da entrada de um bolão
function paymentInfo(pool) {
  if (!pool.require_payment) return '';
  const parts = [];
  if (pool.entry_fee) parts.push(`Valor: <strong>${h(pool.entry_fee)}</strong>`);
  if (pool.pix_key) parts.push(`Pix: <strong class="pix">${h(pool.pix_key)}</strong>`);
  return parts.join(' · ');
}

function messagePage({ user, title, msg }) {
  return layout({ title, user, body: `<section class="card narrow"><h1>${h(title)}</h1><p>${h(msg)}</p><p><a class="link" href="/">Voltar ao início →</a></p></section>` });
}

// ---------- Área do participante ----------

function availableSection(available) {
  if (!available.length) return '';
  return `
    <div class="card" id="disponiveis">
      <div class="panel-head"><h2>Bolões disponíveis</h2>${tag(`${available.length} disponível(is)`)}</div>
      <div class="grid three-col">${available.map(p => `
        <div class="match pool-card">
          <div class="match-top"><span>${p.members} participante(s)</span><span>${p.join_password ? tag('🔒 Com senha', 'gray') : ''} ${p.require_payment ? tag('Pago', 'gold') : tag('Grátis')}</span></div>
          <b class="pool-name">${h(p.name)}</b>
          ${p.description ? `<p class="muted small">${h(p.description)}</p>` : ''}
          ${paymentInfo(p) ? `<p class="small">${paymentInfo(p)}</p>` : ''}
          ${p.join_password ? `
          <form method="post" action="/boloes/${p.id}/entrar" class="join-form">
            <input type="password" name="password" placeholder="Senha do bolão" autocomplete="off" required aria-label="Senha do bolão ${h(p.name)}">
            <button class="btn sm">Entrar</button>
          </form>` : `<form method="post" action="/boloes/${p.id}/entrar"><button class="btn full sm">Participar</button></form>`}
        </div>`).join('')}
      </div>
    </div>`;
}

function memberHome({ user, flash, pools, summary, available = [] }) {
  if (!pools.length && available.length) {
    return layout({ title: 'Meus bolões', user, flash, active: 'boloes', body: `
      ${pageHead({ eyebrow: 'Área do participante', title: `Olá, ${h(user.name)}! 👋`, sub: 'Escolha um bolão para participar.' })}
      ${availableSection(available)}` });
  }
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
  const unpaid = main.require_payment && !main.paid;
  const heroTitle = unpaid ? 'Falta confirmar seu pagamento' : main.ranked ? `Você está na ${main.pos}ª posição!` : 'Bora palpitar!';
  const heroText = unpaid ? 'Você já pode palpitar, mas seus palpites só valem depois que o administrador confirmar o pagamento.' : main.pending
    ? `Você tem ${main.pending} jogo(s) esperando seu palpite.`
    : main.open ? 'Seus palpites estão em dia. Agora é torcer!' : 'Nenhum jogo aberto para palpites agora.';

  const cards = pools.map(p => `
    <a class="match pool-card" href="/boloes/${p.id}">
      <div class="match-top"><span>${p.members} participante(s)</span>${p.require_payment && !p.paid ? tag('Pagamento pendente', 'red') : p.pending_count ? tag(`${p.pending_count} sem palpite`, 'gold') : p.open_count ? tag('Palpites em dia') : tag('Sem jogos abertos', 'gray')}</div>
      <b class="pool-name">${h(p.name)}</b>
      ${p.description ? `<p class="muted small">${h(p.description)}</p>` : ''}
      <div class="match-foot"><span>${p.require_payment && !p.paid ? 'Palpites ainda não valem' : p.ranked ? `${p.pos}º lugar · ${p.points} pts` : 'Sem resultados ainda'}</span><span class="link">Abrir →</span></div>
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
      ${statCard('Sua posição', main.ranked && !unpaid ? `${main.pos}º` : '–', '🏆', `<span class="muted small">${h(main.name)}</span>`)}
      ${statCard('Pontos', summary.points, '★', '<span class="muted small">Em todos os bolões</span>')}
      ${statCard('Placares exatos', summary.exact, '🎯')}
      ${statCard('Palpites pendentes', summary.pending, '⏱', summary.pending ? tag('Corre lá!', 'gold') : '')}
    </div>
    <div class="card">
      <div class="panel-head"><h2>Seus bolões</h2></div>
      <div class="grid three-col">${cards}</div>
    </div>
    ${availableSection(available)}`,
  });
}

function paymentsCard(pool, members, adminView) {
  if (!pool.require_payment) return '';
  const ok = members.filter(m => m.paid), wait = members.filter(m => !m.paid);
  const row = (m, paid) => `
    <div class="pay-row">
      <span class="pay-name">${paid ? '✅' : '⏳'} ${h(m.name)}${adminView ? ` <span class="muted small">@${h(m.username)}</span>` : ''}</span>
      ${adminView ? `<form method="post" action="/admin/boloes/${pool.id}/pagamento/${m.id}">
        <input type="hidden" name="paid" value="${paid ? 0 : 1}">
        <button class="btn sm ${paid ? 'ghost' : ''}">${paid ? 'Desfazer' : 'Confirmar pagamento'}</button></form>` : ''}
    </div>`;
  return `
  <section class="card" id="pagamentos">
    <div class="panel-head"><h2>Pagamentos</h2>${tag(`${ok.length}/${members.length} confirmados`, ok.length === members.length ? '' : 'gold')}</div>
    ${paymentInfo(pool) ? `<p class="small">${paymentInfo(pool)}</p>` : ''}
    <h3>✅ Palpites confirmados (${ok.length})</h3>
    ${ok.length ? ok.map(m => row(m, true)).join('') : '<p class="muted small">Ninguém confirmado ainda.</p>'}
    <h3 class="mt">⏳ Palpites não confirmados (${wait.length})</h3>
    ${wait.length ? wait.map(m => row(m, false)).join('') : '<p class="muted small">Todo mundo pagou! 🎉</p>'}
    <p class="small muted">Só os palpites confirmados contam pontos e entram na classificação.</p>
  </section>`;
}

function memberPool({ user, flash, pool, matches, ranking, members = [], paid = true }) {
  const unpaid = pool.require_payment && !paid;
  const open = matches.filter(m => matchStatus(m, pool).key === 'open');
  const closed = matches.filter(m => matchStatus(m, pool).key !== 'open');

  const openCards = open.map(m => `
    <div class="match">
      <div class="match-top"><span>${when(m)}</span>${tag(`Palpite até ${fmtClose(m, pool)}`, 'gold')}</div>
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
      <div class="match-top"><span>${when(m)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
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
    ${unpaid ? `<div class="notice warn"><strong>⏳ Seus palpites ainda não estão valendo.</strong><br>
      Faça o pagamento e avise o administrador. Assim que ele confirmar, seus palpites entram na classificação.
      ${paymentInfo(pool) ? `<br>${paymentInfo(pool)}` : ''}</div>` : pool.require_payment ? '<div class="notice">✅ Pagamento confirmado: seus palpites estão valendo.</div>' : ''}
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
      <aside>${rankingTable(ranking, user, pool)}${paymentsCard(pool, members, false)}</aside>
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
  if (c.unconfirmed) return `<td class="cell void" title="Não confirmado: não vale pontos">${c.home}×${c.away}<small>não vale</small></td>`;
  const cls = c.points == null ? 'wait' : c.points === pool.points_exact ? 'exact' : c.points > 0 ? 'result' : 'miss';
  return `<td class="cell ${cls}">${c.home}×${c.away}${c.points != null ? `<small>+${c.points}</small>` : ''}</td>`;
}

function poolGrid({ user, pool, ranking, columns = ranking, grid, openCount, member }) {
  const table = grid.length ? `
    <div class="table-scroll">
      <table class="grid-table">
        <thead><tr><th class="sticky">Jogo</th>${columns.map(u => `<th class="${u.id === user.id ? 'me' : ''} ${u.unconfirmed ? 'unconf' : ''}">${h(u.name)}${u.unconfirmed ? '<small>não confirmado</small>' : ''}</th>`).join('')}</tr></thead>
        <tbody>
          ${grid.map(({ match: m, cells }) => `
          <tr>
            <td class="sticky">
              <div class="gm">${h(m.home_team)} <strong>${m.home_score != null ? `${m.home_score}×${m.away_score}` : '×'}</strong> ${h(m.away_team)}</div>
              <div class="small muted">${when(m)}</div>
            </td>
            ${cells.map(c => cellHtml(c, pool)).join('')}
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td class="sticky"><strong>Total</strong></td>${columns.map(u => `<td class="cell total">${u.unconfirmed ? '<span class="muted">—</span>' : u.points}</td>`).join('')}</tr></tfoot>
      </table>
    </div>
    <p class="small muted legend">
      <span class="cell exact">placar exato</span> <span class="cell result">acertou vencedor</span>
      <span class="cell miss">errou</span> <span class="cell wait">aguardando resultado</span>
      ${columns.some(c => c.unconfirmed) ? '<span class="cell void">não confirmado (não vale)</span>' : ''} — = não palpitou
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
  const hasCarry = ranking.some(r => r.carry);
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
            ${hasCarry ? '<th title="Pontos de rodadas anteriores">Anteriores</th>' : ''}
            ${pools.map(p => `<th>${h(p.name)}</th>`).join('')}</tr></thead>
          <tbody>
            ${ranking.map(r => `<tr class="${r.id === user.id ? 'me' : ''}">
              <td class="pos">${r.pos}º</td><td>${h(r.name)}</td><td><strong>${r.points}</strong></td><td>${r.exact}</td><td>${r.result}</td>
              ${hasCarry ? `<td>${r.carry || 0}</td>` : ''}
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
      <div class="match-top"><span>${when(match)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
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
            <td>${!r.counts ? tag('Não confirmado', 'gray') : r.points != null ? pointsBadge(r.points, pool) : '—'}</td>
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
      actions: '<a class="btn" href="#novo-bolao">＋ Criar bolão</a><a class="btn secondary" href="#novo-participante">＋ Participante</a><a class="btn secondary" href="/admin/importar">📥 Importar rodada</a>',
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
          ${joinFields(null)}
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
    </div>
    <section class="card danger-zone" id="zerar">
      <h2>⚠️ Zerar o app</h2>
      <p class="small muted">Apaga <strong>todos os bolões</strong> (jogos, palpites e pagamentos) e <strong>todos os usuários que não são administradores</strong>.
        Os administradores continuam. <strong>Não dá para desfazer.</strong></p>
      <form method="post" action="/admin/zerar" class="row" onsubmit="return confirm('Tem certeza? Isso apaga TODOS os bolões e TODOS os participantes, e não dá para desfazer.')">
        <label>Para confirmar, digite ZERAR <input name="confirm" autocomplete="off" autocapitalize="characters" placeholder="ZERAR" required></label>
        <button class="btn danger">Apagar tudo</button>
      </form>
    </section>`,
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
        <label>Pontos de rodadas anteriores (somam no Ranking geral)
          <input type="number" name="carry_points" value="${target.carry_points || 0}" min="-9999" max="99999"></label>
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

function adminPool({ user, flash, pool, users, memberIds, matches, ranking, members = [] }) {
  const matchCards = matches.map(m => {
    const st = matchStatus(m, pool);
    return `
    <div class="match admin">
      <div class="match-top"><span>${when(m)} · palpites até ${fmtClose(m, pool)}</span>${tag(st.label, STATUS_TAG[st.key])}</div>
      <form method="post" action="/admin/jogos/${m.id}" class="match-form">
        <div class="row teams-edit">
          <label>Mandante <input name="home_team" value="${h(m.home_team)}" required></label>
          <label class="sc">Gols <input class="score-input" type="number" min="0" max="99" name="home_score" value="${m.home_score ?? ''}"></label>
          <span class="x">×</span>
          <label class="sc">Gols <input class="score-input" type="number" min="0" max="99" name="away_score" value="${m.away_score ?? ''}"></label>
          <label>Visitante <input name="away_team" value="${h(m.away_team)}" required></label>
        </div>
        <div class="row">
          <label>Data e hora <input type="datetime-local" name="kickoff" value="${m.kickoff_at ? toLocalInput(m.kickoff_at) : ''}" ${pool.close_mode === 'first' ? '' : 'required'}></label>
          <label class="check live-check"><input type="checkbox" name="live" value="1" ${m.live ? 'checked' : ''}> 🔴 Ao vivo (placar parcial)</label>
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
      actions: `<a class="btn" href="#novo-jogo">＋ Adicionar jogo</a>${pool.require_payment ? `<a class="btn secondary" href="#pagamentos">💰 Pagamentos (${members.filter(m => m.paid).length}/${members.length})</a>` : ''}<a class="btn secondary" href="/boloes/${pool.id}/galera">👀 Palpites da galera</a>`,
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
            <label>Data e hora do jogo${pool.close_mode === 'first' ? ' (opcional)' : ''}
              <input type="datetime-local" name="kickoff" ${pool.close_mode === 'first' ? '' : 'required'}></label>
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
        ${paymentsCard(pool, members, true)}
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
            ${joinFields(pool)}
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

function importPage({ user, flash, form = {} }) {
  return layout({
    title: 'Importar rodada', user, flash, active: 'admin', body: `
    ${back('/admin', 'Painel')}
    ${pageHead({ eyebrow: 'Ferramentas', title: 'Importar rodada', sub: 'Cole o relatório da rodada do WhatsApp e o app cria o bolão, os jogos, os participantes e os palpites.' })}
    <div class="grid two-col">
      <section class="card">
        <form method="post" action="/admin/importar" class="stack">
          <label>Texto do relatório
            <textarea name="text" rows="16" required placeholder="🏆 *BRASILEIRÃO — RODADA 35* 🏆&#10;*RESULTADOS*&#10;CFC x SAN — Coritiba x Santos (não iniciado)&#10;...&#10;*PONTOS DE CADA UM*&#10;*FULANO — 0 pts*&#10;CFC ( 1 ) x ( 2 ) SAN ⏳">${h(form.text)}</textarea></label>
          <label>Nome do bolão (opcional) <input name="name" value="${h(form.name)}" placeholder="Em branco: usa o título do relatório, ex. Brasileirão — Rodada 35"></label>
          <div class="row">
            <label>Pts placar exato <input type="number" name="points_exact" value="${h(form.points_exact ?? 4)}" min="0" max="100" required></label>
            <label>Pts vencedor/empate <input type="number" name="points_result" value="${h(form.points_result ?? 1)}" min="0" max="100" required></label>
          </div>
          <label>Data e hora dos jogos que ainda não começaram <input type="datetime-local" name="kickoff" value="${h(form.kickoff)}"></label>
          <label>Senha inicial dos participantes novos <input name="password" value="${h(form.password)}" minlength="4" required placeholder="Ex.: 1234 (cada um troca depois)"></label>
          <button class="btn full save">📥 Importar rodada</button>
        </form>
      </section>
      <aside>
        <section class="card">
          <h2>Como funciona</h2>
          <ul class="howto">
            <li><strong>Jogos:</strong> vêm da parte <em>RESULTADOS</em>. "Em andamento" vira jogo 🔴 ao vivo com placar parcial; "encerrado" já entra com o resultado.</li>
            <li><strong>Participantes:</strong> vêm de <em>PONTOS DE CADA UM</em>. Quem já tem conta com o mesmo nome é reaproveitado; os outros ganham usuário novo (ex.: <em>paulo.rossi</em>) com a senha inicial acima.</li>
            <li><strong>Pagamento:</strong> todos os importados entram com pagamento confirmado.</li>
            <li><strong>Classificação geral:</strong> os pontos de rodadas anteriores entram no Ranking geral.</li>
            <li>Depois de importar, ajuste o dia e a hora de cada jogo em "Gerenciar bolão".</li>
          </ul>
        </section>
      </aside>
    </div>`,
  });
}

module.exports = {
  h, fmtDate, matchStatus, closesAt, TIMEZONE,
  loginPage, signupPage, messagePage, memberHome, memberPool, matchPredictions, accountPage,
  adminHome, adminUser, adminPool, importPage, poolGrid, generalRanking,
};
