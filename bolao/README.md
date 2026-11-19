# ⚽ Bolão da Galera

Site para organizar bolões de jogos entre amigos, sem caderno nem planilha.

- **Administrador**: cria bolões, cadastra jogos (times, dia e horário), cadastra participantes
  (usuário e senha), escolhe quem participa de cada bolão e lança os resultados.
- **Participante**: entra com o próprio usuário e senha, vê só os bolões em que foi incluído,
  dá palpites até o horário de início de cada jogo e acompanha a classificação.

## Como rodar

Precisa só do [Node.js](https://nodejs.org) 22.13 ou mais novo. Não há dependências para instalar.

```bash
cd bolao
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
| `DB_PATH`        | `data/bolao.db`        | Arquivo do banco de dados (SQLite)                |
| `TIMEZONE`       | `America/Sao_Paulo`    | Fuso usado nos horários dos jogos                 |
| `COOKIE_SECURE`  | —                      | Use `1` quando o site estiver em HTTPS            |

## Regras

- Palpites podem ser feitos e alterados até o horário de início do jogo; depois disso, fecham.
- Os palpites dos outros só aparecem depois que o jogo começa.
- Pontuação (configurável por bolão): **placar exato = 3 pts**, **acertar vencedor ou empate = 1 pt**.
- Desempate na classificação: mais placares exatos.

## Testes

```bash
npm test
```

## Estrutura

- `server.js` — servidor, rotas, login e regras de pontuação
- `views.js` — páginas HTML
- `db.js` — banco de dados SQLite (embutido no Node)
- `public/style.css` — visual (funciona no celular e tem modo escuro)
