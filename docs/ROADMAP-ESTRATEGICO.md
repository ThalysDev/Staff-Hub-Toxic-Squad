# Staff Hub Toxic Squad — Análise Estratégica e Roadmap

> **✅ STATUS 26/08/2026 (v0.26): P0 e P1 100% CONCLUÍDOS.**
> - **P0-1..P0-10**: entregues nas Sprints 1–4 (v0.9→v0.13, commits `2d4485a`→`41aab06` + revisão geral).
> - **P1-11..P1-22**: TODOS entregues (v0.19–v0.25 — ver coluna Status na tabela P1).
> - **Correções C1–C9**: entregues (Sprint 1 + auditorias v0.19/v0.20).
> - **UX**: entregues U1/U3/U5/U12/U14 · parciais U4/U7/U8 · pendentes U2/U6/U9/U10/U11/U13/U15.
> - **P2-23/24/25: CONCLUÍDOS na v0.26** — coleta auto-agendada (SG_2, intervalos 4/6/12/24h),
>   parser de espionagem (⚠ teste com relatório SINTÉTICO — validar contra fixture real) e
>   linha de frente animada (modo "linha do tempo" na Evolução do Mundo, com reprodução).
> - Suite atual: **710 testes em 50 arquivos, todos verde** (656 na v0.25 + 54 novos na
>   v0.26: espionagem, coleta automática, linha de frente e testes de mutação SG_6/SG_7
>   com sessão mockada) · 34 fixtures reais BR142.
> - Extras entregues fora do roadmap: atualizador automático E2E com canal VPS + rollback
>   (v0.15–v0.22.1), temas claro/escuro, preferências por módulo, paleta Ctrl+K, journal
>   premium com export, Resumo Geral do SG_2, perfis no tempo, evolução do mundo.

> Síntese de 3 análises independentes: Produto (25 features), Código (15 achados técnicos), UX (15 propostas)
> Data: 26/08/2026 · Versão atual: 0.26 · 710 testes · 7 módulos funcionais + Sala de Guerra

---

## 📖 Diagnóstico Estratégico

### O que o app é HOJE
Uma replicação fiel da ferramenta original (mundo 125, userscripts, 2015) — mas em app desktop com persistência, testes e política de segurança. Funcional ponta a ponta.

### O que está LIMITANDO o salto
A ferramenta original era restrita ao que um userscript fazia em 2015. O Staff Hub tem 3 capacidades que ela não tinha — **persistência local (JsonStore), processamento offline e journal** — e elas estão **subutilizadas**:

| Capacidade subutilizada | Consequência |
|--------------------------|-------------|
| Persistência (JsonStore) | Snapshots morrem na tela; totalizador do SG_5 não persiste por OP; dados não são comparados entre coletas |
| Processamento offline | Planejamento é estático (heatmap); nada calcula hora de envio; nada diffa dumps ao longo do tempo |
| Journal | Só registra eventos; não alimenta scorecard de membros nem histórico de OPs |

### A frase que resume
> "O maior salto de valor não é adicionar mais consultas: é **transformar snapshots pontuais em linha do tempo** e **planejamento estático em execução assistida**." — Análise de Produto

---

## 🔥 CORREÇÕES URGENTES (antes de qualquer feature nova)

Bugs de código que afetam a confiabilidade AGORA:

| # | Problema | Impacto | Esforço |
|---|----------|---------|---------|
| C1 | Pacing persistido NÃO é aplicado no boot (index.ts:194) | Usuário configura 1200ms, reinicia, volta para 350ms sem saber | S |
| C2 | Múltiplas instâncias de JsonStore('settings') com cache obsoleto | Usuário aumenta teto, app confirma, mas services continuam com valor antigo | S |
| C3 | Race condition: dois world.refresh() concorrentes | Downloads duplicados + save corrompível | S |
| C4 | Mutações e refresh contornam o single-flight da RequestQueue | Coleta + reserva + refresh ao mesmo tempo = pacing triplicado (risco de ban) | M |
| C5 | sendMps continua após sentinela de sessão expirada | 180 POSTs para página de login | S |
| C6 | JSON.stringify pretty-print de 40k aldeias bloqueia o event loop | App congela por segundos no refresh de mundos grandes | S |
| C7 | dev:capture-fixture aceita URL arbitrária em produção | SSRF autenticado se renderer comprometido | S |
| C8 | dryRun morto no contrato mas vivo nas settings | Inconsistência que confunde service futuro | S |

