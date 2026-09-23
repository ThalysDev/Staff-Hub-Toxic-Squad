# PROMPT DE CONTEXTO — TOXIC SQUAD HUB (userscript) v3.0.0
> Como usar: cole este prompt INTEIRO como primeira mensagem numa nova conversa/IDE/LLM.
> Última atualização: 23/09/2026 · Versão publicada: **3.0.0 "Arsenal Completo"** · Autor da sessão: Thalys (dono) + Omen Alpha

---

## 0. QUEM SOU E O QUE É ESTE PROJETO

Eu sou o **Thalys**, dono do projeto. Meu contato de suporte ao cliente que aparece no produto: **+55 81 99413-1872** (WhatsApp). Identidade do assistente para mim: **Omen Alpha** (quando eu perguntar "quem é você", a resposta é essa).

O **Toxic Squad Hub** é um **userscript Tampermonkey PAGO (chave SHS)** de automação do jogo INDIVIDUAL no Tribal Wars BR (mundos br142 etc.). Ele é a fusão de:
- **TW Vanta v0.5.6** (meu projeto antigo, portado e corrigido)
- **Extensão Toxic Squad Hub v0.4.0** (WXT, repo `github.com/ThalysDev/toxic-squad-hub`, engines vendadas)

⚠️ **NÃO CONFUNDIR OS PRODUTOS** (são 3, no mesmo monorepo `staff-hub-toxic-squad/`):
1. `toxic-squad-hub/` — **ESTE projeto**: userscript do JOGADOR (o que este prompt descreve)
2. `userscript/` — **Staff Hub In-Game**: script da LIDERANÇA (gestão de tribo, OPs, SG_*) — NÃO TOCAR
3. `src/` (raiz) — app **Staff Hub** (Electron, v0.37.x) — NÃO TOCAR

## 1. ESTADO ATUAL (23/09/2026)

- **v3.0.0 publicada** em `http://74.0.5.75/staffhub/scripts/toxic-squad-hub.user.js` (+ `.meta.js` para update; rollback versionado `toxic-squad-hub-3.0.0.user.js` no servidor)
- 3.0.0 = "Arsenal Completo": TODO o recon de engenharia reversa do concorrente **Nexus** implementado com nomes funcionais próprios (7 ondas, ~30 commits, 2 rodadas de revisão com todos os achados corrigidos)
- **Testes: 1.893 no monorepo (838 no pacote, 51 arquivos) — TODOS VERDES · tsc strict ZERO erros · build determinístico** (SHA1 idêntico em rebuilds; obfuscator com seed fixa 20260921)
- **Canário do dono PENDENTE** (eu testo no jogo antes de considerar a versão fechada)
- Fonte da verdade da auditoria do concorrente: `C:\Users\Usuário\.zcode\workspace\default\NEXUS_RECON_COMPLETO.md` (Partes I-X, formato de linhas de apoio decodificado, IDs DOM)

## 2. A REGRA DE OURO (NUNCA QUEBRAR — decisão minha explícita)

> **Comandos "cravados" = precisão MÁXIMA de milissegundos, SEM humanização NUNCA.**
> **Fakes e rotinas (farm, coleta, recrutamento, construção, mercado, cunhagem) = humanizados** (intervalo 300ms, variação 20%, pausa programada, fake limit do mundo).

Onde vive no código (cadeia completa — qualquer mudança no agendador deve preservar):
1. `src/ext/core/humanize/humanize-policy.ts` — engine pura: faixas `precisao`/`humanizado`, `laneForSchedulerRecord(record)` é a **ÚNICA fonte de lane** (nunca hardcode), `routineWaitMs`
2. `src/modules/tsh/tsh-humanize.ts` — porta runtime (política persistida em GM, espera FORA das filas de rede; pausa ativa → pula ciclo com erro HUMANIZE_PAUSE)
3. `src/core/net.ts` — **DUAS filas seriais**: `enqueue` (normal, ≥200ms) e **`enqueueUrgent`** (precisão — nunca espera a normal; urgentes entre si ≥200ms). `createSerialQueue(gapMs)` é a fábrica pura
4. `src/modules/tsh/tsh-transport.ts` — `CommandOptions.lane` (default 'precisao'); submit usa fila urgente nos 2 passos; `cancelGameCommandsAtTarget(target, count, preparsedHtml?)` é precisão pura (POSTs com timeout 15s)
5. Cancelamento snipe: pré-leitura da Visão de Comandos durante a mira (`void prereadCancelPage` concorrente ao sleep, TTL 45s) — no instante sendAt só POSTs urgentes correm

