# Staff Hub Toxic Squad — Documento de Contexto Completo

> **Versão**: 0.9.1 · **Data**: 25/08/2026 · **Stack**: Electron 43 + React 19 + TypeScript strict
> **Público**: desenvolvedores que vão entender, manter ou evoluir o projeto

---

## 1. O que é

O **Staff Hub Toxic Squad** é um aplicativo desktop (Electron, Windows) para a **liderança de uma tribo no Tribal Wars BR** (jogo de estratégia medieval da InnoGames). Ele replica e amplifica os fluxos de uma ferramenta interna anterior ("Central de Defesa Op", do mundo 125) que existia como conjunto de userscripts — trazendo os mesmos 7 módulos de funcionalidade para um app standalone com melhor UX, testes automatizados e política de segurança rigorosa.

**Quem usa**: o dono da tribo (líder/fundador) e eventuais líderes de outras tribos. A ferramenta roda na conta de liderança do usuário (via sessão do jogo importada), lê páginas internas da tribo e executa ações no jogo.

**Diferencial em relação à ferramenta original**: mesma linguagem, mesmos rótulos em PT-BR, mesmos fluxos — mas com interface gráfica própria (tema pergaminho medieval), testes automatizados contra fixtures reais do jogo, journal auditável, pacing humano, confirmação dupla em mutações, e sem depender de userscripts injetados no navegador.

---

## 2. Como o projeto nasceu

1. O dono transcreveu (via IA de vídeo) 7 vídeos tutoriais da ferramenta original (SG_1 a SG_7), resultando em transcrições + capturas de tela que viraram a **especificação funcional** (`docs/MODULOS-SG.md`);
2. Uma onda de sub-agentes (implementer, designer, reviewer, see-images) extraiu rótulos, formatos, regras de negócio e layouts das transcrições e capturas;
3. O código foi implementado em ondas paralelas por agentes `implementer` (DeepSeek) sobre um design system pré-existente, com integração serial pelo agente principal;
4. Cada fase foi revisada por um agente `reviewer` independente, e os achados foram corrigidos antes do commit;
5. Todo o sistema foi validado contra **fixtures HTML reais capturadas do mundo BR142** (a tribo real do dono: "Toxic Squad Sul", tag `Toxic!`).

---

## 3. Arquitetura

