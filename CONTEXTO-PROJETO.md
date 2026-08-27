# Staff Hub Toxic Squad — Documento de Contexto Completo

> **Versão**: 0.26 · **Data**: 26/08/2026 · **Stack**: Electron 43 + React 19 + TypeScript strict
> **Testes**: Vitest — 710 testes em 50 arquivos, todos verde (`pnpm test`)
> **Público**: desenvolvedores que vão entender, manter ou evoluir o projeto

---

## 1. O que é

O **Staff Hub Toxic Squad** é um aplicativo desktop (Electron, Windows) para a **liderança de uma tribo no Tribal Wars BR** (jogo de estratégia medieval da InnoGames). Ele replica e amplifica os fluxos de uma ferramenta interna anterior ("Central de Defesa Op", do mundo 125) que existia como conjunto de userscripts — trazendo os mesmos 7 módulos de funcionalidade para um app standalone com melhor UX, testes automatizados, política de segurança rigorosa, persistência de histórico e atualização automática.

**Quem usa**: o dono da tribo (líder/fundador) e eventuais líderes de outras tribos. A ferramenta roda na conta de liderança do usuário (via sessão do jogo importada), lê páginas internas da tribo e executa ações no jogo.

**Diferencial em relação à ferramenta original**: mesma linguagem, mesmos rótulos em PT-BR, mesmos fluxos — mas com interface gráfica própria (tema pergaminho medieval com tema claro/escuro), testes automatizados contra fixtures reais do jogo (710 testes), journal auditável com filtros e export, pacing humano, confirmação dupla em mutações, histórico/evolução de tropas e do mundo, atualizador automático pelo canal próprio na VPS — e sem depender de userscripts injetados no navegador.

---

## 2. Como o projeto nasceu

1. O dono transcreveu (via IA de vídeo) 7 vídeos tutoriais da ferramenta original (SG_1 a SG_7), resultando em transcrições + capturas de tela que viraram a **especificação funcional** (`docs/MODULOS-SG.md`);
2. Uma onda de sub-agentes (implementer, designer, reviewer, see-images) extraiu rótulos, formatos, regras de negócio e layouts das transcrições e capturas;
3. O código foi implementado em ondas paralelas por agentes `implementer` (DeepSeek) sobre um design system pré-existente, com integração serial pelo agente principal;
4. Cada fase foi revisada por um agente `reviewer` independente, e os achados foram corrigidos antes do commit;
5. Todo o sistema foi validado contra **fixtures HTML reais capturadas do mundo BR142** (a tribo real do dono: "Toxic Squad Sul", tag `Toxic!`) — hoje são **34 arquivos** em `tests/fixtures/br142/`.

Fases subsequentes (registradas no git): Sprints 1–4 do Roadmap Estratégico (v0.9→v0.13: timing, memória, Sala de Guerra, defesa, comunicação), canal de atualização VPS (v0.15), melhorias da staff + auditoria (v0.16→v0.20), pós-OP/overlay (v0.21), Resumo Geral do SG_2 (v0.22) e três ondas Premium (v0.23–v0.25: preferências/temas/paleta, filtros/presets/templates, inteligência de histórico).

---

## 3. Arquitetura