## 3. ARQUITETURA (3 CONTRATOS DE REGISTRO)

Entrada: `src/main.ts` → gate de licença SHS (`core/license.ts`, POST `http://74.0.5.75/staffhub/api/key/validate` via GM_xmlhttpRequest, ticket HMAC, graça 72h) → shell Shadow DOM (`core/shell.ts`, tokens `--shs-*` pergaminho/latão) → seções + heartbeat. **Aba Sentinela** (`tsh-sentinela.ts`): URL com `&tsh-sentinela=1` pula o shell, roda só heartbeat + badge no title (aba de fundo que mantém automações ciclando; locks por mundo já impedem dupla mutação).

**Registro (sempre por import side-effect):**
| Contrato | Onde | Para quê |
|---|---|---|
| `registerSection(SectionDef)` | `core/shell.ts` | aba da sidebar do painel (Início, Suite Vanta, Automações, Ajuda & Sobre) |
| `registerVanta(VantaLauncher)` | `modules/vanta/vanta-registry.ts` | ferramenta que INJETA UI numa tela do jogo (`match()`, `url()`, `mount(scope)` idempotente com guard por id) |
| `registerTsh(TshAutomation)` | `modules/tsh/tsh-runtime.ts` | automação por CICLOS: heartbeat 30s, opt-in (nasce desligada), ARMAR 30min p/ mutantes (exceção `armExempt`), F2 (≤1 mutação/ciclo), cooldown gravado ANTES, lock de aba por mundo (TTL 2min, `renewTshLock`), janela ativa + **parada programada universal** (`stopEnabled`+`stopAt`) |

**Infra transversal:** `core/net.ts` (pacedGet cache 60s + sentinelas captcha/sessão; mutações API-first via `TribalWars.post`, 1 tentativa, **nunca retry em mutação incerta**), `core/storage.ts` (GM JSON), `core/ui.ts` (helpers anti-XSS: createElement+textContent, NUNCA innerHTML com dado dinâmico), `core/icons.ts` (~36 SVG inline).

**Transporte de mutações** (`modules/tsh/tsh-transport.ts`): `submitCommand2Step` (2 passos com matcher fail-closed da tela de confirmação; catapulta via `opts.catapultTarget`), `recruitUnits`, `upgradeBuilding`, `mintCoins`, `premiumExchange`, `sendResources`, `sendScavenging*`, `launchPaladinTraining` — todos de rotina passam pelo gate de humanização. Erros: `transportError(msg, code, afterMutation)`; seletores mudaram → `PAGE_SELECTOR_CHANGED`.

