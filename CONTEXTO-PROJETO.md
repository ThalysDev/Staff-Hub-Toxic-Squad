# Staff Hub Toxic Squad — Documento de Contexto Completo

> **Versão**: 0.36.0-prep (árvore em 0.35.2) · **Data**: 20/09/2026 · **Stack**: Electron 43 + React 19 + TypeScript strict
> **Testes**: Vitest — **951 testes em 62 arquivos, todos verde** (`pnpm test`; medido em 20/09/2026)
> **Público**: desenvolvedores que vão entender, manter ou evoluir o projeto

---

## 1. O que é

O **Staff Hub Toxic Squad** é um aplicativo desktop (Electron, Windows) para a **liderança de uma tribo no Tribal Wars BR** (jogo de estratégia medieval da InnoGames). Ele replica e amplifica os fluxos de uma ferramenta interna anterior ("Central de Defesa Op", do mundo 125) que existia como conjunto de userscripts — trazendo os mesmos 7 módulos de funcionalidade para um app standalone com melhor UX, testes automatizados, política de segurança rigorosa, persistência de histórico e atualização automática.

**Quem usa**: o dono da tribo (líder/fundador) e a staff dele. O app tem **duas camadas de acesso independentes** (detalhadas na §5): a **conta do Staff Hub** (login do sistema, aprovado por um administrador) e a **sessão do jogo Tribal Wars** (a conta de liderança usada para ler páginas e executar ações no jogo).

**Diferencial em relação à ferramenta original**: mesma linguagem, mesmos rótulos em PT-BR, mesmos fluxos — mas com interface gráfica própria (tema pergaminho medieval com tema claro/escuro), testes automatizados contra fixtures reais do jogo (951 testes), journal auditável com filtros e export, pacing humano, confirmação dupla em mutações, histórico/evolução de tropas e do mundo, planner de OP em massa, login do sistema com gate central de produto, atualizador automático pelo canal próprio na VPS — e sem depender de userscripts injetados no navegador.

---

## 2. Como o projeto nasceu

1. O dono transcreveu (via IA de vídeo) 7 vídeos tutoriais da ferramenta original (SG_1 a SG_7), resultando em transcrições + capturas de tela que viraram a **especificação funcional** (`docs/MODULOS-SG.md`);
2. Uma onda de sub-agentes (implementer, designer, reviewer, see-images) extraiu rótulos, formatos, regras de negócio e layouts das transcrições e capturas;
3. O código foi implementado em ondas paralelas por agentes `implementer` sobre um design system pré-existente, com integração serial pelo agente principal;
4. Cada fase foi revisada por um agente `reviewer` independente, e os achados foram corrigidos antes do commit — prática que virou regra (**revisão dupla completa antes de toda release**, ver `AGENTS.md`);
5. Todo o sistema foi validado contra **fixtures HTML reais capturadas do mundo BR142** (a tribo real do dono: "Toxic Squad Sul", tag `Toxic!`) — hoje são **37 arquivos** em `tests/fixtures/br142/`.

Fases subsequentes (registradas no git e em `docs/MODULOS-SG.md`): Sprints 1–4 do Roadmap Estratégico (v0.9→v0.13), canal de atualização VPS (v0.15), melhorias da staff + auditoria (v0.16→v0.22), ondas Premium (v0.23–v0.26), auditoria do SG_4 (v0.27), Planner de OP em Massa na Sala de Guerra (v0.28→v0.29, escala real na v0.32, quartel-general fluido na v0.33), **login do sistema + proteção de acesso** (v0.30), fonte "Disponível na aldeia" no SG_2 (v0.31), abas Análise × Auditoria de Membros no SG_2 (v0.34) e auditoria UX/UI aplicada + banner global de atualização (v0.35).

---

## 3. Arquitetura