```
staff-hub-toxic-squad/
├─ build/                  # icon.ico (multi-tamanho BMP real) + scripts de build
├─ docs/
│  ├─ MODULOS-SG.md        # ⭐ especificação funcional completa (fonte da verdade)
│  ├─ REFERENCIA-NEXUS.png # referência visual do tema
│  └─ design/
├─ src/
│  ├─ main/                # processo principal Electron (Node)
│  │  ├─ index.ts          # entrypoint: janelas, IPC, wiring geral
│  │  ├─ tw/
│  │  │  ├─ session.ts     # TwSessionManager (partição persist:tw, login real ou SID)
│  │  │  └─ request-queue.ts # RequestQueue (pacing, teto, retry, sentinelas)
│  │  ├─ services/
│  │  │  ├─ world-data-service.ts  # dumps oficiais (village/player/ally .txt.gz)
│  │  │  ├─ sg1-service.ts         # análise de aldeias/distâncias
│  │  │  ├─ troops-service.ts      # coleta tropas/defesa (resumo + por membro)
│  │  │  ├─ sg5-service.ts         # verificação de comandos
│  │  │  └─ supporters-service.ts  # apoiadores
│  │  ├─ mutations/
│  │  │  ├─ sg6-service.ts         # reservas em massa + MPs (MUTAÇÕES)
│  │  │  └─ sg7-service.ts         # fórum blindagem (MUTAÇÕES)
│  │  ├─ ipc-*.ts          # handlers IPC por domínio
│  │  ├─ stores/           # JsonStore (persistência atômica em userData)
│  │  └─ journal.ts        # journal auditável de todas as operações
│  ├─ preload/index.ts     # contextBridge tipado (contrato StaffHubApi)
│  ├─ shared/              # código puro (parsers, engines, tipos) — 100% testável
│  │  ├─ types.ts          # modelo de dados do mundo + contratos de análise
│  │  ├─ ipc-types.ts      # ⭐ contrato IPC (evolui PRIMEIRO, depois main/preload)
│  │  ├─ units.ts          # catálogo de unidades BR + população
│  │  ├─ coords.ts         # parse/format de coordenadas + continentes K
│  │  ├─ distance.ts       # distância euclidiana + tempo de viagem
│  │  ├─ buckets.ts        # 11 faixas de tempo de nobre (rótulos originais)
│  │  ├─ formatters.ts     # formatadores (nick;qtde;coords, BBCode)
│  │  ├─ world-config.ts   # parser do get_config XML
│  │  ├─ sg1-engine.ts     # motor de análise SG_1
│  │  ├─ sg2-engine.ts     # motor de filtros SG_2/SG_3
│  │  ├─ sg3-engine.ts     # motor de blind SG_3
│  │  ├─ sg4-engine.ts     # motor de operações SG_4
│  │  ├─ sg7-engine.ts     # motor de blindagem fórum SG_7
│  │  └─ parsers/
│  │     ├─ ally-parsers.ts       # páginas de tribo (membros, tropas, defesa, contratos)
│  │     ├─ world-parsers.ts      # dumps do mundo + unit-info XML
│  │     ├─ village-parsers.ts    # comandos, unidades próprias
│  │     └─ forum-parsers.ts      # tópicos do fórum
│  └─ renderer/            # React (tema pergaminho medieval)
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx         # roteamento por estado (sem lib de roteamento)
│        ├─ assets.ts       # ícones TW + logos
│        ├─ assets/
│        │  ├─ brand/       # logos (wide + square 256px)
│        │  ├─ tw/units/    # 13 ícones de unidades (PNG do CDN do jogo)
│        │  └─ tw/res/      # 3 ícones de recursos
│        ├─ components/     # TitleBar, Sidebar, EmptyState, StatBlock, etc.
│        ├─ hooks/          # useToast, useSessionStatus
│        ├─ pages/
│        │  ├─ DashboardPage.tsx
│        │  ├─ SessionPage.tsx
│        │  ├─ SettingsPage.tsx
│        │  ├─ JournalPage.tsx
│        │  ├─ CapturesPage.tsx
│        │  └─ sg1..sg7/    # uma página por módulo SG
│        └─ styles/         # tokens.css + app.css (tema pergaminho flat)
├─ tests/
│  ├─ fixtures/br142/      # ⭐ 25+ HTMLs REAIS capturados do BR142 (parsers testam contra estes)
│  ├─ main/                # testes de request-queue, parse-sid
│  └─ diag/                # diagnósticos pontuais
├─ electron.vite.config.ts # build main/preload/renderer
├─ vitest.config.ts
├─ tsconfig.node.json      # main + preload + shared
├─ tsconfig.web.json       # renderer + shared
└─ AGENTS.md               # ⭐ regras do repo (leia ANTES de codificar)
```

### Padrões-chave

| Conceito | Como funciona |
|----------|---------------|
| **Contrato IPC** | Toda ponte renderer ↔ main começa em `src/shared/ipc-types.ts` (interface `StaffHubApi`). O preload implementa, o main registra handlers com os mesmos nomes. Nada passa direto. |
| **Fail-closed** | Parsers lançam `ParseError` com mensagem clara em estrutura inesperada. Nunca retornam dados errados silenciosamente. |
| **Pacing** | Toda requisição ao jogo passa pela `RequestQueue` (350ms mínimo + jitter das settings) ou pelo pacing direto dos serviços. Teto por operação (settings). |
| **Mutações** | Reservas, MPs, edição/apagamento no fórum: confirmação dupla na UI, UMA tentativa por item (nunca reenvio automático), journal obrigatório. **Modo real permanente** (decisão do dono 25/08/2026 — sem dry-run). |
| **Sessão** | Partição Chromium `persist:tw`. Login real (janela com o jogo, captcha resolvido pelo usuário) **ou** import de sid via EditThisCookie (autorizado pelo dono). Restauração automática ao reiniciar (lê cookies da partição → valida com probe). |
| **Fixtures** | Todo parser novo é testado contra HTML real capturado do BR142 (em `tests/fixtures/br142/`). Nenhum teste usa HTML inventado. |
| **Fail-safe de coleta** | Membro com erro NÃO aborta a coleta — o serviço coleta o máximo possível e registra falhas em `snapshot.failures[]`, que a UI exibe numa tabela. |