**Total esforço: ~2-3 dias** — resolver essas primeiro.

---

## 🎯 ROADMAP DE PRODUTO (25 features priorizadas)

### P0 — CRÍTICO (sem isso o app é incompleto para uso real em guerra)

> ✅ **P0-1..P0-10: TODOS CONCLUÍDOS** (Sprints 1–4, v0.9.1→v0.13.2). A moral (item 6)
> foi além do previsto: fórmula oficial por pontos desde v0.16.

| # | Feature | Módulo | O que faz | Esforço |
|---|---------|--------|-----------|---------|
| 1 | **Calculadora de Hora de Envio** | SG_4 | Campo "OP bate às HH:MM" → coluna "enviar às" por origem×alvo; saída vira `nick;alvo;enviar às` | M |
| 2 | **Trem de nobres / multi-onda** | SG_4 | N nobres por alvo com espaçamento (s) + ondas (limpa/nobres/fakes com offsets) | M |
| 3 | **Gantt de chegadas + countdown** | SG_5 | Timestamps em formato máquina + timeline visual com contagem regressiva ao vivo | M |
| 4 | **Sala de Guerra da OP** | nova view | Tela única: % de cobertura, alvos sem comando, por-jogador enviado/faltante, re-verificar com 1 clique | M |
| 5 | **Detecção de ataques recebidos** | SG_3 | Varrer comandos chegando nas aldeias próprias → triagem "esta aldeia vai cair" | M |
| 6 | **Bônus noturno + moral calibrada** | shared | Ler bônus noturno do get_config e aplicar; calibrar fórmula da moral | S |
| 7 | **Auto-preencher origens do SG_2** | SG_4 + SG_2 | Gerar `nick;fulls;coords` a partir do snapshot (snobs por aldeia + dono) em 1 clique | S |
| 8 | **Pacote de comunicação da OP** | SG_6 | Da distribuição pronta: MPs com `#alvos#` E `#horarios#`, post BBCode do plano, lista de reservas | M |
| 9 | **Arquivo de OPs** | SG_4/SG_5 | Persistir cada OP (alvos, distribuição, conferências) com título e data | M |
| 10 | **Participação histórica** | SG_5 + novo | Totalizador gravado por OP → scorecard enviado/faltou por membro ao longo das OPs | S |

### P1 — IMPORTANTE (melhora muito a experiência)

> ✅ **P1-11..P1-22: TODOS CONCLUÍDOS** (v0.19–v0.25). Coluna Status = versão em que
> entrou + onde está no código.