```
staff-hub-toxic-squad/
├─ build/                  # icon.ico (multi-tamanho BMP real)
├─ docs/
│  ├─ MODULOS-SG.md        # ⭐ especificação funcional (fonte da verdade) + Fluxos Premium + release notes
│  ├─ ROADMAP-ESTRATEGICO.md # síntese Produto/Código/UX com status por item
│  ├─ RUNBOOK-OPS.md       # manual operacional da VPS (canal de update, auth, cert)
│  └─ design/
├─ scripts/
│  ├─ release.mjs          # release 1 comando: gates → bump → build → packager → zip
│  │                       #   → publish no canal VPS → copiar zip p/ Desktop
│  ├─ publish-update.mjs   # publica zip + latest.json ASSINADO (Ed25519) + versions.json
│  │                       #   na VPS via SSH (chave FORA do git)
│  ├─ generate-update-keys.mjs # par Ed25519 que assina os manifests do canal
│  ├─ deploy-auth.mjs      # deploy idempotente da API staffhub-auth (--reset-admin)
│  ├─ e2e-update.mjs       # E2E vermelho/verde do atualizador (app empacotado)
│  └─ e2e-auth.mjs         # E2E do login (login real contra a VPS)
├─ src/
│  ├─ main/                # processo principal Electron (Node)
│  │  ├─ index.ts          # entrypoint: janelas, wiring, GATE CENTRAL de IPC
│  │  │                    #   (CANAIS_PROTEGIDOS exige sessão do sistema)
│  │  ├─ auth-ca.ts        # cert do canal de auth PINADO no app (STAFFHUB_CA_PEM)
│  │  ├─ ipc-auth.ts       # login/logout/contas do Staff Hub
│  │  ├─ updater-service.ts # atualizador: canal VPS, staging, troca via .ps1 externo,
│  │  │                    #   rollback pelo inventário versions.json, debug-log
│  │  ├─ tminus.ts         # notificações T-minus na bandeja (marcas configuráveis 1–1440 min)
│  │  ├─ tw/
│  │  │  ├─ session.ts     # TwSessionManager (partição persist:tw, login real ou SID)
│  │  │  └─ request-queue.ts # RequestQueue (pacing, teto, retry, sentinelas)
│  │  ├─ services/
│  │  │  ├─ auth-service.ts        # sessão do SISTEMA: tokens, offline-72h, gate
│  │  │  ├─ world-data-service.ts  # dumps oficiais (village/player/ally .txt.gz)
│  │  │  ├─ sg1-service.ts         # análise de aldeias/distâncias
│  │  │  ├─ troops-service.ts      # coleta tropas/defesa (resumo + por membro)
│  │  │  ├─ sg5-service.ts         # verificação de comandos
│  │  │  ├─ supporters-service.ts  # apoiadores
│  │  │  ├─ groups-service.ts      # grupos de destaque no jogo
│  │  │  └─ op-archive-service.ts  # arquivo de OPs
│  │  ├─ mutations/
│  │  │  ├─ sg6-service.ts         # reservas em massa + MPs (MUTAÇÕES)
│  │  │  └─ sg7-service.ts         # fórum blindagem (MUTAÇÕES)
│  │  ├─ ipc-*.ts          # handlers IPC por domínio: auth, world, troops, sg3, sg5, sg6, sg7,
│  │  │                    #   supporters, groups, op, history, templates, preferences,
│  │  │                    #   planner-draft
│  │  ├─ stores/json-store.ts # JsonStore (persistência atômica em userData)
│  │  └─ journal.ts        # journal auditável (journal.json, cap 10000 entradas)
│  ├─ preload/index.ts     # contextBridge tipado (contrato StaffHubApi)
│  ├─ shared/              # código puro (parsers, engines, tipos) — 100% testável.
│  │  │                    # Testes co-localizados: cada *.ts tem seu *.test.ts ao lado.
│  │  ├─ types.ts / ipc-types.ts   # modelo do mundo + ⭐ contrato IPC (evolui PRIMEIRO)
│  │  ├─ units, coords, distance, buckets, formatters, world-config, coord-input, fold
│  │  ├─ sg1-engine / sg2-engine / sg3-engine / sg7-engine / sg2-summary / sg2-defense-source
│  │  ├─ sg4-engine / sg4-timing        # distribuição + calculadora de envio + agenda
│  │  ├─ sg5-arrivals / sg5-diff / sg5-view-filter # Gantt, diff e filtros de visualização
│  │  ├─ mass-planner-*    # ⭐ planner de OP em massa: tipos, engine e formatos byte-fiéis
│  │  ├─ war-room / war-view-filter / op-archive-rules / op-export / op-comms / post-op / post-op-live
│  │  ├─ snapshot-history / member-audit # histórico de tropas + Auditoria de Membros (SG_2)
│  │  ├─ world-history     # evolução do mundo (agregados por tribo + delta de donos)
│  │  ├─ blind-debt / incoming-risk / night-bonus / full-semi / groups-rules
│  │  ├─ filter-presets / preferences-rules / mp-templates-rules / journal-filter / names-filter
│  │  ├─ comms-package / mp-preview / origins-from-snapshot / fakes-intelligent
│  │  ├─ spy-report        # parser de relatórios de espionagem (texto colado)
│  │  └─ updater-core      # manifest + assinatura Ed25519, semver, script de troca (buildSwapScript)
│  └─ renderer/            # React (tema pergaminho medieval, claro/escuro)
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx         # roteamento por estado + LoginPage trava + UpdateBanner global
│        ├─ theme.ts        # escolha de tema: system | claro | escuro
│        ├─ modules.ts / assets.ts
│        ├─ components/     # TitleBar, Sidebar, CommandPalette (Ctrl+K), TemplateLibrary,
│        │                 #   PresetManager, PageHeader, Field, ProgressBar, Toast,
│        │                 #   ErrorBoundary, StatBlock, StatusPill, EmptyState, Callout,
│        │                 #   UpdateBanner (banner GLOBAL de atualização, v0.35.2)
│        ├─ hooks/          # useToast, useSessionStatus, useQueueActivity, useAuthStatus,
│        │                 #   useUpdateStatus, usePreferences, useDiplomacyRelations,
│        │                 #   useKeyboardShortcuts (Ctrl+K + Alt+1..9)
│        ├─ pages/
│        │  ├─ DashboardPage.tsx  # scorecard da staff (configurável) + frente de operações
│        │  ├─ LoginPage / AdminPage / SessionPage / SettingsPage / JournalPage / CapturesPage
│        │  ├─ sg1..sg7/    # uma pasta por módulo SG (seções em componentes próprios);
│        │  │               #   sg2 tem as abas Análise × Auditoria de Membros (v0.34)
│        │  └─ war/         # Sala de Guerra: MassPlannerSection (aba Planner em Massa) +
│        │                  #   monitoramento (OpAgendaSection, OpMapSection, PostOpSection,
│        │                  #   OpShareSection, WorldEvolutionSection)
│        └─ styles/         # tokens.css + app.css + theme-dark.css
├─ tests/
│  ├─ fixtures/br142/      # ⭐ 37 HTMLs/XMLs REAIS capturados do BR142
│  ├─ main/                # request-queue, parse-sid, mutações com sessão mockada
│  ├─ warm/                # smoke de import do bundle
│  └─ diag/                # diagnósticos/canário (evidência de OP NUNCA vai ao git)
├─ vps/staffhub-auth/      # API de login do sistema (Node puro + node:sqlite), deploy
│                          #   por scripts/deploy-auth.mjs
├─ electron.vite.config.ts # build main/preload/renderer
├─ vitest.config.ts
├─ tsconfig.node.json      # main + preload + shared (strict)
├─ tsconfig.web.json       # renderer + shared (strict)
└─ AGENTS.md               # ⭐ regras do repo (leia ANTES de codificar)
```

