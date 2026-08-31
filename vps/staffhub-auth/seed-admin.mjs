// staffhub-auth — seed do 1º admin (roda na VPS, junto do auth.db):
//   node seed-admin.mjs <nick> <senha>
// Cria OU promove a conta para admin/active com a senha dada. Use no deploy e
// no resgate (deploy-auth.mjs --reset-admin).
import { randomUUID } from 'node:crypto';
import { q, nowIso } from './db.mjs';
import { hashSenha } from './auth.mjs';

const [nick, senha] = process.argv.slice(2);
if (!nick || !senha || senha.length < 8) {
  console.error('uso: node seed-admin.mjs <nick> <senha (>= 8 caracteres)>');
  process.exit(2);
}

const existente = q.userPorNick.get(nick);
if (existente === undefined) {
  const { salt, hash } = hashSenha(senha);
  q.inserirUser.run(randomUUID(), nick, hash, salt, 'admin', 'active', nowIso());
  console.log(`admin "${nick}" criado (active).`);
} else {
  const { salt, hash } = hashSenha(senha);
  q.atualizarSenha.run(hash, salt, existente.id);
  q.revogarTodosDoUser.run(existente.id);
  q.promoverAdmin.run(nowIso(), existente.id);
  console.log(`conta "${nick}" promovida/redefinida para admin/active (sessões antigas revogadas).`);
}
