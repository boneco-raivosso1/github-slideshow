'use strict';
// Escudos dos times: arquivos em public/escudos/<chave>.<png|webp|svg|jpg>
// A chave vem do nome do time (sem acento, minúsculo, com traço), com apelidos abaixo.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'public', 'escudos');
const FILE_RE = /^[a-z0-9-]+\.(png|webp|svg|jpg|jpeg)$/;

// Nomes diferentes para o mesmo time -> chave do arquivo
const ALIASES = {
  'atletico-mg': 'atletico-mineiro', 'atletico': 'atletico-mineiro', 'galo': 'atletico-mineiro', 'cam': 'atletico-mineiro',
  'athletico-pr': 'athletico-paranaense', 'athletico': 'athletico-paranaense', 'atletico-pr': 'athletico-paranaense', 'cap': 'athletico-paranaense',
  'red-bull-bragantino': 'bragantino', 'rb-bragantino': 'bragantino', 'rbb': 'bragantino',
  'vasco-da-gama': 'vasco', 'inter': 'internacional', 'sport-recife': 'sport',
  'atletico-go': 'atletico-goianiense', 'america-mg': 'america-mineiro', 'america': 'america-mineiro',
  'botafogo-rj': 'botafogo', 'gremio-fbpa': 'gremio', 'sao-paulo-fc': 'sao-paulo', 'spfc': 'sao-paulo',
  'chape': 'chapecoense', 'clube-do-remo': 'remo', 'fla': 'flamengo', 'flu': 'fluminense', 'timao': 'corinthians',
};

const key = name => {
  const k = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ALIASES[k] || k;
};

let files = new Map();
function load() {
  files = new Map();
  try {
    for (const f of fs.readdirSync(DIR)) if (FILE_RE.test(f)) files.set(f.replace(/\.[^.]+$/, ''), f);
  } catch { /* pasta ainda não existe */ }
}
load();

// URL do escudo do time, ou null se não houver arquivo
const crestUrl = name => (files.has(key(name)) ? `/escudos/${files.get(key(name))}` : null);

module.exports = { DIR, FILE_RE, key, crestUrl, load };