### Padrões-chave

| Conceito | Como funciona |
|----------|---------------|
| **Contrato IPC** | Toda ponte renderer ↔ main começa em `src/shared/ipc-types.ts` (interface `StaffHubApi`). O preload implementa, o main registra handlers com os mesmos nomes. Nada passa direto. |
| **Gate central de IPC** | O `ipcMain.handle` é envelopado (wrap) em `src/main/index.ts` com a lista `CANAIS_PROTEGIDOS` (jogo/coleta/mutação/arquivo/planner-draft/tminus/sessão do jogo/capturas/`journal:clear`). Sem sessão válida do SISTEMA, resposta PT-BR "faça login". Updater/journal/prefs/settings ficam LIVRES de propósito (banido ainda atualiza; diagnóstico continua possível). O wrapper é registrado ANTES de qualquer handler (v0.35: registrar depois deixava canais ungated). |
| **Fail-closed** | Parsers lançam `ParseError` com mensagem clara em estrutura inesperada. Nunca retornam dados errados silenciosamente. |
| **Pacing** | Toda requisição ao jogo passa pela `RequestQueue` (350ms mínimo + jitter das settings) ou pelo pacing direto dos serviços. Teto por operação (settings). |
| **Mutações** | Reservas, MPs, edição/apagamento no fórum: confirmação dupla na UI, UMA tentativa por item (nunca reenvio automático), journal obrigatório. **Modo real permanente** (decisão do dono 25/08/2026 — sem dry-run). |
| **Sessão do JOGO** | Partição Chromium `persist:tw`. Login real (janela com o jogo, captcha resolvido pelo usuário) **ou** import de sid via EditThisCookie (autorizado pelo dono). Restauração automática ao reiniciar, com probe e retry. É a sessão usada para LER e EXECUTAR no jogo. |
| **Sessão do SISTEMA** | Conta do Staff Hub na API `staffhub-auth` (VPS): cadastro → aprovação de admin → ativa; banimento encerra sessões a distância; sem rede cai na graça **offline-72h** (modo guerra). É o que LIBERA o app (gate central). As duas sessões são independentes. |
| **Fixtures** | Todo parser novo é testado contra HTML real capturado do BR142 (em `tests/fixtures/br142/`). Nenhum teste usa HTML inventado. |
| **Fail-safe de coleta** | Membro com erro NÃO aborta a coleta — o serviço coleta o máximo possível e registra falhas em `snapshot.failures[]`, que a UI exibe numa tabela. |
| **Preferências por módulo** | Prefs persistentes com merge raso por chave em 12 módulos (`sg1..sg7`, `guerra`, `journal`, `dashboard`, `captures`, `geral`) — `shared/preferences-rules.ts` + `ipc-preferences.ts` + `usePreferences`. O rascunho do planner fica em store PRÓPRIO (`planner-draft`, teto 2 MB) porque passa do cap das prefs. |
| **Motores puros co-localizados** | Regra de negócio nova vai para `src/shared/*.ts` com teste ao lado; o main só orquestra (JsonStore + journal + serialização ler→aplicar→gravar). |