---

## 4. Os 7 módulos (SG_1 a SG_7)

| # | Nome | O que faz | Fonte de dados |
|---|------|-----------|----------------|
| **SG_1** | Análise de Aldeias e Distâncias | Buckets de tempo de nobre (11 faixas: <1h até >34h) entre a tribo própria e inimigas; mapa mundial interativo com cores por tribo (pré-marcadas pela diplomacia) | Map dumps oficiais (`/map/village.txt.gz`, `/map/player.txt`, `/map/ally.txt`) + página de diplomacia |
| **SG_2** | Análise de Tropas das Aldeias | Coleta tropas recrutadas de todas as aldeias da tribo (por membro, com pacing); filtros combináveis (possui/não possui, por aldeia/por jogador, coords, eixos); classificação ofensiva vs defensiva | `ally&mode=members_troops` (por membro) + resumo (1 requisição) |
| **SG_3** | Análise de Defesa das Aldeias | Blind (quanto falta por aldeia para atingir unidades desejadas, modo "paradas" vs "paradas+a caminho"); tabela BBCode para o fórum; apoiadores | `ally&mode=members_defense` (por membro) |
| **SG_4** | Criação de Operações | OP por coordenada central (camadas 1–8h, separa alvos/fakes); distribuição de alvos com planilha heatmap (horas + moral), prioridade nearest/farthest, moral mínima, distância máxima | Map dumps + input manual (origens `nick;fulls;coords`) |
| **SG_5** | Conferência de Comandos | Verificação alvo-a-alvo (quem está atacando cada aldeia-alvo da OP); totalizador por jogador (ataques, fakes, nobres, suportes); impressão com título editável | Página `info_village` de cada alvo (comandos compartilhados) |
| **SG_6** | Reservas e MPs | Reserva em massa de coordenadas no Planejador; MPs personalizadas em cadeia (placeholder `#alvos#` substituído pelas coords de cada nick) | **MUTAÇÕES**: formulários nativos do jogo |
| **SG_7** | Blindagem no Fórum | Conferência de posts no formato rígido `pedido/lanceiros/espadachins/arqueiros`; ajuste do post da tabela (subtrai faltas); apagamento de mensagens processadas | **MUTAÇÕES**: edição de post + moderação no fórum |

### Encadeamento entre módulos

```
SG_1 gera coords → SG_2/SG_3 usam como filtro → SG_3 gera BBCode
→ SG_4 distribui alvos → SG_5 verifica quem atacou → SG_6 envia MPs
→ SG_7 gerencia blindagem no fórum
```

---

## 5. Sessão e autenticação

O app **não tem senha própria**. A autenticação é a sessão do jogo Tribal Wars:

1. **Login real**: abre uma janela Electron com o portal oficial. O usuário faz login no jogo normalmente (captcha é com ele). Quando entra num mundo (`br###.tribalwars.com.br/game.php`), o app detecta e fecha a janela.
2. **Import de sid**: o usuário copia o export completo do EditThisCookie (extensão Chrome) do navegador logado e cola no campo. O parser extrai o cookie `sid` do domínio correto + cookies companheiros (`br_auth`, `cid`, etc.) e grava na partição.
3. **Restauração automática**: ao reiniciar, o app lê os cookies persistidos da partição, descobre o mundo pelo domínio do cookie sid, e valida com um probe (`game.php?screen=overview` + body `id="ds_body"`).

**Nunca fazer**: captcha-solver, fingerprint spoofing, rotação automática de sid. A linha é a função, não o vendor.

---

## 6. Segurança e política

Definidas em `AGENTS.md` (leia antes de codificar):

- **Sem evasão** — nunca captcha-solver, fingerprint ou rotação de sid, de nenhum fornecedor;
- **Pacing humano** — mínimo 350ms entre requisições + jitter;
- **Teto** — limite de requisições por operação (settings, default 400);
- **Journal** — toda operação (leitura em massa, mutação, evento de sessão) fica registrado;
- **Fail-closed** — estrutura inesperada = erro claro, nunca dado errado silencioso;
- **Modo real** — mutações executam de verdade (decisão do dono 25/08/2026); sem dry-run.

---

## 7. Como rodar

