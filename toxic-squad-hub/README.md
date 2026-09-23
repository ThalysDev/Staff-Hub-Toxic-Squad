# Toxic Squad Hub (userscript)

Automação do **jogo individual** do jogador no Tribal Wars BR — fusão da **suite TW Vanta** (v0.5.6, corrigida) com as **funcionalidades da extensão Toxic Squad Hub** (v0.4.0), num único script Tampermonkey com painel próprio (Shadow DOM) e **acesso por chave**.

> Escopo: ferramenta do JOGADOR. Gestão de tribo/OPs é papel do **Staff Hub Toxic Squad** (app + userscript In-Game `../userscript`) — produto separado, que segue intacto.

- **Versão:** 3.0.0 "Arsenal Completo" (ver `version.json` — o header TM precisa bater, o build valida)
- **Canal:** `http://74.0.5.75/staffhub/scripts/toxic-squad-hub.user.js` (+ `.meta.js` para update check)
- **Artefato:** `dist/toxic-squad-hub.user.js` — **ofuscado** (o header TM fica limpo; o corpo passa por `javascript-obfuscator` determinístico, seed fixa)

## v3.0.0 — Arsenal Completo (23/09/2026)

Porta completa da auditoria do concorrente (ver `../NEXUS_RECON_COMPLETO.md`) com identidade própria:

### Regra de ouro de envio
Comandos **cravados** (ataques de OP, nobres, snipes, dodge, cancelamentos, apoios cravados) saem no **milissegundo planejado** — nenhuma humanização os atrasa. **Fakes e rotinas** (farm, coleta, recrutamento, construção, mercado, cunhagem) passam pela **Humanização de Envios**: intervalo entre comandos, variação %, pausa programada e respeito ao fake limit.

### Central de Agendamentos
Percentual de tropas, colar horário (HH:mm[:ss[:ms]]), alvo de catapulta, **Sequência de Nobres 2-5** com gap calibrado e auto-split, **Cancelamento Cronometrado** (1-20 comandos no alvo), snipe/dodge, forçar impossíveis, **Agendamento em Bloco** (origens por grupo, cotas "2;1", janela de chegada, otimizado 2-opt) e **Mapa de Operações** (filtros, conflitos de ms, edição em massa, import/export).

### Distribuidor de Apoios (aba nativa `place&mode=call`)
Totais da conta ao vivo, origens por grupo, formato de linha `x|y u/…/u [i]janela`, popup Inserir por coordenadas, distribuição mínimo/máximo/pacotes com guardas e tropas reservadas, imediato/cravado e export BBCode para o fórum.

### Ferramentas de página (Suite Vanta +)
Inspeção de Aldeias e Prévia de Aldeia no mapa, Cancelamento em Bloco, Import/Export de Grupos, Bônus Diário, Mapa Enxuto, **alarme sonoro** (4 sons) no etiquetador, **Bloco de Campo** (notas locais + marcador no mapa) e coluna de Agenda das Aldeias no overview.

### Automações turbinadas + Modo Sentinela
Auto Farm **executável** (Template C dinâmico, mapeador de bárbaras, ledgers), recrutamento por **modelos de tropa** por grupo, cunhagem percentual, regras de coleta por grupo, estratégia de mercado, balanceador por coordenadas-alvo, construtor com visão Horas, **Conquista de Aldeias Livres**, **Produção de Nobres** (unified-balancer), renomeador de aldeias com tokens, agendador de itens, gerenciador do paladino, abertura de pacotes, cunhagem nativa e doador de prestígio. O **Modo Sentinela** mantém tudo ciclando numa aba de fundo.

### Infra
Painel de Atividades na home, **parada programada universal**, busca rápida **Ctrl+K**, seção Ajuda & Sobre, canais de alerta (som local; webhooks ficam stub desligado — nada sai do navegador). Relógio adaptativo (mediana aparada, responsivo/estável) por baixo de todo o timing.

---

## O que tem dentro (herdado da v2)

### Suite Vanta (portada do TW Vanta v0.5.6 COM as correções da auditoria de 21/09)
Painel → aba **Suite Vanta** (launchers por grupo) + injeção automática na tela certa.

| Módulo | Tela | Correções aplicadas vs Vanta original |
|---|---|---|
| Painel de Incomings (dashboard + filtros + marcar duplicados + buscar tropas) | `overview_villages › incomings` | XSS fechado (escape em tudo), interval com dispose no re-render, simulador unificado com bônus de defesa, ícones relativos (sem CDN com hash), parse pt-BR |
| Cores de Incomings | idem | escape dos rótulos; rebind por remount limpo |
| Renomeador (tags) | `overview` (comandos) | rede pela fila do core; sem regressão de csrf |
| Apoio em Massa | `place › call` | default de horário no FUSO LOCAL (era UTC=3h errado), data do servidor parseada seguro, confirmação antes de enviar |
| Blindagem (info_village) | `info_village` | escape dos nomes, confirmação com resumo, parse pt-BR |
| Visão Geral de Apoios | `units › away_detail` | **números >999 corrigidos** (era truncado em "8.532"→8), checkbox via evento, confirmação |
| Coletor e Alocador | `map` | coordenadas <100 corrigidas, hooks do TWMap com restore garantido (race de fechamento corrigida), confirmação em lote |
| Remover Relíquias | `relic_system` | confirmação com contagem antes do lote |
| Etiquetador | `incomings › attacks` | loop de recarga em todos os ramos (não morre mais), confirmação ao ligar |
| Auto Cunhar | `snob` | parse pt-BR do máximo, botão escopado ao formulário, automação sobrevive a tela sem botão |
| Saúde do Stack | `overview` | simulador único (def_benefits/def_flag/“mais de 100”), recálculo com dado fresco, wall sem parse de texto |

