# Staff Hub Toxic Squad — Runbook de Operações (VPS)

> **Público**: quem opera a VPS `74.0.5.75` (canal de atualização, API de login, cert).
> **Acesso**: SSH com chave ed25519 em `dist/vps/id_staffhub` (ou `STAFFHUB_VPS_KEY`) —
> **fora do git**; usuário `root`. Nada aqui exige editar código.
> **Estado**: árvore 0.35.2, canal em preparação para 0.36.0 (itens marcados ⚠ 0.36 só
> valem quando a release sair).

---

## 1. Canal de atualização

> **Requisito da máquina de publicação:** Node ≥ 22.18 (o `publish-update.mjs` importa
> `src/shared/updater-core.ts` direto de um `.mjs` — exige type-stripping nativo). A VPS
> roda o servidor com Node puro. (`http://74.0.5.75/staffhub/`)

### Layout no servidor

O nginx serve o diretório `/var/www/staffhub-updates/` na raiz `/staffhub/` (HTTP puro na
:80 — a integridade vem da **assinatura Ed25519 do manifest**, não do transporte):

```
/var/www/staffhub-updates/
├─ StaffHubToxicSquad-<versão>.zip   # um zip por release (portable win32-x64)
├─ latest.json                       # ponteiro que os clients consomem (ASSINADO ⚠ 0.36)
└─ versions.json                     # inventário de TODAS as versões (rollback) ⚠ 0.36
```

- `latest.json`: `{version, notes, url, sha256, releasedAt, sig}` — o `sig` cobre a string
  canônica `version\nurl\nsha256\ncomprimento-das-notas` com a chave privada do canal.
- `versions.json`: array `[{version, url, sha256, sig, releasedAt}]` — o `sig` da entrada
  cobre o MESMO canônico com notes vazio. Escrita atômica (`.tmp` + rename).
- Zips publicados **antes** da 0.36.0 não têm inventário nem assinatura — o rollback
  in-app só cobre versões que estão no `versions.json` (§2).

### Como publicar (fluxo normal)

```bash
node scripts/release.mjs <versão> "<notas>"
# ex.: node scripts/release.mjs 0.36.0 "Hardening do atualizador"
```

Faz tudo: gates (`typecheck` + `test` + `build`) → bump do `package.json` → rebuild →
package → zip → **publish** → copia o zip para o Desktop.

### Como republicar (mesma versão, zip/notas corrigidos)

```bash
node scripts/publish-update.mjs <caminho-do-zip> <versão> "<notas>"
```

Idempotente: sobe o zip, faz upsert da entrada em `versions.json` e reescreve o
`latest.json` **por último** (é o ponteiro — só vira depois que zip + inventário estão no
ar). As guardas locais falham ANTES de qualquer upload se: zip/chave ausentes, versão fora
do formato `X.Y.Z` ou **notas acima de 600 caracteres** (`MAX_NOTES_LENGTH` em
`src/shared/updater-core.ts`) — notas gigantes viram um manifest que TODO client rejeita.

### Chaves do canal

- **Assinatura**: `node scripts/generate-update-keys.mjs` — privada em
  `dist/vps/update-keys/update-private.key` (fora do git), pública impressa e EMBEBIDA em
  `src/shared/updater-core.ts` (`UPDATE_PUBKEY_B64`). Idempotente; `--force` gera OUTRO par
  e **invalida todas as assinaturas publicadas** — só usar junto de uma release nova com a
  constante atualizada (clients antigos só aceitam manifest assinado pela chave que eles
  embutem).
- **SSH**: `dist/vps/id_staffhub` (o script usa `root@74.0.5.75:22`).

### Verificações rápidas

```bash
curl -s http://74.0.5.75/staffhub/latest.json | head -5      # ponteiro atual
curl -s http://74.0.5.75/staffhub/versions.json | head -20   # inventário
```

---

## 2. Recuperação de release ruim

### 2.1 Rollback de versão

✅ **Desde a 0.36.0 o rollback tem TELA**: Configurações → seção de versões anteriores
(lista vem do `versions.json` assinado; download + reinício pelo mesmo pipeline do
update). Antes disso (≤0.35.2) existia só o serviço/IPC, sem tela. Se uma release
ruim precisar sair do ar:

1. **Republique a última versão boa no canal** (§1 ou §2.3) — o ponteiro `latest.json`
   volta e quem ainda não atualizou para a versão ruim para de recebê-la;
2. Quem JÁ atualizou: oriente o **rollback pela própria tela** (regra abaixo) ou a
   recuperação manual (§2.2).

A tela segue as regras de hardening já implementadas no serviço:

- Só lista versões **estritamente mais antigas** que a instalada;
- Cada entrada é validada fail-closed (sha 64-hex + assinatura + **pin de host** — o zip
  tem que vir do host do canal);
- Zips pré-0.36.0 não estão no inventário → rollback in-app indisponível para eles
  (use §2.2 ou republique conforme §1).

### 2.2 O app NÃO abre — pasta `shb-old-*` + `RECUPERACAO.txt`

Durante a troca, a pasta antiga do app é renomeada para `shb-old-<carimbo>` **ao lado** da
pasta do app (ex.: no Desktop) e o script grava um `RECUPERACAO.txt` na mesma pasta-pai com
o comando manual de uma linha. O script também tem reparo automático, mas no pior caso
(ele mesmo não consegue rodar):

1. Abra a pasta onde o app estava instalado (ex.: Desktop);
2. Localize `RECUPERACAO.txt` (escrito na última troca) — ele contém exatamente:
   ```
   Rename-Item -LiteralPath "<pasta-backup-shb-old-...>" -NewName "<nome-da-pasta-do-app>"
   ```
3. Execute essa linha no PowerShell;
4. Se não houver `RECUPERACAO.txt`, faça na mão:
   - Se a pasta do app existe mas está quebrada: renomeie-a (ex.: `...-quebrada`);
   - Renomeie a `shb-old-<carimbo>` mais recente para o nome original da pasta do app
     (ex.: `Staff Hub Toxic Squad-win32-x64`);
   - Abra o `.exe` de dentro dela.
5. O backup `shb-old-*` fica 7 dias e o script de troca limpa os mais velhos sozinho —
   se precisar dele para recuperação, NÃO deixe passar da semana.

**Diagnóstico póstumo** (em `%APPDATA%/Staff Hub Toxic Squad/`): `updates/updater-debug.log`
(uma linha por etapa do download/extração) e `updates/swap-debug.log` (fases do script de
troca).

### 2.3 Reverter o CANAL para uma versão anterior

`latest.json` aceita qualquer versão — republicar um zip antigo (§1) faz o ponteiro voltar.
Atenção: clients **já atualizados** não recebem downgrade via banner (update só anuncia
versão ESTRITAMENTE maior) — eles usam o rollback in-app (§2.1) ou ficam na versão nova.

---

## 3. API de login (`staffhub-auth`)

Node puro + `node:sqlite` na `127.0.0.1:8787`, atrás do nginx `:443`
(`https://74.0.5.75/staffhub/api/`, cert self-signed pinado no app — §4). Fontes em
`vps/staffhub-auth/` no repo; deploy idempotente por `node scripts/deploy-auth.mjs`.

### Backup (automático)

Cron diário **04:30** (`/etc/cron.d/staffhub-auth-backup`): `VACUUM INTO`
`/var/backups/staffhub-auth/auth-AAAA-MM-DD.db`, retenção **14 dias**.

### Restore manual

```bash
runuser -u Thalys -- pm2 stop staffhub-auth
cp /var/backups/staffhub-auth/auth-<data>.db /home/Thalys/staffhub-auth/auth.db
chown Thalys:Thalys /home/Thalys/staffhub-auth/auth.db
runuser -u Thalys -- pm2 start staffhub-auth
curl -s --cacert /etc/nginx/ssl/staffhub-api.crt https://74.0.5.75/staffhub/api/healthz
```

### Admin

- **Seed/reset de senha** (imprime a senha nova UMA VEZ — não guardamos em lugar algum):
  ```bash
  node scripts/deploy-auth.mjs --reset-admin <nick>
  ```
  (roda da sua máquina; usa a chave SSH. O deploy normal NÃO reseta admin existente.)