---

## 4. Os 7 módulos (SG_1 a SG_7)

| # | Nome | O que faz | Fonte de dados |
|---|------|-----------|----------------|
| **SG_1** | Análise de Aldeias e Distâncias | Buckets de tempo de nobre (11 faixas: <1h até >34h) entre a tribo própria e inimigas; mapa mundial interativo com cores por tribo (pré-marcadas pela diplomacia, com retry manual) e overlay da OP (setas origem→alvo) | Map dumps oficiais (`/map/village.txt.gz`, `/map/player.txt`, `/map/ally.txt`) + página de diplomacia |
| **SG_2** | Análise de Tropas das Aldeias | Coleta tropas recrutadas de todas as aldeias da tribo (por membro, com pacing, ou resumo em 1 requisição; agendável 4/6/12/24h); fonte alternativa "Disponível na aldeia (agora)" (tropas paradas, via coleta de defesa); Resumo Geral; filtros combináveis; contagem Full/Semi; abas **Análise** × **Auditoria de Membros** (histórico/evolução com sinais, v0.34) | `ally&mode=members_troops` (por membro) + resumo (1 requisição) + `members_defense` (fonte "agora") |
| **SG_3** | Análise de Defesa das Aldeias | Blind (quanto falta por aldeia, com escala por nível de aldeia); débito de blind acumulado por pedido; tabela BBCode para o fórum; apoiadores; triagem de ataques recebidos com thresholds de risco configuráveis | `ally&mode=members_defense` (por membro) |
| **SG_4** | Criação de Operações | OP por coordenada central (camadas 1–8h, separa alvos/fakes); distribuição com planilha heatmap (horas + moral por pontos), fakes inteligentes, curva de moral, prioridade nearest/farthest, moral mínima, distância máxima; agenda com alertas T-minus configuráveis; análise de relatórios de espionagem colados como texto | Map dumps + input manual (origens `nick;fulls;coords`) |
| **SG_5** | Conferência de Comandos | Verificação alvo-a-alvo; totalizador por jogador; filtros de visualização (busca/tipo/nobre/status); diff entre rodadas da conferência; impressão com título editável | Página `info_village` de cada alvo (comandos compartilhados) |
| **SG_6** | Reservas e MPs | Reserva em massa de coordenadas no Planejador; MPs personalizadas em cadeia (placeholders `#alvos#`/`#horarios#`) com biblioteca de templates nomeados | **MUTAÇÕES**: formulários nativos do jogo |
| **SG_7** | Blindagem no Fórum | Conferência de posts no formato rígido `pedido/lanceiros/espadachins/arqueiros`; ajuste do post da tabela (subtrai faltas); débito/credor por linha de pedido; apagamento de mensagens processadas; tópicos salvos com rótulo | **MUTAÇÕES**: edição de post + moderação no fórum |

Além dos 7 módulos:

- **Sala de Guerra** (rota `guerra`), com abas **Planner em Massa** × **Monitoramento**: o planner cruza origens × alvos por grupos (fake/nuke/noble) com exportações byte-fiéis ao tool real (Russian Planner / TW Mass Planner); o monitoramento acompanha a OP arquivada ao vivo — cobertura, próximas chegadas, scorecard da equipe, mapa da OP, agenda, pós-OP (taxa de conquista), compartilhamento em JSON e Evolução do Mundo (diff entre versões + linha do tempo animada);
- **Início (dashboard)** com scorecard configurável; **Journal** premium (agrupado por dia, filtros, export); **Configurações**; **Capturas**; **Sessão**; **Admin** (gestão de contas do Staff Hub, papel admin);
- **Banner global de atualização** (v0.35.2, `UpdateBanner` montado no `App.tsx`): oferta/download/pronto/erro em todas as telas, com snooze por versão e "O que mudou"; também há "Verificar atualizações" na paleta Ctrl+K e card no Início.