Melhorias estruturais em toda a suíte: **rede única** (same-origin, fila ≥200ms, sentinelas de captcha/sessão), **ciclo de vida rastreado** (nenhum timer/listener vaza), **storage namespaced** (`tsh-vanta:*`), TypeScript strict, testes das partes puras.

## Automações da extensão Toxic Squad Hub (Onda 6 — portadas)

Aba **"Automações"** do painel. TODAS nascem **desligadas** (opt-in); as que mutam o jogo exigem **ARMAR** (30 min, com confirmação) — o **Agendador de Comandos** é exceção: agendar já é a autorização; máximo **1 mutação por ciclo** (regra F2); lock de 1 aba por mundo por módulo; heartbeat de 30s com a aba aberta; licença SHS ativa obrigatória.

| Automação | Tela | Tipo | Mutação (1/ciclo) |
|---|---|---|---|
| Cunhagem de moedas | snob | mutante | `mintCoins` (reservas + teto por ciclo) |
| Troca Premium | market (exchange) | mutante | `premiumExchange` (buy/sell por cotação) |
| Balanceador de recursos | market | mutante | `sendResources` do maior défice (engine `planBalanceTransfers`, prévia sempre) |
| Treino de paladino | statue | mutante | `launchPaladinTraining` |
| Recrutamento | train | mutante | `recruitUnits` (lote cabível por recursos) |
| Fila de construção (Mega Builder) | main | mutante | `upgradeBuilding` (fila/template GC base64) |
| Coleta automática | place (scavenge) | mutante | `sendScavengingSquads` (API `scavenge_api`) / `sendScavengingMass` |
| Agendador de comandos | place | mutante | `submitCommand2Step` (janela 15s/250ms, FAKE limit do mundo via get_config) |
| Apoio em massa | place | mutante | prévia sempre; envio 1-a-1 com ledger quando `settings.armed` + ARMAR (engines `support-planner`/`support-execution`) |
| Gerador de OPs | qualquer | prévia | engine `op-planner` (6 critérios + 2-opt) — nenhuma |
| Gestão de apoio | info_village | prévia | engine `planSupportWithdrawal` — nenhuma |
| Auto Farm | qualquer | executável (Onda 4; prévia sempre disponível) | relatório `planAutoFarmPreview` + envio real (modo executar, 1 comando/ciclo, lane humanizado) |
| Derrubar muralhas | qualquer | prévia | `planWallDemolition` — nenhuma |
| Preparar bárbaras | qualquer | prévia | `planBarbarianCultivation` — nenhuma |
| Buscar bárbaras (map-farm) | qualquer | prévia | parser de /map/village.txt — nenhuma |

Engines puras da extensão (op/support/resource/balancer/auto-farm/gc-template/scheduler-state/server-clock) vivem em `src/ext/` **com os testes originais** (150 testes). Transporte de tela em `modules/tsh/tsh-transport.ts` (seletores canarados no br142, 2-passos com matcher fail-closed, API-first market/scavenge via `TribalWars.post`, zero retry de mutação).

## Comandos

```bash
cd staff-hub-toxic-squad            # raiz do monorepo
node toxic-squad-hub/build.mjs       # bundle + ofusca + node --check + meta.js
node toxic-squad-hub/build.mjs --watch
node_modules/.bin/tsc -p toxic-squad-hub/tsconfig.json   # typecheck (strict)
node_modules/.bin/vitest run toxic-squad-hub/            # testes do pacote
```

Gates antes de qualquer entrega: `tsc` limpo + `vitest run` completo (monorepo) + build verde.

## Licença/ativação

Mesmo sistema do canal anterior (chaves `SHS-…` emitidas no painel Staff Hub → Admin → Chaves In-Game; validação em `http://74.0.5.75/staffhub/api`, revalidação 24h, graça 72h). A chave fica vinculada à conta do jogo. Storage `shs-in-game:*` inalterado — quem tinha licença ativa não precisa reativar.

## Publicação

O build NÃO publica. O dono sobe `dist/toxic-squad-hub.user.js` + `dist/toxic-squad-hub.meta.js` para o canal (`74.0.5.75/staffhub/scripts/`). O `userscript/` antigo (staff-hub-in-game v1.2.0) segue intacto como rollback — os dois scripts têm `@name` diferente e coexistem no Tampermonkey.
