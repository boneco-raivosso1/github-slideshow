# ⚽ Bolão da Galera

Site para organizar bolões de jogos entre amigos, sem caderno nem planilha.

- **Administrador**: cria bolões, cadastra jogos (times, dia e horário), cadastra participantes
  (usuário e senha), escolhe quem participa de cada bolão e lança os resultados.
- **Participante**: entra com o próprio usuário e senha, vê só os bolões em que foi incluído,
  dá palpites até o horário de início de cada jogo e acompanha a classificação.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
cd bolao
npm install
npm start
```

Abra http://localhost:3000. Na primeira vez, o terminal mostra o usuário e a senha do administrador
(usuário `admin`, senha aleatória). Troque a senha em **Minha conta**.

### Configurações (variáveis de ambiente)

| Variável         | Padrão                 | Para quê                                          |
|------------------|------------------------|---------------------------------------------------|
| `PORT`           | `3000`                 | Porta do servidor                                 |
| `ADMIN_USER`     | `admin`                | Usuário do primeiro administrador                 |
| `ADMIN_PASSWORD` | aleatória              | Senha do primeiro administrador                   |
| `DATABASE_URL`   | —                      | Endereço do banco Postgres (ex.: Neon). Sem ele, os dados ficam na pasta `data/` |
| `TIMEZONE`       | `America/Sao_Paulo`    | Fuso usado nos horários dos jogos                 |
| `COOKIE_SECURE`  | —                      | Use `1` quando o site estiver em HTTPS            |

## Publicar na internet (grátis: Render + Neon)

**1. Banco de dados (Neon)**
1. Crie uma conta em https://neon.tech (dá para entrar com o GitHub).
2. Crie um projeto (região: *São Paulo* se existir, senão *US East*).
3. Copie a **connection string**: começa com `postgresql://` e termina com `?sslmode=require`.

**2. Site (Render)**
1. Crie uma conta em https://render.com entrando com o GitHub.
2. Clique em **New → Web Service** e escolha o repositório `github-slideshow`.
3. Preencha:
   - **Branch**: `claude/sports-betting-platform-44gcnj`
   - **Root Directory**: `bolao`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: *Free*
4. Em **Environment Variables**, adicione:
   - `DATABASE_URL` = a connection string do Neon
   - `ADMIN_PASSWORD` = a senha que você quer para o administrador
   - `COOKIE_SECURE` = `1`
5. Clique em **Deploy**. Em alguns minutos o site fica no ar num endereço tipo
   `https://bolao-xxxx.onrender.com`. Entre com o usuário `admin` e a senha que você escolheu.

Observações:
- No plano grátis, o site "dorme" depois de 15 minutos sem uso, e a primeira abertura demora uns 30 a 50 segundos.
  Os dados não se perdem, porque ficam no Neon.
- `ADMIN_PASSWORD` só vale na criação do administrador. Depois, troque a senha em **Minha conta**.

## Regras

- **Primeiro acesso:** na tela de entrada, a pessoa cria o próprio usuário e senha. Depois ela escolhe um bolão
  aberto ("Qualquer pessoa cadastrada pode entrar sozinha") e toca em "Participar". O admin também pode cadastrar e
  incluir participantes manualmente.
- **Pagamento:** se o bolão estiver com "Só valem os palpites de quem tiver o pagamento confirmado", todos podem
  palpitar, mas só os participantes com pagamento confirmado pelo admin (Gerenciar bolão → Pagamentos) contam pontos e
  aparecem na classificação. Todo mundo vê a lista de confirmados e não confirmados, além do valor e da chave Pix.

- Palpites podem ser feitos e alterados até o prazo do jogo. Em cada bolão, o admin define quantos minutos antes de cada jogo os palpites fecham e, se quiser, um prazo final fixo (vale o que fechar primeiro).
- Quando os palpites de um jogo fecham, todo mundo vê os palpites de todos em "Palpites da galera" (tabela com os pontos de cada um).
- "Ranking geral" soma os pontos de todos os bolões.
- Pontuação (configurável por bolão): **placar exato = 3 pts**, **acertar vencedor ou empate = 1 pt**.
- Desempate na classificação: mais placares exatos.

## Testes

```bash
npm test                                          # usa um Postgres embutido em memória
TEST_DATABASE_URL=postgres://... npm test         # contra um Postgres real (use um banco vazio)
```

## Estrutura

- `server.js` — servidor, rotas, login e regras de pontuação
- `views.js` — páginas HTML
- `db.js` — banco de dados Postgres (Neon em produção, PGlite embutido no computador)
- `public/style.css` — visual (funciona no celular e tem modo escuro)