### Encadeamento entre módulos

```
SG_1 gera coords → SG_2/SG_3 usam como filtro → SG_3 gera BBCode
→ SG_4 distribui alvos → SG_5 verifica quem atacou → SG_6 envia MPs
→ SG_7 gerencia blindagem no fórum → Sala de Guerra acompanha ao vivo
```

Os fluxos novos (v0.23–v0.33) estão documentados por módulo em `docs/MODULOS-SG.md`, seção **Fluxos Premium**, e as release notes por versão na seção **Release notes** do mesmo arquivo.

---

## 5. Sessão e autenticação — DUAS coisas distintas

### 5.1 Login do SISTEMA (conta do Staff Hub) — desde a v0.30

O app **TEM login próprio**. Sem conta aprovada, o app não abre nada: a trava é no processo main (gate central de IPC), não só na tela.

- **API `staffhub-auth` na VPS** (`vps/staffhub-auth/`, deploy por `scripts/deploy-auth.mjs`): Node puro + `node:sqlite` (WAL) na 8787, atrás do nginx **:443 com cert self-signed PINADO no app** (`src/main/auth-ca.ts` — sem o pin o TLS recusa). Fluxo: cadastro → status `pending` → **aprovação por um administrador** → `active`. Contas também podem ser **banidas** (sessões mortas a distância) e reabilitadas.
- **`AuthService` (main)**: único dono dos tokens; JWT de acesso 15min + refresh rotativo 30d guardado em `safeStorage` (DPAPI); **1 sessão ativa por conta** (login novo expulsa o antigo); renovação silenciosa a cada 10min; **modo guerra 72h**: falha de REDE mantém a sessão usável até 72h da última validação (estado `offline` com banner próprio); 401 (banimento/revogação) encerra de verdade; recuo de relógio do sistema mata a graça (`maxClockSeen`).
- **Rate-limit**: login limitado por IP e por nick (janela deslizante de 10min; lockout de nick 15min por padrão); cadastro também limitado (anti-spam de contas pendentes).
- **Administração**: `AdminPage` (papel admin) aprova/bane/reabilita/reseta senha (temporária impressa uma vez) com auditoria de IP + versão do app. Seed/reset do 1º admin: `node scripts/deploy-auth.mjs --reset-admin <nick>`. **O único admin ativo não pode ser banido** (a API recusa com 409).
- **Gate central**: ver tabela da §3 — canais de produto exigem sessão do sistema; updater/journal/prefs/settings ficam livres de propósito (banido ainda consegue atualizar o app).

### 5.2 Sessão do JOGO (Tribal Wars)

É a sessão usada para ler páginas do jogo e executar mutações — independente da conta do Staff Hub:

1. **Login real**: abre uma janela Electron com o portal oficial. O usuário faz login no jogo normalmente (captcha é com ele). Quando entra num mundo (`br###.tribalwars.com.br/game.php`), o app detecta e fecha a janela.
2. **Import de sid**: o usuário copia o export completo do EditThisCookie (extensão Chrome) do navegador logado e cola no campo. O parser extrai o cookie `sid` do domínio correto + cookies companheiros (`br_auth`, `cid`, etc.) e grava na partição `persist:tw`.
3. **Restauração automática**: ao reiniciar, o app lê os cookies persistidos da partição, descobre o mundo pelo domínio do cookie sid, e valida com um probe (`game.php?screen=overview` + body `id="ds_body"`), com retry e backoff para rede instável.

**Nunca fazer**: captcha-solver, fingerprint spoofing, rotação automática de sid. A linha é a função, não o vendor.

---

## 6. Segurança e política

Definidas em `AGENTS.md` (leia antes de codificar):

- **Sem evasão** — nunca captcha-solver, fingerprint ou rotação de sid, de nenhum fornecedor;
- **Pacing humano** — mínimo 350ms entre requisições + jitter;
- **Teto** — limite de requisições por operação (settings, default 400);
- **Journal** — toda operação (leitura em massa, mutação, evento de sessão, atualização) fica registrada; cap 10000 entradas; apagar o journal (`journal:clear`) exige sessão do sistema (canal gated);
- **Fail-closed** — estrutura inesperada = erro claro, nunca dado errado silencioso;
- **Modo real** — mutações executam de verdade (decisão do dono 25/08/2026); sem dry-run;
- **Atualizador fail-closed** — manifest inválido, hash divergente ou staging corrompido ABORTEM sem tocar na instalação atual; a troca de pastas só ocorre pelo script PowerShell externo depois que o app sai; o zip só vem do MESMO host do canal (pin de host). **v0.36.0 (em preparação)**: o manifest sai ASSINADO com Ed25519 (chave pública embutida em `src/shared/updater-core.ts`) — o canal é HTTP puro por decisão do dono, então a integridade vem da ASSINATURA, não do transporte; o bypass "sha vazio = pular verificação" no rollback foi extinto e `versions.json` (inventário assinado) passa a alimentar o rollback;
- **Proteção contra cópia (honesta)**: gate no main + código minificado + `app.asar` entregue pelo @electron/packager. **NUNCA reempacotar o asar manualmente** (sobrescreve por um vazio e mata o app — incidente pego no E2E; ver `docs/MODULOS-SG.md`, seção "Sistema — Login e proteção de acesso").