- **O único admin ativo não pode ser banido**: a API recusa com **409**
  ("Não é possível banir o único administrador ativo"). Se precisar banir um admin, crie/
  reabilite OUTRO admin antes.
- **Lockout de login por tentativas erradas** (diferente de banimento): 5 falhas por nick
  (ou 10 por IP) numa janela de 10 min bloqueiam por 15 min — aguarde, não é trava
  permanente. Cadastro de contas também tem rate-limit (anti-spam de pendentes).

### Saúde

```bash
curl -s --cacert /etc/nginx/ssl/staffhub-api.crt https://74.0.5.75/staffhub/api/healthz
runuser -u Thalys -- pm2 describe staffhub-auth | head -5
```

---

## 4. Certificado self-signed (pin no app)

`/etc/nginx/ssl/staffhub-api.crt` + `.key` — RSA 2048, SAN IP `74.0.5.75`, validade
**825 dias** (atual: vence **03/12/2028**). O app se recusa a falar com a API sem ESTE cert
(pin embutido) — MITM sem a chave privada falha o handshake.

### Verificar expiração (faça isso de vez em quando)

```bash
openssl x509 -enddate -noout -in /etc/nginx/ssl/staffhub-api.crt
```

### Renovar

1. Na VPS, remova o cert antigo (o deploy só cria se não existir):
   ```bash
   rm /etc/nginx/ssl/staffhub-api.crt /etc/nginx/ssl/staffhub-api.key
   ```
2. Da sua máquina: `node scripts/deploy-auth.mjs` — recria o cert (825 dias), recarrega o
   nginx e baixa o novo cert para `src/main/assets/staffhub-ca.pem`;
3. **Atualize o pin no app**: copie o conteúdo do novo PEM para a constante
   `STAFFHUB_CA_PEM` em `src/main/auth-ca.ts` (é ELA que o `AuthService` usa em runtime) e
   solte uma release nova — senão os clients instalados param de autenticar quando o cert
   antigo vencer.

### O que acontece se vencer sem renovação

O TLS do canal de login passa a falhar no handshake → ninguém loga. O app não quebra:
quem já está logado entra na graça **offline-72h** (modo guerra) e o atualizador/journal
continuam funcionando (canais ungated). Renove com folga.

---

## 5. PM2 (processo da API)

A API roda como processo PM2 `staffhub-auth` do usuário **Thalys**
(`/home/Thalys/staffhub-auth/server.mjs`). O deploy roda `pm2 save` (persiste a lista de
processos).

### ⚠ Pendência conhecida: startup no reboot

O `pm2 startup` (unidade systemd que ressuscita os processos após reboot da VPS) **NÃO está
configurado**. Se a VPS reiniciar, a API fica fora do ar até alguém subir na mão:

```bash
runuser -u Thalys -- pm2 resurrect   # restaura do dump gravado pelo pm2 save
# ou, se o dump não existir:
runuser -u Thalys -- pm2 start /home/Thalys/staffhub-auth/server.mjs --name staffhub-auth --cwd /home/Thalys/staffhub-auth
```

Para resolver em definitivo (uma vez, como root):
`runuser -u Thalys -- pm2 startup` seguido do comando `systemctl enable` que ele imprimir.
Enquanto isso não for feito, **inclua "subir a staffhub-auth" no checklist pós-reboot da
VPS**.

---

## 6. Resumo de responsáveis (quem mexe no quê)

| Item | Onde | Ferramenta |
|------|------|------------|
| Publicar release | `scripts/release.mjs` / `publish-update.mjs` | chave SSH + chave Ed25519 do canal |
| Rollback de versão | Início do app (in-app) ou `publish-update.mjs` | `versions.json` |
| Login/contas | `vps/staffhub-auth/` + `scripts/deploy-auth.mjs` | `--reset-admin <nick>` |
| Cert do canal de login | `/etc/nginx/ssl/staffhub-api.*` + `src/main/auth-ca.ts` | `deploy-auth.mjs` + release |
| Backup do auth DB | `/var/backups/staffhub-auth/` (cron 04:30, 14 dias) | restore manual §3 |
