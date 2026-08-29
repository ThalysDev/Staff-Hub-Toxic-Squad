# Módulos SG — especificação fiel (fonte: transcrições + quadros SG_1..SG_7)

> Fonte primária: pastas `SG_*` na Área de Trabalho do dono (transcricao.txt,
> texto_das_imagens.txt, quadros/*.jpg — tutorial da ferramenta original, mundo 125, tribo JuJu
> vs KINGS). Este documento condensa o que a ferramenta original FAZ; o Staff Hub replica
> fluxos, rótulos e formatos. Quando algo depender da estrutura real da página no BR142,
> validar contra fixture antes de implementar (marcado com ⚠).

Formatos canônicos usados em TODOS os módulos (encadeamento):
- Coordenadas: `123|456`; listas separadas por ESPAÇO (entrada) e opção "Separação com Enter" (saída).
- Tribos: tags separadas por `;` (`TAG;TAG;TAG`).
- Resumo jogador: `nick;qtde;coord coord`.
- Origens de OP: `nick;nroFulls;coordOrigem coordOrigem`.
- Conferência: `nick;coord alvo` (uma linha por jogador).
- Pedido de blindagem (comentário no fórum): `pedido/lanceiros/espadachins/arqueiros` — ex.: `243/100/0/0`.

## SG_1 — Análise de Aldeias e Distâncias
Telas originais: `screen=ally&mode=members_defense` (painel) e `screen=wars` (mapa).

Formulário (rótulos exatos):
- TAG TRIBO ANALISADA (TAG) — a tribo própria (ex.: JuJu)
- TAG TRIBOS INIMIGAS (TAG;TAG;TAG)
- K DESEJADO (45 46 55) — filtros por continentes K (espaço entre valores)
- COORDENADAS INIMIGAS DESCONSIDERADAS (123|456 456|123 111|222)
- K ALDEIAS INIMIGAS DESCONSIDERADAS (45 46 55)
- COORDENADAS INIMIGAS CONSIDERADAS (123|456 456|123 111|222)
- COORDENADAS ALIADAS CONSIDERADAS (123|456 456|123 111|222)

Ação `Obter Dados Aldeias` → para CADA aldeia da tribo analisada, tempo de NOBRE até a aldeia
inimiga mais próxima (após filtros consider/desconsider) → contagens nos 11 buckets
(<1h, 1-2, 2-3, 3-4, 4-5, 5-8, 8-12, 12-18, 18-24, 24-34, >34h; ver `src/shared/buckets.ts`)
+ textarea por bucket: `ALDEIAS COM DISTANCIA DE NOBRE <faixa> DO INIMIGO` com checkbox
`Separação com Enter`. Motivação original: <1h = front a blindar; >34h = não deveria ter
tropa parada (alimenta SG_2/SG_3).

Painel `Obter Análise do Mundo` (wars): tabela `Tribos do Mundo` (Tribo | Marcacao, dropdown
Marrom/Azul/Azul Ally/Vermelho, pré-marcado pela diplomacia do jogo), textarea
`Aldeias Destacadas (123|456 456|321 999|444...)`, botão `Gerar Mapa` → canvas interativo
(pan/zoom) com aldeias pintadas por tribo e destaques em branco. Fonte dos dados do mundo:
⚠ validar map dumps oficiais (`/map/village.txt.gz`, `/map/player.txt`, `/map/ally.txt`)
no BR142 antes de escolher scraping vs dump.

## SG_2 — Análise de Tropas das Aldeias
Fonte: `screen=ally&mode=members_troops` — itera o dropdown "Selecionar membro" por jogador
(⚠ validar parâmetro player_id e paginação de jogadores com >1000 aldeias).
TROPAS = recrutadas/pertencentes à aldeia (podem estar fora: apoio/ataque/coleta).

Painel: `Coletar Informações de Tropas` (progresso N/M; após membros, repassa jogadores
com >1000 aldeias), `Dados em Memória` + `Data da Última Atualização` + `Exibir Dados`
(persistência local; F5 não perde).

`Realizar Filtro de Tropas` — filtros combináveis:
- Por unidade: quantidade mínima (ex.: 9000 lanceiros); modalidade "possuem" / "não possuem".
- Escopo: por ALDEIA / por JOGADOR.
- `Coordenadas Filtradas`: colar lista (tipicamente saída do SG_1).
- Eixo X e Y mín/máx.
Saída: tabela por jogador (contagem de aldeias que batem o filtro); drill-down por aldeia
(tropas da aldeia, nº de comandos ativos, média de unidades, coordenada média); resumo
copiável `nick;qtde;coords`. Sem filtro de tropas → classificação de TODAS as aldeias em
ofensivas vs defensivas (por população; ver `src/shared/units.ts` — decisão original:
score ofensivo = bárbaro/cav. leve/arqueiro a cavalo/ariete(+nobre/paladino); defensivo =
lanceiro/espadachim/arqueiro + pesada×4).

## SG_3 — Análise de Defesa das Aldeias
Fonte: `screen=ally&mode=members_defense` — tropas FISICAMENTE na aldeia (de qualquer dono)
+ em trânsito. Coleta análoga ao SG_2 (mesmo painel de memória).

Filtros do SG_2 + específicos:
- Modalidade de contagem: "paradas" (ignora em trânsito) vs "paradas + a caminho".
- `População` ataque/defesa (peso pesada=4 no defensivo) como simplificador (ex.: ≥1000 pop defensiva).
- Verificação de BLIND: colar coords do front (ex.: saída <1h do SG_1) + unidades desejadas
  (ex.: 10000 lanceiros, 10000 espadachins) + modalidade "NÃO possuem" (OR: falta qualquer
  uma → lista) → saída por aldeia com QUANTO FALTA de cada + tabela BBCode pronta para o
  tópico de blindagem no fórum (alimenta SG_7).
- `Exibir apoiadores` (opt-in, 1 requisição por aldeia — avisar volume): quem apoia cada
  aldeia, total por apoiador, ordenação por nome/total, detectar auto-apoio.

## SG_4 — Criação de Operações
Tela original: `screen=ally&mode=contracts` (Diplomacia), 4 botões do grupo OP.

(a) `Criacao de OP com Coordenada Central`:
- `TAG TRIBOS INIMIGAS (TAG;TAG;TAG)`, `COORDENADA OP (123|456)`, `Obter Dados das Aldeias`
  → tabela `Jogador | 1 Hora | 2 Horas | ... | 8 Horas | Outras | Acao` (dropdown Alvo/Fake
  por jogador; "selecionar todos para fake" disponível).
- `Utilizar Coordenadas Ate` (dropdown 1..5 horas) — corte da coluna.
- `Obter Alvos e Fakes` → `QUANTIDADE DE ALDEIAS ALVO` + textarea `ALDEIAS ALVOS`;
  `QUANTIDADE DE ALDEIAS FAKE` + textarea `ALDEIAS FAKES` (Separação com Enter).
  No original, cria automaticamente grupos de destaque ALVOS/FAKES no mapa do jogo.

(b) `Distribuicao de Alvos de OP`:
- `TAGS TRIBOS ORIGEM (TAG;TAG;TAG)` + `TAGS TRIBOS ALVOS (TAG;TAG;TAG)` → `Obter Dados das
  Tribos e Jogadores` (coleta os dois lados; barra de progresso).
- `INFORMACOES ORIGEM (Nick;Nro Fulls;Coordenadas Origem)` — editável; origem = onde o NT
  está estacionado; CADA coordenada de origem = 1 alvo a receber.
- Alvos por LINHAS: `COORDENADAS DESTINO PRIMEIRA LINHA (123|456 456|123 111|222)` com
  `FULLS DE [de] ATE [ate]`; linha 2 idem; linhas opcionais (faixa 0–200 = todos).
- Medidor de distância: exibir em horas (+moral) — horas de NOBRE.
- `Obter Planificação`: matriz origem×alvo com tempo (h+moral), heatmap verde(perto)→vermelho
  (longe); uso: saber a que hora o comando precisa sair para a OP bater às 08:00.
- Parâmetros: `Priorizar` mais próximas/mais distantes; `Moral aceita` (ex.: 100 — jogador
  fraco não ataca alvo com moral baixa p/ ele); `Distância aceita` (máx. de campos do nobre
  no mundo, ex.: 70).
- `Realizar Distribuição`: cada origem pega o alvo mais próximo elegível (moral/distância/
  faixa de fulls da linha); alvo consumido por 1 atacante; saída `Nick;coords distribuídas`,
  órfãos separados (origens sem alvo; alvos sem atacante); `Visualização da Distribuição`
  (mapa origens verdes × alvos); simulações re-executáveis (mudar parâmetros e rodar de novo).
⚠ Fórmula de moral por mundo: extrair de get_config e validar contra o jogo.

## SG_5 — Conferência de Comandos
Tela original: `screen=ally&mode=contracts`, botões `Verificacao de Comandos de OP` e
`Verificacao Totalizador de Comandos de OP`. Depende de os membros COMPARTILHAREM comandos
com a liderança (checklist no app instruindo o membro a ativar o compartilhamento).

- Alvo-a-alvo: entrada `nick;coords` (colar da distribuição SG_4; várias linhas) → para cada
  aldeia-alvo, buscar comandos a chegar (jogador: nome-do-comando, chegada, "chega em");
  agrupado por jogador; campo de aldeia editável + re-executar (rodar ~30min antes da OP).
- Totalizador: só coords (espaço) → por jogador: nº de comandos e classificação
  (ataque grande/pequeno=fake, com nobre) para medir participação da tribo.
- `Imprimir documento` com título (ex.: "OP do dia 15/03") → PDF arquivável como prova
  (impressão sem gráficos de fundo; paisagem para caber mais colunas).

## SG_6 — Reservas e MPs
(a) Reserva em massa — tela Planejador: `screen=ally&mode=reservations`.
- Painel: textarea `Coordenadas para Reservar (123|456 456|789)` + `Confirmar Reserva em
  Massa` → uma tentativa por coordenada via formulário nativo de reserva (radios
  Coordenada/Nome da aldeia/Nome do jogador; ⚠ capturar form+CSRF); tolera "membro já
  reservou"; relatório final por coordenada. Limites do jogo respeitados (ex.: 40 aldeias,
  7 dias). Reversível (excluir reserva depois).

(b) MPs personalizadas — tela Mensagens: `screen=mail` (⚠ capturar novo/envio).
- Inputs: `Assunto`, `Corpo` com placeholder `#alvos#`, e linhas `nick;coords` (nick EXATO,
  senão o jogo não encontra o destinatário e a MP é pulada com aviso).
- Fluxo: confirmar → fila sequencial com pacing → para cada jogador: abre nova MP, substitui
  `#alvos#` pelas coords dele, envia, próxima; journal por MP; retomável. Escala original:
  ~180 MPs por OP (60 membros × 3–5 MPs). Sigilo vs fórum (espiões).

## SG_7 — Atualização de Blindagem no Fórum
Tela: tópico de blindagem em `screen=forum&screenmode=view_thread&thread_id=X&page=last`.
- 1º post = TABELA de pedidos (nº pedido | aldeia | unidades pedidas/faltantes), editado
  pela staff; membros comentam SOMENTE no formato `pedido/lanc/esp/arc` (todas as 3 unidades
  informadas, 0 quando não envia).
- `Realizar Conferência Posts`: varre os posts da página (⚠ paginação do tópico), reconhece
  o formato rígido, soma por pedido → painel `PEDIDOS RECONHECIDOS` / `PEDIDOS RECONHECIDOS
  SOMADOS`.
- `Ajustar Conforme Script` (com confirmação): abre a edição do post da tabela, acha a linha
  do pedido, SUBTRAI o enviado, salva. `Apagar mensagens` (com modal "Você realmente deseja
  excluir as mensagens selecionadas?") remove os comentários processados.
- Responsabilidade final de conferir se a tropa realmente saiu continua da staff (o script
  só elimina o trabalho repetitivo).

---

## Fluxos Premium (v0.23–v0.26)

> Extensões entregues sobre os fluxos originais acima. Tudo abaixo existe em código
> (motor puro em `src/shared/` + UI), com teste — exceto onde marcado ⚠.

### SG_1 — Análise de Aldeias e Distâncias
- **Retry de diplomacia**: falha de diplomacia não é mais eterna — botão tentar de novo
  (`useDiplomacyRelations.retryRelations`; fix v0.21.1 para login via sid).
- **Presets de análise**: formulário salvável/carregável com nome (`PresetManager` +
  `filter-presets.ts`, persistido nas prefs do módulo).
- **Overlay da OP no mapa**: setas amarelas origem→alvo sobre o mapa mundial
  (`WorldMapCanvas`, alimentado pela distribuição do SG_4/Sala de Guerra).

### SG_2 — Análise de Tropas das Aldeias
- **Resumo Geral dos Dados em Memória**: coleta em 1 requisição + painel de resumo
  (`sg2-summary.ts` + `MemorySummarySection.tsx`) — totais, linha por jogador e por aldeia.
- **Histórico e Evolução** (`snapshot-history.ts` + `HistoryEvolutionSection.tsx`): cada
  coleta arquiva versão compacta por jogador (cap 20); comparação A/B com Δ de pop
  ofensiva/defensiva/aldeias, ranking de crescimento e **alerta de recrutamento massivo**
  (≥20k pop ofensiva ou ≥3 aldeias novas — sinal de OP inimiga se formando).
- **Contagem Full/Semi** (`full-semi.ts`): classificação das aldeias de origem da tribo.
- **Presets de consulta** (inclui full/semi) via `PresetManager`.
- **Coleta automática agendada** (v0.26): intervalo 4/6/12/24h persistido nas prefs
  (desligado por padrão); avaliado a cada 5min — só dispara com sessão logada e fila
  livre; a referência é a última coleta (`troopsAt`), então o app recém-aberto com dados
  frescos não coleta duas vezes. 100% renderer (a página é keep-mounted).

### SG_3 — Análise de Defesa das Aldeias
- **Thresholds de risco** (`incoming-risk.ts`): triagem "esta aldeia vai cair?" com limiares
  configuráveis e persistidos nas prefs (pop mínima resistente, patamar que segura nobre);
  defesa desconhecida nunca vira veredito otimista (fail-closed).
- **Blind por nível** (`sg3-engine.ts` `levelScaling`): o desejado escala pelos PONTOS da
  aldeia com clamp 0,5×–2× (checkbox + pontos de referência persistidos).
- **Débito de blind** (`blind-debt.ts`): acumulado entre rodadas por linha de pedido
  (exposto no SG_7).

### SG_4 — Criação de Operações
- **Fakes inteligentes** (`fakes-intelligent.ts` + `FakesIntelligentSection.tsx`):
  distribuição dos fakes por proximidade com máximo por origem.
- **Curva de moral** (`MoraleCurve.tsx` + `sg4-engine.ts`): fórmula oficial por pontos
  `(def/att × 3 + 0,3) × 100`; mundos clássicos sem moral por pontos desativam o campo
  (toggle "moral ativa").
- **T-minus configurável** (`tminus.ts`): marcas de alerta em texto livre (ex.: "15 5 1"),
  validadas 1–1440 min sem duplicatas; notificações na bandeja do sistema.
- **Templates de MP**: picker do corpo da MP direto na OP (biblioteca do SG_6).
- **Análise de espionagem** (v0.26, `spy-report.ts` + `SpyReportSection.tsx`): cola o
  CORPO do relatório → parser fail-closed extrai alvo/unidades/muralha/populações
  ofensiva-defensiva e sugere quantos fulls limpam a defesa; a coordenada espiada pode
  preencher a COORDENADA CENTRAL da Seção A. **⚠ validar contra fixture**: o teste usa
  relatório SINTÉTICO fiel ao formato do TW BR — confirmar contra um relatório real
  capturado do BR142 quando disponível.

### SG_5 — Conferência de Comandos
- **Filtros de visualização** (`sg5-view-filter.ts`): busca/tipo/nobre/status
  (chegados×pendentes pela âncora de carregamento); documento e Gantt derivam do filtrado.
- **Diff entre rodadas** (`sg5-diff.ts` + `Sg5DiffSection.tsx`): compara por commandId a
  última conferência (persistida nas prefs do módulo) com a atual — novos/cancelados/perdidos.

### SG_6 — Reservas e MPs
- **Biblioteca de templates** (`mp-templates-rules.ts` + `ipc-templates.ts` +
  `TemplateLibrary.tsx`): CRUD completo com template default único; picker de assunto+corpo
  no SG_6 (e corpo no SG_4); placeholders `#alvos#`/`#horarios#` documentados.

### SG_7 — Blindagem no Fórum
- **Débito de blind** (`blind-debt.ts`): soma as rodadas reconhecidas por linha de pedido e
  mostra quem deve/é credor — limitação honesta exibida na UI: o AUTOR do comentário não
  chega ao hub, a unidade do débito é a aldeia do pedido.
- **Tópicos salvos**: URLs de tópicos nomeadas com rótulo (cap 10, persistidas nas prefs).

### Guerra — Sala de Guerra

#### Planner de OP em Massa (v0.28.0)
- **Conceito**: vários GRUPOS (fake, nuke, nobre…) com configuração própria; "Gerar Operação" junta tudo numa única OP — inspirado no TW Mass Planner / Russian Planner, adaptado ao app (sem chave de acesso: barra de CONTEXTO com mundo+conta da sessão).
- **Motor puro** (`mass-planner-engine.ts` + `mass-planner-types.ts`): cruzamento origem×alvo com capacidades (Comandos por Origem/Alvo), modos de cálculo (Otimizado = guloso global pelo par mais curto / Mais perto / Mais longe), filtros por par (distância mín/máx, Torre de Vigia inimiga por distância ponto→segmento com raio 15, moral mínima por pontos `moraleOf`), chegadas (Fixa / Intervalo em minutos / Fixa com intervalo por aldeia), proteção de bônus noturno (`pushArrivalOutOfNightWindow` empurra a chegada para o fim da janela) e conflito de ms por jogador (+1ms em cascata). Partida via solver inverso `solveDepartureForArrival` (bisseção — viagem na janela noturna custa 2×). Descartes NUNCA silenciosos: voltam agregados por motivo.
- **Exportações** (`mass-planner-formats.ts`): Russian Planner (`origem alvo unidade aaaa-mm-dd hh:mm:ss` de ENVIO), TW Mass Planner (`dd.mm.aaaa hh:mm:ss`) e a agenda colável DO APP (`nick;alvo;HH:MM:SS @dd/MM`, reusando `formatSendSchedule` — mesma gramática de T-minus/comms/SG_6).
- **UI** (`MassPlannerSection.tsx`, aba "Planner em Massa" na Sala de Guerra): 17 campos da spec campo a campo + Moral Mínima (oculta em mundos sem moral) + Importar grupo salvo (store `groups`, mesmo mundo) + puxar preset da Análise de Tropas (prefs `sg2`/`presets:consulta` → nome + unidade mais lenta da composição), Demolir Edifícios (19 alvos de catapulta), Grupos Adicionados (editar/remover/limpar), resultado com descartes/avisos/partida no passado, tabela ordenada pela chegada (teto de render 1000 linhas) e arquivamento no `op-archive` (distribuição "nick;coords" + agenda colável) direto para o Monitoramento.
- **Rascunho persistente**: formulário + grupos + formatos nas prefs do módulo `guerra` (grupos como 1 chave JSON; acima do tamanho seguro fica só na sessão, com aviso explícito).
- **IPC novo**: `world.unitSpeeds()` — minutos-por-campo EFETIVOS por unidade (unit-info, cache 1 dia).
- **Reaproveitamento**: `fieldsBetween`, `moraleOf`, `night-bonus` (solver reescrito por bisseção, mesmos testes verdes), `normalizeCoordText` (contagem de inválidos/duplicadas), `UNITS` por mundo, `formatSendSchedule`, `op-archive`.

- **Pós-OP ao vivo** (`post-op-live.ts` + `PostOpSection.tsx`): taxa de conquista e nobres
  desperdiçados verificando os alvos da OP arquivada.
- **Compartilhar OP** (`op-export.ts` + `OpShareSection.tsx`): export/import JSON portável
  da OP entre a staff.
- **Evolução do mundo** (`world-history.ts` + `WorldEvolutionSection.tsx`): cada atualização
  de dumps arquiva agregado por tribo + delta de trocas de dono (cap 10); diff A/B com Δ
  colorido, conquistas/abandonos e "Mostrar no mapa".
- **Linha de frente animada** (v0.26, modo "linha do tempo"): troca o diff A/B por um
  slider cronológico (1 = mais antiga, N = mais recente); no passo K o mapa mostra as
  mudanças acumuladas até a versão K; "Reproduzir" avança o slider sozinho (1,2s por
  passo, com pausa).
- **Scorecard configurável** (`war-room.ts` `ScorecardOptions`): top N, métrica
  faltas/envios/% cumprido, janela 7/30 dias/tudo, copiar TSV (no Dashboard).

### Sistema (transversal)
- **Preferências por módulo** (`preferences-rules.ts` + `usePreferences`): prefs persistentes
  com merge raso por chave em 12 módulos (sg1..sg7, guerra, journal, dashboard, captures, geral).
- **Temas claro/escuro/sistema** (`theme.ts` + `theme-dark.css`).
- **Paleta Ctrl+K** (`CommandPalette` + `useKeyboardShortcuts`): navegação e ações rápidas;
  Alt+1..7 módulos SG, Alt+8 Sala de Guerra, Alt+9 Início.
- **Journal premium** (`journal-filter.ts` + `JournalPage`): chips de tipo + ação, busca
  acento-insensitiva, período, contagem viva, export CSV/JSON, limite configurável.
- **Atualizador automático** (`updater-service.ts` + `updater-core.ts`): canal VPS
  (nginx + latest.json), SHA-256, troca via script externo, rollback de versão e E2E
  vermelho/verde da cadeia completa (`scripts/e2e-update.mjs`).