---

## 7. Como rodar

```bash
# Setup (uma vez)
pnpm install

# Desenvolvimento (hot reload)
pnpm dev

# Gates (antes de qualquer commit)
pnpm typecheck   # tsc x2 (node + web), strict
pnpm test        # vitest — 951 testes em 62 arquivos
pnpm build       # electron-vite build

# E2E do atualizador (cadeia completa: download → SHA → troca → relançamento)
pnpm e2e:update

# Release completa (gates → bump → build → package → zip → publish VPS → Desktop)
node scripts/release.mjs <versão> "<notas>"
# ex.: node scripts/release.mjs 0.36.0 "Hardening do atualizador"
```

O empacotamento usa `@electron/packager` via `pnpm dlx` (portable win32-x64, **com `app.asar` entregue pelo próprio packager**). O zip resultado é publicado no canal de atualizações (VPS + nginx, `latest.json` assinado + `versions.json`) por `scripts/publish-update.mjs`, autenticado por chave SSH (`STAFFHUB_VPS_KEY`, default `dist/vps/id_staffhub` — **fora do git**) e assinado com a chave Ed25519 do canal (`dist/vps/update-keys/` — **fora do git**; a pública vive embutida em `src/shared/updater-core.ts`). Detalhes operacionais em `docs/RUNBOOK-OPS.md`.

### Dados locais (userData)

Os dados do app ficam em `%APPDATA%/Staff Hub Toxic Squad/`:

```
stores/
├─ world-data.json        # cache dos dumps (TTL 6h)
├─ world-history.json     # versões do mundo: agregado por tribo + delta de donos (cap 10)
├─ troops-snapshots.json  # tropas + defesa + defenseVillages
├─ troops-history.json    # histórico compacto por jogador (cap 20, com rotação)
├─ blind-debt.json        # débito de blind acumulado por linha de pedido
├─ unit-info.json         # velocidades das unidades (TTL 24h)
├─ world-config.json      # config do mundo, incl. janela de bônus noturno (TTL 24h)
├─ op-archive.json        # arquivo de OPs (título, alvos, distribuição, agenda, conferência)
├─ groups.json            # grupos de destaque no jogo
├─ mp-templates.json      # biblioteca de templates de MP (CRUD + default único)
├─ planner-draft.json     # rascunho do planner de OP em massa (store próprio, teto 2 MB)
├─ preferences.json       # prefs por módulo (12 módulos, merge raso por chave, incl. presets)
├─ settings.json          # pacing, teto, canal de update, etc.
└─ journal.json           # journal auditável (cap 10000)
fixtures/                  # capturas de tela do jogo (para testes)
updates/                   # staging do atualizador + updater-debug.log + swap-debug.log
```

---

## 8. Estado atual (20/09/2026) — v0.35.2, caminhando para a v0.36.0

### ✅ Entregue e funcionando

**Base (v0.9–v0.13, Sprints 1–4):** os 7 módulos SG; timing (bônus noturno, calculadora de envio, trem de nobres, Gantt com countdown); memória (arquivo de OPs + scorecard); Sala de Guerra (cobertura, alvos sem comando, re-verificar, anexo de conferência); triagem de ataques; MPs com placeholders + post do plano; single-flight global, confirmação nativa do Windows em toda mutação; navegação sem perda de estado; login do jogo real ou sid.

**Atualização automática E2E (v0.15–v0.22.1):** canal oficial na VPS (nginx + `latest.json`, 74.0.5.75/staffhub); pipeline fail-closed (manifest → SHA-256 → extração via tar.exe nativo → script de troca PowerShell externo); E2E vermelho/verde em app empacotado; rollback de versão pelo canal; correções históricas documentadas (powershell detached, CWD travando o rename, card renascendo no estágio certo).