```bash
# Setup (uma vez)
pnpm install

# Desenvolvimento (hot reload)
pnpm dev

# Gates (antes de qualquer commit)
pnpm typecheck   # tsc x2 (node + web)
pnpm test        # vitest (169 testes)
pnpm build       # electron-vite build

# Empacotar portable Windows
# 1. Build:
pnpm build
# 2. Staging:
mkdir -p dist/app-stage && cp -r out dist/app-stage/
node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));fs.writeFileSync('dist/app-stage/package.json',JSON.stringify({name:'staff-hub-toxic-squad',productName:'Staff Hub Toxic Squad',version:pkg.version,main:'out/main/index.js'},null,2))"
# 3. Package (precisa de internet p/ baixar o Electron — cacheado depois):
pnpm dlx @electron/packager dist/app-stage "Staff Hub Toxic Squad" --platform=win32 --arch=x64 --electron-version=43.4.1 --out=dist/packages --icon=build/icon.ico --overwrite
```

> **Nota**: o `electron-builder` não funciona nesta máquina (npm CLI ausente — Node veio via pnpm). Use `@electron/packager` (via `pnpm dlx`), que não precisa de npm.

### Dados locais (userData)

Os dados do app ficam em `%APPDATA%/Staff Hub Toxic Squad/`:

```
stores/
├─ world-data.json        # cache dos dumps (TTL 6h)
├─ troops-snapshots.json  # tropas + defesa + defenseVillages
├─ unit-info.json         # velocidades das unidades (TTL 24h)
├─ world-config.json      # config do mundo (TTL 24h)
├─ settings.json          # pacing, teto, etc.
└─ journal.json           # journal auditável
fixtures/                  # capturas de tela do jogo (para testes)
```

---

## 8. Estado atual (25/08/2026)

### ✅ Entregue e funcionando
- Todos os 7 módulos SG implementados, testados (169 testes), revisados e corrigidos;
- Tema pergaminho medieval com a logo da tribo (titlebar personalizada, sidebar, hero);
- Login por janela real **ou** import de sid (EditThisCookie), com restauração automática ao reiniciar;
- Portable Windows funcional (`dist/packages-v*/Staff Hub Toxic Squad-win32-x64/` + `.zip` no Desktop);
- Ícone customizado no executável (multi-tamanho BMP real).

### ⚠️ Limitações conhecidas
- O jogo não renderiza a tabela de tropas por aldeia para o **próprio jogador logado** (ignora o player_id) — o app usa a tela `overview_villages&mode=units` como fallback;
- A fórmula da moral está com `(def/att)^0.75` (clássica) — calibração fina contra o jogo pendente;
- Instalador NSIS formal não disponível (electron-builder precisa de npm CLI; use o portable);
- Compartilhamento de comandos (SG_5) depende de os membros ativarem a opção no jogo;
- Exclusão automática de posts no SG_7 é manual via moderação (automação futura).

---

## 9. Contatos e contexto

- **Dono**: líder/fundador da tribo Toxic Squad no BR142 (mundo de teste); conta com acesso de líder;
- **Origem**: ferramenta transcrita de vídeos do mundo 125 (Tribo JuJu vs KINGS);
- **Repo local**: `C:\Users\Usuário\.zcode\workspace\default\staff-hub-toxic-squad` (git local, sem remote — o dono cria o GitHub quando quiser);
- **Portable para testes**: `C:\Users\Usuário\Desktop\StaffHubToxicSquad-0.9.1.zip`.

---

## 10. Para o desenvolvedor que recebeu este projeto

1. **Leia o `AGENTS.md` primeiro** — tem as regras do repo;
2. **Rode `pnpm install` + `pnpm dev`** para ver o app funcionando;
3. **Não toque em `src/shared/ipc-types.ts`** sem entender o padrão: contrato evolui primeiro, depois main/preload/renderer;
4. **Todo parser novo precisa de fixture real** — copie a tela do jogo, salve em `tests/fixtures/br142/`, e escreva o teste contra ela;
5. **Rode os gates** (`pnpm typecheck && pnpm test && pnpm build`) antes de qualquer commit;
6. **A spec funcional está em `docs/MODULOS-SG.md`** — é a fonte da verdade para rótulos, formatos e encadeamento;
7. Se for adicionar um módulo novo, siga o padrão de um existente (SG_2 é o mais completo: parser + engine + service + IPC + page).