**Engines puras** em `src/ext/` (node-safe, testadas, zod): `core/scheduler-state.ts` (coração do agendador — kinds attack/support/noble/fake/**cancel**, campos `cancelCount` 1-20/`sequentialCount`/`timingStrategy` direto|snipe|dodge/`forced`/`catapultTarget`/`percentMode`+`unitsPercent`; 4 escritores gravam no storage `tsh-auto:<mundo>:command-scheduler:scheduler`), `core/{game-groups, timing/adaptive-clock, humanize, troop-models}`, `modules/features/{noble-train, block-scheduler, ops-viewer, conquest, village-renamer, inventory, auto-farm/*, mass-support/*, resource-balancer/unified-balancer, mega-builder/gc-template-codec}`.

## 4. INVENTÁRIO FUNCIONAL (o que existe HOJE)

**Seções do painel:** Início (Painel de Atividades ao vivo) · Suite Vanta · Automações · Ajuda & Sobre · **busca rápida Ctrl+K** (procura em seções+launchers+automações, sem acento)

**Suite Vanta (19 launchers, injetam na tela certa):** Painel de Incomings + Cores (defesa), Renomeador de comandos por tags, Saúde do Stack, **Distribuidor de Apoios** (aba nativa `place&mode=call`: totais da conta ao vivo, origens por grupo, formato de linha `x|y u1..u10 [i]DD/MM-HH:MM:SS:mmm [DD/MM-HH:MM:SS:mmm]` — `i`=janela de snipe; popup Inserir por coordenadas; distribuição min/max/pacotes com guardas e reservas; imediato/cravado; export BBCode fórum), Blindagem, Visão de Apoios, Coletor/Alocador, Relíquias, Etiquetador **com alarme sonoro (4 sons, gatilhos qualquer/nobre+aríete/nobre)**, Auto Cunhar, **Inspeção de Aldeias** e **Prévia de Aldeia** (mapa), **Cancelamento em Bloco**, **Import/Export de Grupos**, **Bônus Diário**, **Mapa Enxuto**, **Bloco de Campo** (notas locais por aldeia) + **Notas no Mapa** (●), **Agenda das Aldeias** (coluna no overview + filtros + copiar visíveis). Vanta nasce LIGADA por default (switch por módulo).

**Automações TSH (23, todas nascem DESLIGADAS):**
- *Economia:* Cunhagem de moedas (keepPercent), Mercado Premium (estratégia melhor-taxa/necessidade, ppLimit), Balanceador (alvos por coordenadas, modos média/cunhagem/igual), Paladino-recruta
- *Produção:* Recrutamento (**modelos de tropa por grupo** — presets Lanceiro/Lança+CL/Defesa/Ataque em `troop-models.ts`; custom aguarda escritor da UI), Mega Construtor (visão Fila/Horas, quests, comparar PP), Coleta (regras por grupo "grupoId:duração:lote:min", reservas por unidade), **Agendador de Comandos** (`armExempt` — agendar JÁ é a autorização; autoSend desligado SEGURA o comando: hold→vencido=falhou, nunca dispara atrasado)
- *Planejamento:* **Central de Agendamentos** (percentual, colar horário HH:mm[:ss[:ms]], catapulta, Sequência de Nobres 2-5 com gap calibrado, **Cancelamento Cronometrado** 1-20, snipe/dodge, forçar, **Agendamento em Bloco** com cotas "2;1" e otimizador 2-opt, **Mapa de Operações** com conflitos de ms e edição em massa, import/export JSON), Gerador de OPs, Apoio em Massa (imediato=humanizado; defesa=grava registros no agendador), Gestão de Apoio, **Auto Farm executável** (modos preview/executar, Template C dinâmico, mapeador de bárbaras alimentado pelo Auto Farm pelo Mapa, ledgers), Demolidor de Muralhas e Cultivador (execução opcional c/ ledger), **Conquista de Aldeias Livres** (grava nobres no agendador — requer Agendador LIGADO), **Produção de Nobres** (consome unified-balancer), Renomeador de Aldeias (tokens {numero}{coord}{k}{pontos}{texto}), Agendador de Itens, Gerenciador do Paladino (skills), Abertura de Pacotes, Cunhagem Nativa, Doador de Prestígio
- *Alertas:* `tsh-alerts.ts` (som local por evento — produtores: comando_falhou/comando_enviado-nobre; **webhook WhatsApp/Discord = STUB DESLIGADO por decisão do dono** — nada sai do navegador)

## 5. COMANDOS DO DIA A DIA (Windows/Git Bash, cwd = `staff-hub-toxic-squad/`)

```bash
node_modules/.bin/tsc --noEmit -p toxic-squad-hub/tsconfig.json   # typecheck (ZERO erros obrigatório)
node_modules/.bin/vitest run toxic-squad-hub/                     # testes do pacote (838)
node toxic-squad-hub/build.mjs                                    # build ofuscado + node --check + meta.js
node scripts/publish-toxic-squad-hub.mjs                          # publica na VPS (SFTP, valida versão/ofuscação/grants)
```
- Build: esbuild → javascript-obfuscator (seed fixa, `renameGlobals:false` load-bearing p/ grants) → header TM re-anexado. **`dist/` é gitignored.**
- Publicar sobe: `toxic-squad-hub-<versão>.user.js` (rollback) + `toxic-squad-hub.user.js` (latest) + `.meta.js` para `/var/www/staffhub-updates/scripts/`
- **PUBLICAR SÓ COM MEU OK EXPLÍCITO** (eu testo o canário antes). Nunca publicar bundle puro do esbuild.

## 6. CONVENÇÕES E RULINGS (respeitar SEMPRE)

1. TypeScript **strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes**; zero `any`; zero innerHTML com dado dinâmico (createElement/textContent; casca estática ok)
2. **Fail-closed**: seletor/tela desconhecida → erro pt-BR claro (código PAGE_SELECTOR_CHANGED), NUNCA adivinha; mutação incerta (`afterMutation`) NUNCA repete; storage sujo → defaults/zod, nunca crash
3. Testes: engines puras primeiro (node env, sem DOM — o repo NÃO tem jsdom); funções de decisão extraídas puras e testadas; DOM validado no jogo por mim
4. **Git com agentes paralelos: `git commit -m "..." -- <paths>` explícito** (um commit com add implícito varreu arquivos alheios uma vez — sem perdas, mas não repetir)
5. Trabalho em **ondas**: specs de arquivo → implementadores paralelos SÓ em arquivos novos/por dono único → integração serial pelo agente principal → **reviewer em cada marco** → gates (tsc+vitest) antes de commit → bump de versão por onda
6. Nomes de feature: **funcionais em pt-BR** (nunca copiar branding do Nexus; vocabulário genérico do jogo — NT, fake, apoio — pode)
7. Datas do jogo: 3 convenções documentadas em `apoio-massa-logic.ts` (relógio servidor vs ISO agendador vs digitação local) — cuidado ao mexer em tempo
8. Mundo = subdomínio do hostname (fallback `game_data.world`); chaves GM namespaced `tsh-auto:<mundo>:<id>:*`, `tsh-vanta:*`, `tsh-groups:<mundo>`, `tsh-models:<mundo>`, `tsh-humanize:*` (global por decisão), `tsh-alerts:config`
9. Relatórios para mim: **linguagem leiga** (problema→solução→ganho, o que NÃO foi tocado) — eu decido "aplica" depois de entender
10. Risco de ban é ASSUMIDO (decisão minha original) — humanização reduz padrão de robô, não elimina

## 7. LACUNAS CONHECIDAS / FOLLOW-UPS (aceitos, documentados)

- **Sem fixtures reais** de: Praça `try=confirm`, `mode=commands`, inventário, estátua/paladino, tela de bônus, ally level → os 5 fluxos best-effort da Onda 5 (cunhagem nativa, pacotes, itens, paladino, doador) podem reportar "controle não encontrado" no primeiro uso real — ajustar seletores com a tela viva; status verde deles não prova efeito
- `#serverTime` tem granularidade de SEGUNDOS → precisão absoluta de ms é contra o relógio adaptativo (`timing/adaptive-clock.ts`, mediana aparada), não contra o servidor
- `timingStrategy` 'dodge' ≡ 'snipe' mecanicamente (âncora na chegada); `sequentialCount` é campo morto (UI replica registros); UI de modelos de tropa custom não existe (engine pronta em `troop-models.ts`)
- `tsh-models:<mundo>` sem escritor; badge da Sentinela conta módulos ligados (não os que efetivamente ciclam nela); webhook de alerta é stub (console.info)
- Auto Farm: `lastScoutedAt` nasce null (sem fonte de exploração); edifício-alvo das catapultas é planejado mas o transporte não seleciona o alvo na confirmação (limitação do jogo via transporte atual)

## 8. O QUE ESPERO DE VOCÊ AGORA

1. Confirme que leu e entendeu a regra de ouro e os 3 contratos de registro
2. Espere minha instrução específica — não implemente nada por conta; se eu disser **"implementa"**, siga o protocolo de ondas do item 6.5
3. Dúvidas de escopo: os produtos `userscript/` e app Staff Hub estão FORA deste contexto — nunca tocar sem eu pedir
4. Documentos de referência no disco: `NEXUS_RECON_COMPLETO.md` (workspace), `toxic-squad-hub/README.md`, `AGENTS.md` (raiz do monorepo), `src/ext/**` (contratos)