**Auditoria e Premium (v0.16–v0.26):** moral por pontos, mundos casual/clássicos, Full/Semi, grupos multi-tribo, ErrorBoundary, code-split; fakes inteligentes, diff de conferência, export/import de OP, pós-OP, overlay no mapa, Ctrl+K + Alt+1..9; preferências por módulo, tema escuro, paleta de comandos, journal premium, presets, templates de MP, scorecard configurável, T-minus configurável; perfis no tempo com alerta de recrutamento massivo, evolução do mundo, blind por nível + débito + tópicos salvos; coleta agendada, parser de espionagem (⚠ sintético), linha de frente animada, testes de mutação.

**SG_4 sem armadilhas (v0.27):** auditoria exclusiva do módulo — 13 bugs + invalidação em cascata + stepper + tooltips; fix da dupla divisão na duração do nobre (v0.27.1).

**Planner de OP em Massa (v0.28→v0.33) — Sala de Guerra:**
- Grupos (fake/nuke/nobre) com cruzamento origem×alvo por capacidades, torre de vigia, moral por pontos, proteção de bônus noturno, solver noturno por bisseção (v0.28);
- Alinhamento total à ferramenta real (twmassplanner.pro, provado com gerações reais): exportações byte-fiéis, cotas por grupo, intervalo início/fim, delay sequencial entre ataques, modo Distribuído por players (v0.29);
- **Escala real** (v0.32): teto de 50 MILHÕES de pares com candidatos em typed arrays (a OP "mundo inteiro" da staff — 7005×1701 ≈ 11,9M pares — gera em ~10s); rascunho em store próprio `planner-draft`; exportações imunes a bloco gigante; ErrorBoundary com stack visível;
- **Quartel-general fluido** (v0.33, MEGA): comunicação da OP (MPs de cada executor direto do planner, com template/seeds/prévia), mapa da OP com trajetórias, agenda da OP lida e acionável ("Agendar no T-minus"), cobrança de faltas com MPs, conversor de agenda no SG_6, filtro de jogadores por `;` com fold (acento/caixa), **tela cheia** (`--content-max: none` — fecha o U15 do roadmap), sessão reorganizada em 2 seções.

**Login do sistema (v0.30→v0.35):** API staffhub-auth na VPS (nginx :443 com cert self-signed pinado), cadastro → aprovação de admin, rate-limit, 1 sessão ativa, modo guerra offline-72h, gate central de canais IPC, LoginPage/AdminPage, reset de admin por `deploy-auth.mjs`; revisão completa do login na v0.30.1 (6 achados).

**SG_2 evoluções (v0.31→v0.34):** fonte "Disponível na aldeia (agora)" (tropas fisicamente na aldeia, via coleta de defesa, com toggle "Paradas × Paradas + a caminho" e anti-stale); paginação de coleta para contas com 1000+ aldeias (canário real, v0.33.2); **abas Análise × Auditoria de Membros** (v0.34): histórico por jogador com sinais de auditoria (recrutamento massivo ≥20k off ou ≥3 aldeias; queda acentuada; entrou/saiu; inativo), ficha com timeline, evolução da tribo.

**Auditoria UX/UI aplicada (v0.35.0):** 3 ondas + revisão dupla — verdade (sessão expirada propaga, journal agrupado por dia com repetidos colapsados ×N, tokens CSS consertados), um só idioma (~46 callouts no componente `Callout`, verbos unificados, confirmação em todos os destrutivos, canal de update em "Avançado"), hierarquia (1 primário por card, disclosure progressivo no SG_4). **v0.35.1**: hint no "Recarregar da memória" do SG_2 (só relê; dados novos = nova coleta). **v0.35.2**: **banner global de atualização** (snooze por versão — versão nova reabre na hora; "O que mudou" com as notas; estados oferta/download/pronto/erro; "Verificar atualizações" na paleta).

**Suite de testes:** **951 testes em 62 arquivos, todos verde** — parsers contra fixtures reais do BR142 (37 arquivos), motores puros co-localizados, request-queue com pacing real, mutações com sessão mockada, semântica byte-fiél do planner.

### 🔜 v0.36.0 (em preparação — ondas em andamento na árvore)

> Itens já em código na árvore ou em ondas paralelas; NADA abaixo está em release publicada.

