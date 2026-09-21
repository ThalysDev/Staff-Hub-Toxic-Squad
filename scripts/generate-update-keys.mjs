// Gera o par de chaves Ed25519 que assina os manifests do canal de atualização
// (integridade independente do transporte — o canal é HTTP puro por decisão do
// dono, então a confiança vem da ASSINATURA, não do TLS).
//
// Uso: node scripts/generate-update-keys.mjs [--force]
// - Chave PRIVADA → dist/vps/update-keys/update-private.key (fora do git;
//   dist/ é gitignored — mesmo lugar da chave SSH do publish-update).
// - Chave PÚBLICA → impressa no terminal e gravada em update-public.b64.
//   A pública vai EMBEBIDA em src/shared/updater-core.ts (UPDATE_PUBKEY_B64).
// - Idempotente: sem --force, NÃO sobrescreve a chave existente (só imprime a
//   pública dela). --force GERA OUTRO PAR — assinaturas antigas deixam de
//   validar e o UPDATE_PUBKEY_B64 do app precisa ser atualizado + nova release.
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const keysDir = fileURLToPath(new URL('../dist/vps/update-keys', import.meta.url));
const privPath = join(keysDir, 'update-private.key');
const pubB64Path = join(keysDir, 'update-public.b64');
const force = process.argv.includes('--force');

function publicaDaPrivada(caminho) {
  // createPublicKey deriva a pública a partir da privada (PKCS8 PEM).
  return createPublicKey(readFileSync(caminho)).export({ format: 'der', type: 'spki' }).toString('base64');
}

if (existsSync(privPath) && !force) {
  console.error(`Chave privada já existe em ${privPath} — nada foi sobrescrito.`);
  console.error('Para gerar OUTRO PAR (invalida TODAS as assinaturas publicadas; exige nova release com UPDATE_PUBKEY_B64 novo), rode com --force.');
  console.log('\nChave PÚBLICA da chave existente (base64 SPKI):');
  console.log(publicaDaPrivada(privPath));
  process.exit(0);
}

mkdirSync(keysDir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// 0600: a privada nunca deve ficar legível para outros usuários (efetivo em
// POSIX; no Windows a proteção vem do perfil do usuário).
writeFileSync(privPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
writeFileSync(pubB64Path, `${pubB64}\n`, { mode: 0o600 });

console.log(`✓ Par Ed25519 gerado em ${keysDir}`);
console.log(`  privada: ${privPath} (NUNCA entre no git; use só no publish-update.mjs)`);
console.log('\nChave PÚBLICA (base64 SPKI) — cole em src/shared/updater-core.ts → UPDATE_PUBKEY_B64:');
console.log(pubB64);
