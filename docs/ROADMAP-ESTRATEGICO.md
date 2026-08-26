# Staff Hub Toxic Squad — Análise Estratégica e Roadmap

> **✅ STATUS 26/08/2026: Sprints 1–4 CONCLUÍDAS** (v0.13.2, commits `2d4485a`→`06a2830` + revisão geral) —
> todos os itens C1–C9, U1/U3/U5 e P0-1..P0-10 entregues, testados (285 testes) e no GitHub.
> Pendências conhecidas: fixture do formulário de novo tópico (post do plano usa edição do 1º post,
> validada por fixture real), QA em jogo das mutações novas com a sessão do dono logada, P1/P2 futuros.

> Síntese de 3 análises independentes: Produto (25 features), Código (15 achados técnicos), UX (15 propostas)
> Data: 26/08/2026 · Versão atual: 0.9.1 · 169 testes · 7 módulos funcionais

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

| # | Feature | Módulo | Esforço |
|---|---------|--------|---------|
| 11 | Biblioteca de templates de MP (placeholders #nick#, #op#, #horarios#) | SG_6 | S |
| 12 | Diff entre rodadas da conferência (novo/cancelado/inesperado) | SG_5 | S |
| 13 | Blind por níveis de aldeia (desiredUnits por faixa de distância) | SG_3 | M |
| 14 | Débito de blind por jogador (acumulado entre coletas) | SG_3 | M |
| 15 | Tópico de blind salvo + histórico SG_7 | SG_7 | S |
| 16 | Fakes inteligentes (espalhados, atribuição a quem tem comando sobrando) | SG_4 | M |
| 17 | Verificação pós-OP (taxa de conquista, nobres desperdiçados) | SG_5 + novo | M |
| 18 | Dashboard de guerra (diff de dumps = conquistas/perdas) | SG_1/novo | M |
| 19 | Perfis de inimigos no tempo (crescimento/queda por jogador) | novo | M |
| 20 | Notificações T-minus (countdown na bandeja do sistema) | app | S |
| 21 | Overlay da OP no mapa (alvos/fakes/origens + linhas) | SG_4/SG_1 | S |
| 22 | Export/import de OP em JSON (compartilhar entre a staff) | novo | S |

### P2 — NICE-TO-HAVE

| # | Feature | Módulo | Esforço |
|---|---------|--------|---------|
| 23 | Agendamento de coletas automáticas | services | S |
| 24 | Parser de relatórios de espionagem | novo | L |
| 25 | Linha de frente animada (replay no mapa) | SG_1 | M |

---

## 🎨 ROADMAP DE UX (15 propostas ordenadas por impacto em guerra)

| # | Problema | Solução | Impacto | Esforço |
|---|----------|---------|---------|---------|
| U1 | Navegação destrói o estado da OP | Manter páginas montadas (render todas, esconder com `hidden`) — estado sobrevive à navegação | Alto | M |
| U2 | Área de transferência é a única ponte entre módulos | "Mesa da OP": painel persistente com artefatos da OP corrente + botão "Enviar para…" em cada resultado | Alto | M |
| U3 | Nenhum sinal global de operação em andamento | Indicador na TitleBar ("2 operações · coleta 12/57") + toasts que sobrevivem à navegação | Alto | M |
| U4 | Mutações longas sem progresso parcial | ProgressBar dentro do painel de confirmação + resultados em streaming | Alto | M |
| U5 | MP confirmada sem pré-visualização | Renderizar a 1ª MP com #alvos# substituído + validar nicks antes de confirmar | Alto | S |
| U6 | Impossível ver dois módulos ao mesmo tempo | Botão "Abrir em nova janela" usando o deep link `?page=` que já existe | Alto | S |
| U7 | Tabelas grandes sem busca/filtro | SG_1: filtro por tag + "só marcadas"; SG_2: ordenar por aldeias, busca de nick, drill-down melhor | Alto | S |
| U8 | Falha no meio da mutação sem recuperação | "12/50 aplicados — parou no item 13" + botão "Repetir selecionados" | Alto | M |
| U9 | Dashboard não orienta o primeiro uso | Esteira numerada 1→7 com conectores + estado real por módulo + checklist first-run | Alto | M |
| U10 | Mapa sem navegação direta | Campo "Ir para" (coord ou K) + botão "Enquadrar destaques" | Médio | S |
| U11 | Heatmap com escala relativa mentirosa | Escala absoluta em faixas de 1h + moral visível (não só title) + legenda | Médio | S |
| U12 | Zero atalhos de teclado; Ctrl+K morto | Ctrl+K abre paleta de navegação; Alt+1..9 para módulos | Médio | M |
| U13 | Erros genéricos sem próxima ação | Contrato de erro {título, causa, próxima ação} + toast de erro persistente | Médio | S |
| U14 | Duas gerações de UI convivendo | Migrar SG_3/5/6/7 para PageHeader + page-section (padrão de SG_1/2/4) | Médio | S |
| U15 | Largura fixa desperdiça monitores | Conteúdo até ~1600px + "modo guerra" (densidade compacta) | Médio | S |

---

## ⚡ ROADMAP DE CÓDIGO (15 achados técnicos)

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
Resto do P1 e P2 conforme demanda.

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