- **Hardening do atualizador**: manifest assinado **Ed25519** (chave pública embutida; publish rejeita notas acima de `MAX_NOTES_LENGTH` = 600 e valida o manifest com o mesmo `isValidManifest` do client ANTES de subir), **anti-brick** (reparo automático de meio-troca + `RECUPERACAO.txt`), **rollback cross-minor** pelo inventário assinado `versions.json` (sha vazio = recusado);
- **Gates** para `journal:clear` e `worldhistory` no gate central de IPC (trilha de auditoria protegida);
- **Boot janela-primeiro**: janela sobe ANTES do boot de auth (VPS lenta não deixa o app cego);
- **Engines fail-closed** em speed/coord/def_factor (nunca inventar velocidade/distância/fator);
- **Cancelamento** propagando em mutações (cancelled estrutural, contagem honesta de não-tentadas);
- **Catálogo de erros** (contrato de erro com próxima ação);
- **WCAG**: correções de acessibilidade no topo;
- **Planner em worker**: cruzamento pesado sai do renderer;
- **Stores por-conta**: separação de dados por conta do Staff Hub;
- **ODA/ODD**: novos agregados de dados do mundo;
- **Alerta de Estagnação**;
- **Digesto webhook**.

### ⚠️ Limitações conhecidas

- **Portable sem instalador NSIS**: o empacotamento oficial é `@electron/packager` (zip portable). Não há build NSIS instalável em uso;
- **Moral**: fórmula oficial **por pontos** desde v0.16 — mundos clássicos sem moral por pontos exigem o toggle manual "moral ativa";
- **Autor do comentário SG_7 não cruza o IPC**: o débito de blind é acumulado **por linha de pedido (aldeia)**, não por jogador (limitação documentada na própria UI);
- **Dumps de mundo não versionados por completo**: o histórico guarda apenas agregado por tribo + delta de trocas de dono (`world-history.ts`);
- **Parser de espionagem sintético**: o `spy-report.ts` é testado contra relatório SINTÉTICO fiel ao formato TW BR — validar contra captura real quando disponível;
- O jogo não renderiza a tabela de tropas por aldeia para o **próprio jogador logado** — o app usa `overview_villages&mode=units` como fallback (paginada);
- Compartilhamento de comandos (SG_5) depende de os membros ativarem a opção no jogo;
- **PM2 sem startup no reboot**: a API staffhub-auth sobe via PM2 mas o `pm2 startup` não está configurado na VPS (ver `docs/RUNBOOK-OPS.md`).

---

## 9. Contatos e contexto

- **Dono**: líder/fundador da tribo Toxic Squad no BR142 (mundo de teste); conta com acesso de líder;
- **Origem**: ferramenta transcrita de vídeos do mundo 125 (Tribo JuJu vs KINGS);
- **Repo**: `C:\Users\Usuário\.zcode\workspace\default\staff-hub-toxic-squad` — git local com remote **origin = `github.com/ThalysDev/Staff-Hub-Toxic-Squad`** (as releases são publicadas no canal da VPS, não como assets do GitHub);
- **Canal de atualização**: `http://74.0.5.75/staffhub/latest.json` (VPS + nginx, publicação via `publish-update.mjs`);
- **API de login**: `https://74.0.5.75/staffhub/api/` (nginx :443, cert self-signed pinado).

---

## 10. Para o desenvolvedor que recebeu este projeto

1. **Leia o `AGENTS.md` primeiro** — tem as regras do repo (incl. política de versionamento e a exigência de **revisão dupla antes de toda release**);
2. **Rode `pnpm install` + `pnpm dev`** para ver o app funcionando — o login do sistema aparece ANTES de tudo (em dev sem VPS o app cai no estado offline/deslogado);
3. **Não toque em `src/shared/ipc-types.ts`** sem entender o padrão: contrato evolui primeiro, depois main/preload/renderer;
4. **Todo parser novo precisa de fixture real** — copie a tela do jogo, salve em `tests/fixtures/br142/`, e escreva o teste contra ela;
5. **Regra de negócio nova vai para `src/shared/` com teste ao lado** — o main só orquestra;
6. **Canal IPC novo de produto? Adicione o prefixo em `CANAIS_PROTEGIDOS`** (`src/main/index.ts`) — e lembre da regra do AGENTS.md: bug de prefixo/case de canal exige auditoria holística da lista inteira;
7. **Rode os gates** (`pnpm typecheck && pnpm test && pnpm build`) antes de qualquer commit;
8. **A spec funcional está em `docs/MODULOS-SG.md`** — fonte da verdade para rótulos, formatos, encadeamento e release notes por versão;
9. **O estado real de cada item do roadmap** está em `docs/ROADMAP-ESTRATEGICO.md` — nada marcado como entregue sem código correspondente;
10. **Operação da VPS (canal, auth, cert)** está em `docs/RUNBOOK-OPS.md`;
11. Se for adicionar um módulo novo, siga o padrão de um existente (SG_2 é o mais completo: parser + engine + summary + histórico + service + IPC + page).
