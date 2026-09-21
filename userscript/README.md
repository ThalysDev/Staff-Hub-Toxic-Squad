# Staff Hub In-Game — userscript Tampermonkey

O Quartel-General da Toxic Squad **dentro do jogo**: um userscript que roda na
própria página do Tribal Wars (qualquer sistema operacional — Windows, Linux,
Mac — só precisa do navegador + Tampermonkey), reutilizando os MESMOS engines
de cálculo do Staff Hub desktop (`src/shared`, via alias de build — zero cópia).

## Instalação (staff)

1. Instale a extensão **Tampermonkey** no navegador (Chrome/Edge/Firefox).
2. Abra o arquivo `staff-hub-in-game.user.js` enviado pelo líder (ou a URL do
   canal) — o Tampermonkey oferece a instalação.
3. Entre no jogo. Um botão **SH** aparece no canto inferior esquerdo.
4. Na primeira vez, o painel pede a **chave** emitida pelo líder. A chave fica
   vinculada à sua conta do jogo.

## Atualização

**Automática**: o header traz `@updateURL`/`@downloadURL` apontando para o canal
(`http://74.0.5.75/staffhub/scripts/staff-hub-in-game.meta.js`) — sempre que o
líder bumpa `userscript/version.json`, roda o build e publica, o Tampermonkey
oferece a versão nova (checagem periódica/no início do navegador; basta reabrir
o jogo). As chaves e os dados continuam salvos. Fallback manual: o líder envia
o `.user.js` novo e a staff reinstala por cima.

## Módulos

- **Conferência** (página de uma aldeia): comandos chegando ao vivo, risco por
  ataque, diff entre rodadas salvas.
- **Tropas & Defesa**: coleta completa ou resumo (1 requisição), Resumo Geral,
  contador FULL/SEMI, conferência de blind, histórico/auditoria da tribo.
- **Planner de OP**: grupos, geração (otimizado etc.) e export byte-fiél
  (Russian Planner / TW Mass Planner / JSON), agenda de envio com bônus
  noturno e trem de nobres.
- **Blindagem** (página do tópico no fórum): conferência dos pedidos `p/l/e/a`,
  atualização da tabela do 1º post e limpeza de comentários (com confirmações).
- **OD de guerra**: ODA/ODD da tribo a partir dos dumps oficiais de kills.
- **Reservas & MPs**: reservar coordenadas e MPs em cadeia direto no jogo
  (com toda a disciplina de confirmação/pacing do hub).

## Chave

A chave é pessoal e vinculada à sua conta do jogo no primeiro uso. Emitida pelo
líder no painel do Staff Hub (Admin → Chaves In-Game). Revogação propaga em até
24h + próximo acesso.

## Segurança

- Sessão do jogo = a SUA sessão do navegador (nada de sid importado/rotacionado).
- Pacing ≥200ms entre requisições, serializado; detect-pause de captcha.
- Mutações: confirmação dupla, 1 tentativa, sem retry cego, journal local.
- Sem CAPTCHA-solver, sem fingerprint, sem telemetria de jogo.

## Build (dev)

```
node userscript/build.mjs            # gera dist/staff-hub-in-game.user.js
node userscript/build.mjs --watch    # rebuild contínuo
node node_modules/typescript/bin/tsc --noEmit -p userscript/tsconfig.json
```

Versão: edite `userscript/version.json` (o header do .user.js é gerado dela).

## Publicação (líder)

Canal em produção no VPS: `http://74.0.5.75/staffhub/scripts/` (nginx +
`/var/www/staffhub-updates/scripts/`). O script de publicação sobe os dois
arquivos de `userscript/dist/` via SFTP:

```
node scripts/publish-userscript.mjs
```

1. `staff-hub-in-game.user.js` → instalação/`@downloadURL` (URL estável + cópia
   versionada `staff-hub-in-game-<versão>.user.js`);
2. `staff-hub-in-game.meta.js` → `@updateURL` (só o header — o Tampermonkey
   compara a `@version` dele para decidir pela atualização).

Antes de subir, o publish valida que a `@version` do `.user.js` bate com a
`version.json` (dist stale aborta), que o header traz `@grant unsafeWindow`
(essencial: sem ele o sandbox do Tampermonkey esconde o game_data do jogo) e
que a `@version` do `.meta.js` é igual à do `.user.js` — aborta em qualquer
divergência — e imprime as URLs públicas + o `sha256` dos dois arquivos.
Bump de versão: edite `userscript/version.json`, rode o build e o publish —
a atualização chega sozinha para quem já tem instalado.