| # | Feature | Módulo | Esforço | Status |
|---|---------|--------|---------|--------|
| 11 | Biblioteca de templates de MP (placeholders #nick#, #op#, #horarios#) | SG_6 | S | ✅ v0.24 — `mp-templates-rules.ts` + `TemplateLibrary` |
| 12 | Diff entre rodadas da conferência (novo/cancelado/inesperado) | SG_5 | S | ✅ v0.19/v0.23 — `sg5-diff.ts` + `Sg5DiffSection` |
| 13 | Blind por níveis de aldeia (desiredUnits por faixa de distância) | SG_3 | M | ✅ v0.25 — `sg3-engine.ts` `levelScaling` (escala por pontos, clamp 0,5×–2×) |
| 14 | Débito de blind por jogador (acumulado entre coletas) | SG_3 | M | ✅ v0.25 — `blind-debt.ts` (por linha de pedido: autor do comentário não cruza o IPC) |
| 15 | Tópico de blind salvo + histórico SG_7 | SG_7 | S | ✅ v0.25 — tópicos salvos com rótulo (cap 10, prefs) |
| 16 | Fakes inteligentes (espalhados, atribuição a quem tem comando sobrando) | SG_4 | M | ✅ v0.19 — `fakes-intelligent.ts` (proximidade + máx. por origem) |
| 17 | Verificação pós-OP (taxa de conquista, nobres desperdiçados) | SG_5 + novo | M | ✅ v0.21 — `post-op.ts`/`post-op-live.ts` + `PostOpSection` |
| 18 | Dashboard de guerra (diff de dumps = conquistas/perdas) | SG_1/novo | M | ✅ v0.25 — `world-history.ts` + `WorldEvolutionSection` (Sala de Guerra) |
| 19 | Perfis de inimigos no tempo (crescimento/queda por jogador) | novo | M | ✅ v0.25 — `snapshot-history.ts` + `HistoryEvolutionSection` (SG_2) |
| 20 | Notificações T-minus (countdown na bandeja do sistema) | app | S | ✅ v0.19 — `tminus.ts` (marcas configuráveis desde v0.24) |
| 21 | Overlay da OP no mapa (alvos/fakes/origens + linhas) | SG_4/SG_1 | S | ✅ v0.21 — `WorldMapCanvas` (setas origem→alvo) |
| 22 | Export/import de OP em JSON (compartilhar entre a staff) | novo | S | ✅ v0.19 — `op-export.ts` + `OpShareSection` |

### P2 — NICE-TO-HAVE

> ✅ **P2-23/24/25: CONCLUÍDOS na v0.26** (verificados no código em 26/08/2026).

| # | Feature | Módulo | Esforço | Status |
|---|---------|--------|---------|--------|
| 23 | Agendamento de coletas automáticas | services | S | ✅ v0.26 — intervalo 4/6/12/24h nas prefs do SG_2 (desligado por padrão); scheduler 100% renderer avalia a cada 5min (sessão logada + fila livre + intervalo vencido desde a última coleta) |
| 24 | Parser de relatórios de espionagem | novo | L | ✅ v0.26 — `spy-report.ts` fail-closed (alvo/unidades/muralha/populações + sugestão de fulls; seção no SG_4). ⚠ validar contra fixture: teste usa relatório SINTÉTICO fiel ao TW BR |
| 25 | Linha de frente animada (replay no mapa) | SG_1 | M | ✅ v0.26 — modo "linha do tempo" na Evolução do Mundo (Sala de Guerra): slider cronológico cumulativo + "Reproduzir" (1,2s/passo) sobre o mapa |

---

## 🎨 ROADMAP DE UX (15 propostas ordenadas por impacto em guerra)

> Status real em 26/08/2026 (v0.26): ✅ entregues **U1, U3, U5, U12, U14** · ◐ parciais
> **U4, U7, U8** · ❌ pendentes **U2, U6, U9, U10, U11, U13, U15**.

| # | Problema | Solução | Impacto | Esforço | Status |
|---|----------|---------|---------|---------|--------|
| U1 | Navegação destrói o estado da OP | Manter páginas montadas (render todas, esconder com `hidden`) — estado sobrevive à navegação | Alto | M | ✅ Sprint 1 |
| U2 | Área de transferência é a única ponte entre módulos | "Mesa da OP": painel persistente com artefatos da OP corrente + botão "Enviar para…" em cada resultado | Alto | M | ❌ Pendente — sem "Mesa da OP"; mitigado parcialmente pelo pacote de comunicação (Sprint 4) e pelo export/import de OP (v0.19) |
| U3 | Nenhum sinal global de operação em andamento | Indicador na TitleBar ("2 operações · coleta 12/57") + toasts que sobrevivem à navegação | Alto | M | ✅ Sprint 3 (`useQueueActivity`) |
| U4 | Mutações longas sem progresso parcial | ProgressBar dentro do painel de confirmação + resultados em streaming | Alto | M | ◐ Parcial — progresso N/M e relatório final por item nas coletas/mutações; sem streaming dentro do painel de confirmação |
| U5 | MP confirmada sem pré-visualização | Renderizar a 1ª MP com #alvos# substituído + validar nicks antes de confirmar | Alto | S | ✅ Sprint 2 (`mp-preview.ts`) |
| U6 | Impossível ver dois módulos ao mesmo tempo | Botão "Abrir em nova janela" usando o deep link `?page=` que já existe | Alto | S | ❌ Pendente — não há "abrir em nova janela" |
| U7 | Tabelas grandes sem busca/filtro | SG_1: filtro por tag + "só marcadas"; SG_2: ordenar por aldeias, busca de nick, drill-down melhor | Alto | S | ◐ Parcial — SG_2 tem "Ordenar por" e drill-down; SG_1 sem filtro por tag/"só marcadas" |
| U8 | Falha no meio da mutação sem recuperação | "12/50 aplicados — parou no item 13" + botão "Repetir selecionados" | Alto | M | ◐ Parcial — falhas por item registradas (`failures[]`, journal, MP pulada com aviso); sem botão "Repetir selecionados" |
| U9 | Dashboard não orienta o primeiro uso | Esteira numerada 1→7 com conectores + estado real por módulo + checklist first-run | Alto | M | ❌ Pendente — Dashboard tem "Scorecard da staff" e "Frente de operações", sem esteira/checklist first-run |
| U10 | Mapa sem navegação direta | Campo "Ir para" (coord ou K) + botão "Enquadrar destaques" | Médio | S | ❌ Pendente |
| U11 | Heatmap com escala relativa mentirosa | Escala absoluta em faixas de 1h + moral visível (não só title) + legenda | Médio | S | ❌ Pendente |
| U12 | Zero atalhos de teclado; Ctrl+K morto | Ctrl+K abre paleta de navegação; Alt+1..9 para módulos | Médio | M | ✅ v0.19+v0.23 — Ctrl+K abre `CommandPalette`; Alt+1..7 SG, Alt+8 Guerra, Alt+9 Início (`useKeyboardShortcuts`) |
| U13 | Erros genéricos sem próxima ação | Contrato de erro {título, causa, próxima ação} + toast de erro persistente | Médio | S | ❌ Pendente |
| U14 | Duas gerações de UI convivendo | Migrar SG_3/5/6/7 para PageHeader + page-section (padrão de SG_1/2/4) | Médio | S | ✅ SG_3/5/6/7 usam `PageHeader` |
| U15 | Largura fixa desperdiça monitores | Conteúdo até ~1600px + "modo guerra" (densidade compacta) | Médio | S | ❌ Pendente |

---

## ⚡ ROADMAP DE CÓDIGO (15 achados técnicos)

> Status: **C1–C9 CONCLUÍDOS** (Sprint 1 + auditorias v0.19/v0.20). **C11** endereçado na
> v0.26: mutações do SG_6/SG_7 ganharam testes com sessão mockada (`tests/main/electron-mock.ts`
> + `sg6-service.test.ts`/`sg7-service.test.ts` contra fixtures reais do BR142). C10 e C12–C15
> C10 está ENTREGUE (envelope de erro no preload desde a v0.14 — strip do prefixo 'Error invoking remote method'); C12–C15 permanecem como achados abertos, sem verificação de fix no código (C15 tem mitigação prática: o mapa já pré-renderiza numa camada offscreen via canvas element — a API OffscreenCanvas nativa e o chunking por requestIdleCallback NÃO foram implementados).

| # | Severidade | Problema | Fix | Esforço |
|---|-----------|----------|-----|---------|
| C1 | ALTA | Pacing não aplicado no boot | settingsStore.load() → queue.updateSettings() no whenReady | S |
| C2 | ALTA | Cache JsonStore obsoleto entre instâncias | DI de uma instância compartilhada ou revalidação por mtime | S |
| C3 | ALTA | Race de world.refresh() | Mutex/flag refreshing no WorldDataService + writes serializados no JsonStore | S |
| C4 | ALTA | Mutações contornam single-flight | Semáforo global de pacing no main | M |
| C5 | MÉDIA | sendMps não breaka na sentinela | break no loop (mesma semântica da reserva) | S |
| C6 | MÉDIA | JSON.stringify pretty de 40k aldeias congela | Serialização compacta + worker_threads para mundos grandes | S |
| C7 | MÉDIA | capture-fixture sem allowlist de URL | Validar `https://br\d+.tribalwars.com.br/` no main | S |
| C8 | MÉDIA | dryRun morto no contrato | Remover de AppSettings ou padronizar false | S |
| C9 | MÉDIA | Confirmação de mutação é só booleano do renderer | dialog.showMessageBox no main (defesa em profundidade) | M |
| C10 | MÉDIA | Erros IPC inconsistentes + prefixo Electron cru | Envelope de erro no preload (strip prefix + código) | S |
| C11 | MÉDIA | Mutações sem nenhum teste | Extrair funções puras e testar contra fixtures | M |
| C12 | MÉDIA | fetchWithRetry engole cancelamento | Re-lançar QueueError('cancelled') no catch | S |
| C13 | BAIXA | world() fail-closed duplicado em 6 lugares | Helper compartilhado em src/shared | S |
| C14 | BAIXA | Estado do renderer descartado a cada navegação | Cache em módulo/contexto para villages/relations/snapshot | M |
| C15 | BAIXA | Canvas redesenha 60k aldeias sincronamente | OffscreenCanvas + chunks via requestIdleCallback | M |

---

## 🗺️ SEQUÊNCIA RECOMENDADA DE EXECUÇÃO

### Sprint 1 — Fundação (1 semana)
1. **C1+C2+C3+C5** — Correções urgentes de código (settings boot, cache, race, sentinela MP)
2. **U1** — Navegação sem perda de estado (manter páginas montadas)
3. **P0-6** — Bônus noturno + moral calibrada
4. **P0-7** — Auto-preencher origens do SG_2

### Sprint 2 — Núcleo de Timing (1-2 semanas)
5. **P0-1** — Calculadora de hora de envio
6. **P0-2** — Trem de nobres / multi-onda
7. **P0-3** — Gantt de chegadas + countdown
8. **U5** — Pré-visualização de MP antes de confirmar

### Sprint 3 — Sala de Guerra + Memória (1-2 semanas)
9. **P0-4** — Sala de Guerra da OP (tela única durante a execução)
10. **P0-9** — Arquivo de OPs (persistência)
11. **P0-10** — Participação histórica por jogador
12. **U3** — Indicador global de operações na titlebar

### Sprint 4 — Defesa + Comunicação (1-2 semanas)
13. **P0-5** — Detecção de ataques recebidos
14. **P0-8** — Pacote de comunicação da OP
15. **U2** — Mesa da OP (integração entre módulos sem clipboard)
16. **C4+C9** — Single-flight global + confirmação nativa no main

### Sprint 5+ — P1 (melhorias incrementais)
> ✅ Executado: Sprints 1–4 rodaram conforme planejado (v0.9→v0.13) e TODO o P1 foi
> entregue nas ondas v0.19–v0.25 (fakes inteligentes, diff, pós-OP, overlay e export na
> v0.19–v0.21; templates, T-minus configurável e scorecard na v0.24; blind por nível,
> débito, tópicos salvos, perfis no tempo e evolução do mundo na v0.25).
> Próximo passo real: UX pendentes (U2, U6, U9, U10, U11, U13, U15) e a validação do parser de espionagem contra relatório real (P2-24 ⚠).

---

## 🏆 VISÃO DE PRODUTO (o que separa "ferramenta" de "quartel-general")

| Hoje (ferramenta de consulta) | Depois das Sprints 2-4 (quartel-general) |
|-------------------------------|------------------------------------------|
| Líder olha dados estáticos | Líder vê a OP em tempo real com countdown |
| Distribui alvos e reza | Distribui, monitora quem enviou, cobra com MP em 1 clique |
| Confere manualmente página por página | Sala de Guerra mostra % de cobertura e alvos descobertos |
| Tudo morre quando fecha a app | Arquivo de OPs + histórico de participação + scorecard |
| Dados de ontem | Diff de dumps = linha de frente se movendo |
| Planilha externa para horários | Calculadora de envio + trem de nobres no próprio app |

---

## 📊 Resumo executivo

| Dimensão | Achados | Críticos | Esforço total |
|----------|---------|----------|---------------|
| Produto | 25 features | 10 P0 | ~8-10 semanas |
| Código | 15 achados | 4 ALTA | ~1-2 semanas |
| UX | 15 propostas | 9 Alto | ~3-4 semanas |
| **Total** | **55 itens** | **23 críticos** | **~12-16 semanas** |

**Prioridade absoluta**: C1+C2+C3 (bugs de settings que quebram a confiança) → U1 (navegação sem perda) → P0-1+2+3 (timing de OP).

---

*Documento gerado pela síntese de 3 análises independentes (Produto, Código, UX) — 26/08/2026*