```
staff-hub-toxic-squad/
├─ build/                  # icon.ico (multi-tamanho BMP real)
├─ docs/
│  ├─ MODULOS-SG.md        # ⭐ especificação funcional (fonte da verdade) + Fluxos Premium
│  ├─ ROADMAP-ESTRATEGICO.md # síntese Produto/Código/UX com status por item
│  ├─ REFERENCIA-NEXUS.png # referência visual do tema
│  └─ design/
├─ scripts/
│  ├─ release.mjs          # release 1 comando: gates → bump → build → packager → zip
│  │                       #   → publish no canal VPS → copiar zip p/ Desktop
│  ├─ publish-update.mjs   # publica zip + latest.json na VPS via SSH (chave FORA do git)
│  └─ e2e-update.mjs       # E2E vermelho/verde do atualizador (app empacotado,
│                          #   download→SHA→troca→relançamento; gancho env SHS_E2E_*)
├─ src/
│  ├─ main/                # processo principal Electron (Node)
│  │  ├─ index.ts          # entrypoint: janelas, IPC, wiring geral
│  │  ├─ updater-service.ts # atualizador: canal VPS, staging, swap via .cmd externo,
│  │  │                    #   rollback p/ versão anterior, debug-log à prova de travamento
│  │  ├─ tminus.ts         # notificações T-minus na bandeja (marcas configuráveis 1–1440 min)
│  │  ├─ tw/
│  │  │  ├─ session.ts     # TwSessionManager (partição persist:tw, login real ou SID)
│  │  │  └─ request-queue.ts # RequestQueue (pacing, teto, retry, sentinelas)
│  │  ├─ services/
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
│  │  ├─ ipc-*.ts          # handlers IPC por domínio: world, troops, sg3, sg5, sg6, sg7,
│  │  │                    #   supporters, groups, op, history, templates, preferences
│  │  ├─ stores/json-store.ts # JsonStore (persistência atômica em userData)
│  │  └─ journal.ts        # journal auditável (journal.json, cap 10000 entradas)
│  ├─ preload/index.ts     # contextBridge tipado (contrato StaffHubApi)
│  ├─ shared/              # código puro (parsers, engines, tipos) — 100% testável.
│  │  │                    # Testes co-localizados: cada *.ts tem seu *.test.ts ao lado.
│  │  ├─ types.ts / ipc-types.ts   # modelo do mundo + ⭐ contrato IPC (evolui PRIMEIRO)
│  │  ├─ units, coords, distance, buckets, formatters, world-config, coord-input
│  │  ├─ sg1-engine / sg2-engine / sg3-engine / sg4-engine / sg7-engine
│  │  ├─ sg2-summary       # Resumo Geral dos Dados em Memória (SG_2)
│  │  ├─ sg4-timing        # calculadora de envio + trem de nobres + agenda
│  │  ├─ sg5-arrivals / sg5-diff / sg5-view-filter # Gantt, diff e filtros de visualização
│  │  ├─ war-room / op-archive-rules / op-export / post-op / post-op-live
│  │  ├─ snapshot-history  # histórico de tropas + alerta de recrutamento massivo
│  │  ├─ world-history     # evolução do mundo (agregados por tribo + delta de donos)
│  │  ├─ blind-debt / incoming-risk / night-bonus / full-semi / groups-rules
│  │  ├─ filter-presets / preferences-rules / mp-templates-rules / journal-filter
│  │  ├─ comms-package / mp-preview / origins-from-snapshot / fakes-intelligent
│  │  ├─ spy-report        # parser de relatórios de espionagem (texto colado)
│  │  ├─ updater-core      # manifest, semver, script de troca (buildSwapScript)
│  │  └─ parsers/          # ally, world, village, forum, own-units
│  └─ renderer/            # React (tema pergaminho medieval, claro/escuro)
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx         # roteamento por estado (sem lib de roteamento)
│        ├─ theme.ts        # escolha de tema: system | claro | escuro
│        ├─ modules.ts / assets.ts
│        ├─ components/     # TitleBar, Sidebar, CommandPalette (Ctrl+K), TemplateLibrary,
│        │                 #   PresetManager, PageHeader, Field, ProgressBar, Toast,
│        │                 #   ErrorBoundary, StatBlock, StatusPill, EmptyState
│        ├─ hooks/          # useToast, useSessionStatus, useQueueActivity,
│        │                 #   usePreferences (prefs por módulo), useDiplomacyRelations
│        │                 #   (com retry), useKeyboardShortcuts (Ctrl+K + Alt+1..9)
│        ├─ pages/
│        │  ├─ DashboardPage.tsx  # scorecard da staff (configurável) + frente de operações
│        │  ├─ SessionPage / SettingsPage / JournalPage / CapturesPage
│        │  ├─ sg1..sg7/    # uma pasta por módulo SG (seções em componentes próprios)
│        │  └─ war/         # Sala de Guerra + PostOpSection + OpShareSection
│        │                  #   + WorldEvolutionSection
│        └─ styles/         # tokens.css + app.css + theme-dark.css
├─ tests/
│  ├─ fixtures/br142/      # ⭐ 34 HTMLs/XMLs REAIS capturados do BR142
│  ├─ main/                # request-queue, parse-sid
│  ├─ warm/                # smoke de import do bundle
│  └─ diag/                # diagnósticos pontuais
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
| **Fail-closed** | Parsers lançam `ParseError` com mensagem clara em estrutura inesperada. Nunca retornam dados errados silenciosamente. |
| **Pacing** | Toda requisição ao jogo passa pela `RequestQueue` (350ms mínimo + jitter das settings) ou pelo pacing direto dos serviços. Teto por operação (settings). |
| **Mutações** | Reservas, MPs, edição/apagamento no fórum: confirmação dupla na UI, UMA tentativa por item (nunca reenvio automático), journal obrigatório. **Modo real permanente** (decisão do dono 25/08/2026 — sem dry-run). |
| **Sessão** | Partição Chromium `persist:tw`. Login real (janela com o jogo, captcha resolvido pelo usuário) **ou** import de sid via EditThisCookie (autorizado pelo dono). Restauração automática ao reiniciar (lê cookies da partição → valida com probe, com retry 3x). |
| **Fixtures** | Todo parser novo é testado contra HTML real capturado do BR142 (em `tests/fixtures/br142/`). Nenhum teste usa HTML inventado. |
| **Fail-safe de coleta** | Membro com erro NÃO aborta a coleta — o serviço coleta o máximo possível e registra falhas em `snapshot.failures[]`, que a UI exibe numa tabela. |
| **Preferências por módulo** | Prefs persistentes com merge raso por chave em 12 módulos (`sg1..sg7`, `guerra`, `journal`, `dashboard`, `captures`, `geral`) — `shared/preferences-rules.ts` + `ipc-preferences.ts` + `usePreferences`. |
| **Motores puros co-localizados** | Regra de negócio nova vai para `src/shared/*.ts` com teste ao lado; o main só orquestra (JsonStore + journal + serialização ler→aplicar→gravar). |

---

## 4. Os 7 módulos (SG_1 a SG_7)

| # | Nome | O que faz | Fonte de dados |
|---|------|-----------|----------------|
| **SG_1** | Análise de Aldeias e Distâncias | Buckets de tempo de nobre (11 faixas: <1h até >34h) entre a tribo própria e inimigas; mapa mundial interativo com cores por tribo (pré-marcadas pela diplomacia, com retry manual) e overlay da OP (setas origem→alvo) | Map dumps oficiais (`/map/village.txt.gz`, `/map/player.txt`, `/map/ally.txt`) + página de diplomacia |
| **SG_2** | Análise de Tropas das Aldeias | Coleta tropas recrutadas de todas as aldeias da tribo (por membro, com pacing, ou resumo em 1 requisição; agendável 4/6/12/24h); Resumo Geral dos dados em memória; filtros combináveis; contagem Full/Semi; Histórico e Evolução com alerta de recrutamento massivo | `ally&mode=members_troops` (por membro) + resumo (1 requisição) |
| **SG_3** | Análise de Defesa das Aldeias | Blind (quanto falta por aldeia, com escala por nível de aldeia); débito de blind acumulado por pedido; tabela BBCode para o fórum; apoiadores; triagem de ataques recebidos com thresholds de risco configuráveis | `ally&mode=members_defense` (por membro) |
| **SG_4** | Criação de Operações | OP por coordenada central (camadas 1–8h, separa alvos/fakes); distribuição com planilha heatmap (horas + moral por pontos), fakes inteligentes, curva de moral, prioridade nearest/farthest, moral mínima, distância máxima; agenda com alertas T-minus configuráveis; análise de relatórios de espionagem colados como texto | Map dumps + input manual (origens `nick;fulls;coords`) |
| **SG_5** | Conferência de Comandos | Verificação alvo-a-alvo; totalizador por jogador; filtros de visualização (busca/tipo/nobre/status); diff entre rodadas da conferência; impressão com título editável | Página `info_village` de cada alvo (comandos compartilhados) |
| **SG_6** | Reservas e MPs | Reserva em massa de coordenadas no Planejador; MPs personalizadas em cadeia (placeholders `#alvos#`/`#horarios#`) com biblioteca de templates nomeados | **MUTAÇÕES**: formulários nativos do jogo |
| **SG_7** | Blindagem no Fórum | Conferência de posts no formato rígido `pedido/lanceiros/espadachins/arqueiros`; ajuste do post da tabela (subtrai faltas); débito/credor por linha de pedido; apagamento de mensagens processadas; tópicos salvos com rótulo | **MUTAÇÕES**: edição de post + moderação no fórum |

Além dos 7 módulos: **Sala de Guerra** (rota `guerra`) acompanha a OP arquivada ao vivo — cobertura, próximas chegadas, scorecard da equipe, pós-OP (taxa de conquista), compartilhamento da OP em JSON e Evolução do Mundo (diff entre versões + mudanças no mapa).

### Encadeamento entre módulos

```
SG_1 gera coords → SG_2/SG_3 usam como filtro → SG_3 gera BBCode
→ SG_4 distribui alvos → SG_5 verifica quem atacou → SG_6 envia MPs
→ SG_7 gerencia blindagem no fórum → Sala de Guerra acompanha ao vivo
```

Os fluxos novos (v0.23–v0.25) estão documentados por módulo em `docs/MODULOS-SG.md`, seção **Fluxos Premium**.

---

## 5. Sessão e autenticação

O app **não tem senha própria**. A autenticação é a sessão do jogo Tribal Wars:

1. **Login real**: abre uma janela Electron com o portal oficial. O usuário faz login no jogo normalmente (captcha é com ele). Quando entra num mundo (`br###.tribalwars.com.br/game.php`), o app detecta e fecha a janela.
2. **Import de sid**: o usuário copia o export completo do EditThisCookie (extensão Chrome) do navegador logado e cola no campo. O parser extrai o cookie `sid` do domínio correto + cookies companheiros (`br_auth`, `cid`, etc.) e grava na partição.
3. **Restauração automática**: ao reiniciar, o app lê os cookies persistidos da partição, descobre o mundo pelo domínio do cookie sid, e valida com um probe (`game.php?screen=overview` + body `id="ds_body"`), com retry 3x e backoff para rede instável.

**Nunca fazer**: captcha-solver, fingerprint spoofing, rotação automática de sid. A linha é a função, não o vendor.

---

## 6. Segurança e política

Definidas em `AGENTS.md` (leia antes de codificar):

- **Sem evasão** — nunca captcha-solver, fingerprint ou rotação de sid, de nenhum fornecedor;
- **Pacing humano** — mínimo 350ms entre requisições + jitter;
- **Teto** — limite de requisições por operação (settings, default 400);
- **Journal** — toda operação (leitura em massa, mutação, evento de sessão, atualização) fica registrada; cap 10000 entradas;
- **Fail-closed** — estrutura inesperada = erro claro, nunca dado errado silencioso;
- **Modo real** — mutações executam de verdade (decisão do dono 25/08/2026); sem dry-run;
- **Atualizador fail-closed** — manifest inválido, hash divergente ou staging corrompido ABORTEM sem tocar na instalação atual; a troca de pasta só ocorre pelo script `.cmd` externo depois que o app sai.

---

## 7. Como rodar

```bash
# Setup (uma vez)
pnpm install

# Desenvolvimento (hot reload)
pnpm dev

# Gates (antes de qualquer commit)
pnpm typecheck   # tsc x2 (node + web), strict
pnpm test        # vitest — 710 testes em 50 arquivos
pnpm build       # electron-vite build

# E2E do atualizador (cadeia completa: download → SHA → troca → relançamento)
pnpm e2e:update

# Release completa (gates → bump → build → package → zip → publish VPS → Desktop)
node scripts/release.mjs <versão> "<notas>"
# ex.: node scripts/release.mjs 0.26.0 "Docs v0.26"
```

O empacotamento usa `@electron/packager` via `pnpm dlx` (portable win32-x64). O zip resultado é publicado no canal de atualizações (VPS + nginx, `latest.json`) por `scripts/publish-update.mjs`, autenticado por chave SSH (`STAFFHUB_VPS_KEY`, default `dist/vps/id_staffhub` — **fora do git**).

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
├─ preferences.json       # prefs por módulo (12 módulos, merge raso por chave, incl. presets)
├─ settings.json          # pacing, teto, etc.
└─ journal.json           # journal auditável (cap 10000)
fixtures/                  # capturas de tela do jogo (para testes)
updates/                   # staging do atualizador + updater-debug.log
```

---

## 8. Estado atual (26/08/2026) — v0.26

> v0.26 é a release de fechamento de documentação (este doc + `docs/MODULOS-SG.md` + `docs/ROADMAP-ESTRATEGICO.md`). A árvore está em 0.26.0 (commit de fechamento c97fb27); a partir daqui cada frente nova bumpa no corte via `scripts/release.mjs`.

### ✅ Entregue e funcionando

**Base (v0.9–v0.13, Sprints 1–4 do Roadmap):**
- Os 7 módulos SG implementados, testados, revisados e corrigidos;
- Timing: bônus noturno (janela real do get_config), calculadora de envio, trem de nobres, Gantt de chegadas com countdown ao vivo;
- Memória: arquivo de OPs (`op-archive`) + scorecard de participação por membro;
- Sala de Guerra: % de cobertura, alvos sem comando, re-verificar com 1 clique, countdown, anexo da conferência à OP;
- Defesa: varredura de ataques recebidos com triagem "VAI CAIR";
- Comunicação: MPs com `#alvos#`+`#horarios#` (prévia + validação de nicks), BBCode do plano, lista de reservas e post automático do plano no fórum;
- Dureza: single-flight global real, confirmação nativa do Windows em toda mutação, journal inclusive em resultado incerto pós-POST;
- Navegação sem perda de estado; indicador global de operações na titlebar; cancelamento de coleta; login real ou sid com restauração automática; ícone customizado.

**Atualização automática E2E (v0.15–v0.22.1):**
- Canal oficial na VPS (nginx + `latest.json`, 74.0.5.75/staffhub), publicação via SSH com chave fora do repo;
- Pipeline fail-closed: manifest → SHA-256 → extração (tar.exe nativo) → script de troca `.cmd` externo (o `.exe` rodando nunca é sobrescrito);
- **E2E vermelho/verde** comprovando a cadeia completa em app empacotado: download → SHA → troca → relançamento automático na versão nova (`scripts/e2e-update.mjs`, `pnpm e2e:update`);
- **Rollback**: listar versões anteriores do canal e preparar uma específica pelo mesmo pipeline (v0.20);
- Correções históricas documentadas: powershell detached morto no Windows (v0.22.1), CWD travando o rename (v0.21.2), card de atualização renascendo no estágio certo (v0.16.1).

**Melhorias da staff (v0.16–v0.18):** moral por pontos (fórmula oficial do jogo), mundos casual (`brc+`) e clássicos, contagem Full/Semi (SG_2) acompanhada pelo SG_4 de ponta a ponta, filtro por K, coords normalizadas, grupos multi-tribo, ErrorBoundary, code-split com React.lazy, retry de sessão no boot.

**Auditoria v0.19–v0.21:** fakes inteligentes (distribuição por proximidade com máximo por origem), diff entre conferências (novos/cancelados/perdidos por commandId), export/import de OP em JSON, pós-OP (taxa de conquista, nobres desperdiçados), overlay da OP no mapa (setas amarelas origem→alvo), atalhos Ctrl+K + Alt+1..9, limpeza/gzip no canal.

**Onda 1 Premium (v0.23) — Fundação:** preferências persistentes por módulo (12 módulos), tema claro/escuro/sistema (`theme.ts` + `theme-dark.css`), paleta de comandos Ctrl+K (`CommandPalette`), motores órfãos ganham UI.

**Onda 2 Premium (v0.24) — Filtros:** journal premium (chips de tipo + ação + busca acento-insensitiva + período + export CSV/JSON + limite configurável); filtros de visualização no SG_5 (busca/tipo/nobre/status chegados×pendentes); presets nomeados de filtro (SG_1 análise, SG_2 consulta/full-semi, via `PresetManager`); biblioteca de templates de MP (CRUD + default único, picker no SG_6 e SG_4); scorecard configurável no Dashboard (top N, métrica faltas/envios/% cumprido, janela 7/30 dias/tudo, copiar TSV); marcas T-minus configuráveis (1–1440 min); thresholds de risco do SG_3 expostos e persistidos.

**Onda 3 Premium (v0.25) — Inteligência:**
- **Perfis no tempo** (SG_2 "Histórico e Evolução"): cada coleta arquiva versão compacta por jogador (~30KB vs 3MB); comparação A/B com Δ de pop of/def/aldeias, ranking de crescimento e **alerta de recrutamento massivo** (≥20k pop ofensiva ou ≥3 aldeias novas — sinal de OP inimiga); cap 20 versões;
- **Evolução do mundo** (Sala de Guerra): cada atualização de dumps arquiva agregado por tribo + delta de trocas de dono; diff A/B com Δ colorido, lista de conquistas/abandonos e botão "Mostrar no mapa"; nunca mistura mundos; cap 10 versões;
- **Blindagem evoluída**: blind por nível (desejado escala pelos pontos da aldeia, clamp 0,5×–2×), débito de blind acumulado por linha de pedido (SG_7 soma rodadas reconhecidas e mostra devedor/credor), tópicos de blind salvos com rótulo (cap 10).

**v0.26 — fechamento do P2 (+ docs):**
- **Coleta automática agendada** (SG_2, P2-23): intervalo 4/6/12/24h persistido nas prefs (desligado por padrão); scheduler 100% renderer avalia a cada 5min e só dispara com sessão logada, fila livre e intervalo vencido desde a última coleta;
- **Análise de espionagem** (SG_4, P2-24): parser fail-closed do corpo do relatório colado (`spy-report.ts`) — extrai alvo/unidades/muralha/populações e sugere fulls para limpar a defesa; ⚠ testado contra relatório SINTÉTICO (validar contra fixture real);
- **Linha de frente animada** (Evolução do Mundo, P2-25): modo "linha do tempo" com slider cronológico cumulativo e reprodução automática sobre o mapa;
- **Testes de mutação** (achado C11): SG_6/SG_7 testados com sessão mockada (`tests/main/electron-mock.ts`) contra fixtures reais do BR142 — service, journal, JsonStore e single-flight reais; só o fio de rede é fake;
- Documentação toda revista (este doc + `MODULOS-SG.md` com Fluxos Premium + `ROADMAP-ESTRATEGICO.md` com status por item verificado no código).

**Suite de testes:** 710 testes em 50 arquivos, todos verde (656 até a v0.25 + 54 novos na v0.26) — parsers contra fixtures reais do BR142 (34 arquivos), motores puros co-localizados, request-queue com pacing real, mutações com sessão mockada.

### ⚠️ Limitações conhecidas

- **Portable sem instalador NSIS**: o empacotamento oficial é `@electron/packager` (zip portable). Não há build NSIS instalável (electron-builder sem config no repo);
- **Moral**: fórmula oficial **por pontos** desde v0.16 (`(def/att × 3 + 0,3) × 100`, teto 100) — calibrada; mundos clássicos sem moral por pontos exigem o toggle manual "moral ativa";
- **Autor do comentário SG_7 não cruza o IPC**: a página do fórum não expõe quem comentou ao hub — o débito de blind é acumulado **por linha de pedido (aldeia)**, não por jogador (limitação documentada na própria UI);
- **Dumps de mundo não versionados por completo**: um dump tem ~270k aldeias (~3MB); versionar tudo seria inviável — o histórico guarda apenas agregado por tribo + delta de trocas de dono (`world-history.ts`);
- **Parser de espionagem sintético** (v0.26): o `spy-report.ts` é testado contra relatório SINTÉTICO fiel ao formato TW BR — validar contra uma captura real do BR142 quando disponível;
- O jogo não renderiza a tabela de tropas por aldeia para o **próprio jogador logado** (ignora o player_id) — o app usa a tela `overview_villages&mode=units` como fallback;
- Compartilhamento de comandos (SG_5) depende de os membros ativarem a opção no jogo.

---

## 9. Contatos e contexto

- **Dono**: líder/fundador da tribo Toxic Squad no BR142 (mundo de teste); conta com acesso de líder;
- **Origem**: ferramenta transcrita de vídeos do mundo 125 (Tribo JuJu vs KINGS);
- **Repo**: `C:\Users\Usuário\.zcode\workspace\default\staff-hub-toxic-squad` — git local com remote **origin = `github.com/ThalysDev/Staff-Hub-Toxic-Squad`** (as releases são publicadas no canal da VPS, não como assets do GitHub);
- **Canal de atualização**: `http://74.0.5.75/staffhub/latest.json` (VPS + nginx, publicação via `publish-update.mjs`).

---

## 10. Para o desenvolvedor que recebeu este projeto

1. **Leia o `AGENTS.md` primeiro** — tem as regras do repo;
2. **Rode `pnpm install` + `pnpm dev`** para ver o app funcionando;
3. **Não toque em `src/shared/ipc-types.ts`** sem entender o padrão: contrato evolui primeiro, depois main/preload/renderer;
4. **Todo parser novo precisa de fixture real** — copie a tela do jogo, salve em `tests/fixtures/br142/`, e escreva o teste contra ela;
5. **Regra de negócio nova vai para `src/shared/` com teste ao lado** — o main só orquestra (padrão dos `ipc-templates.ts`/`ipc-history.ts`);
6. **Rode os gates** (`pnpm typecheck && pnpm test && pnpm build`) antes de qualquer commit;
7. **A spec funcional está em `docs/MODULOS-SG.md`** — é a fonte da verdade para rótulos, formatos e encadeamento (fluxos premium na seção final);
8. **O estado real de cada item do roadmap** está em `docs/ROADMAP-ESTRATEGICO.md` — nada marcado como entregue sem código correspondente;
9. Se for adicionar um módulo novo, siga o padrão de um existente (SG_2 é o mais completo: parser + engine + summary + histórico + service + IPC + page).
