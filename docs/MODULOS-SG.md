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
Fonte: `screen=ally&mode=members_troops` — itera o dropdown "Selecionar membro" por jogador.
✅ Validado no jogo real (canário 02/09, conta com 1156 aldeias): `player_id` funciona; o jogo
PAGINA membros com 1000+ aldeias (1000/página) e renderiza o pager (`paged-nav-item`) numa
tabela "vis w100" SEM `<th>` ANTES da tabela de dados — o parser escolhe a tabela com `<th>`
(pager ignorado) e a coleta segue as páginas (teto 50/membro, falha isolada por página,
dedupe por `villageId`; journal anota "Nome: N páginas"). A visão da própria conta (fallback)
usa `overview_villages&mode=units&group=0` (todos os grupos; 152 aldeias/página no BR142),
também paginada. Fixtures reais: `tests/fixtures/br142/troops-own-paged-p{1,2}-rows.html` e
`own-units-paged-p1-rows.html`.
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

- **Fonte "Disponível na aldeia (agora)" (v0.31.0; correções de acesso/staleness na v0.32.1)** — achar defesa parada na back: o filtro passa a medir pelas tropas FISICAMENTE presentes na aldeia (linha "Na Aldeia" da defesa, INCLUINDO apoio recebido de terceiros), em vez das recrutadas. Conversor puro `sg2-defense-source.ts` (`defenseToTroopSnapshot`) reaproveita o `filterTroops` inteiro (mínimos, modalidade, escopo aldeia/jogador com soma, coords/K/eixos, classificação) sobre o snapshot de defesa — `DefenseSnapshot` já vinha da MESMA coleta do SG_3 (`members_defense`; parser separa "Na Aldeia" × "a caminho"). Toggle "Paradas (só Na Aldeia)" (padrão) × "Paradas + a caminho". IPC novo de leitura `troops.getDefense()`. **v0.32.1** (achados da revisão): a seção abre com TROOPS **ou** DEFESA em memória (antes a fonte nova ficava trancada atrás de uma coleta de tropas que ela não usa); EmptyState inicial oferece as duas coletas; botão **"Atualizar da memória"** junto à fonte (puxa a última coleta do SG_3 sem recoletar — e invalida o resultado, nunca misturar coletas); preset da consulta que troca fonte/contagem invalida o resultado (o pill não pode rotular lista de outra fonte); "Restaurar padrões" também reseta fonte/contagem; coleta de defesa reporta membros com erro (failures) em vez de sucesso cego. Fonte e contagem persistem nas prefs `sg2` e viajam nos presets da consulta; trocar fonte limpa o resultado (anti-stale). O contador Full/Semi do resultado segue a fonte ativa; Resumo Geral/histórico seguem na fonte recrutada.
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

#### Planner de OP em Massa (v0.33 — quartel-general fluido; escala real; alinhado à ferramenta real twmassplanner.pro)
- **v0.33.0 MEGA ATUALIZAÇÃO** (decisões do dono: MPs direto da OP · filtro `;` com fold · tela cheia · cobrança com envio):
  - **Comunicação da OP** (`src/shared/op-comms.ts` + card no resultado do planner): os comandos da OP geram as MPs de CADA executor (alvos + horários DELE) com template/assunto editáveis e prévia do 1º destinatário; **envio DIRETO** via `sg6.sendMps` com confirmação dupla (pacing humano/journal do motor existente). Bloqueia envio se a OP estiver desatualizada (planStale). `renderTemplate`/envio substituem `#jogador#`/`#alvos#`/`#horarios#` — prévia e envio NUNCA divergem (P1 do reviewer corrigido em ambas as pontas).
  - **Seeds da biblioteca de templates** (instalados 1× se vazia): "⚔ Diretrizes de OP" (molde aprovado pelo dono) e "🔔 Cobrança de faltas".
  - **Mapa da OP** (`OpMapSection`, reuso do WorldMapCanvas): no planner com as TRAJETÓRIAS completas (origens em círculos verdes, alvos em branco, setas; zoom/pan; dump cacheado) e no monitoramento com os alvos da OP arquivada.
  - **Agenda da OP** (`OpAgendaSection`): o `sendSchedule` arquivado passa a ser LIDO — tabela buscável Jogador/Alvo/Enviar às + copiar TSV + **"Agendar no T-minus"** em 1 clique.
  - **Filtros de busca** (fold: acento/caixa) nas tabelas do monitoramento: situação por jogador, scorecard e pós-OP (`shared/war-view-filter.ts`).
  - **Cobrar faltas** no Painel de guerra: devedores (falta>0) viram MPs de cobrança (`#jogador#` `#faltam#` `#alvos#`) com prévia, edição e envio com confirmação dupla.
  - **SG_6**: botão "Converter agenda da OP colada" (`agendaToSg6Entries` — cola a agenda da Sala de Guerra/SG_4 e agrupa por jogador com horários).
  - **SG_2**: filtro de jogadores separado APENAS por `;` (nick com espaço/acento funciona) + quebra de linha; comparação IGNORA acento/caixa (`shared/names-filter.ts` + `fold.ts` fonte única usada também por sg5-view-filter/journal-filter); contagem viva com duplicatas ignoradas; prefs/presets pré-v0.33 migram sozinhos (`migrateLegacyNamesText`).
  - **Tela cheia**: `--content-max: none` (conteúdo/tabelas acompanham a janela maximizada — antes travavam em 1080px à esquerda), nos 2 temas.
  - **Sessão reorganizada** em 2 seções didáticas: "Sessão do jogo (Tribal Wars)" (estado + SID como alternativa) e "Conta do Staff Hub" — acabou a bagunça de cards soltos.
  - Componente `Callout` (fonte única do markup; classes visuais inalteradas) + ícones nos títulos dos cards da Sala de Guerra. QA visual: 8 capturas (4 páginas × 2 temas) no harness `tests/diag/cap-v033.mjs`.
- **v0.32.2 (hotfix urgente — OP de mundo inteiro)**: teto de pares 1M → **50 MILHÕES** (pedido do dono; a OP "Full - Br142" de 7005×1701 = 11,9M gera 7005 comandos em ~10s nos 3 modos). O cruzamento foi reescrito com **candidatos em ARRAYS TIPADOS paralelos** (Int32Array origem/alvo + Float64Array distância, ~16 bytes/par): como objetos seriam ~1 GB e derrubariam o renderer; geração com alvo no loop externo → pares de cada alvo CONTÍGUOS (slice por `targetOffset`), mesma ordem/empates do scan linear (suite de semântica byte-fiél verde sem edição). Otimizado ordena array de índices (sort iterativo do V8). Avisos escalonados: pesada >100k · "mundo inteiro" >5M ("dezenas de segundos a alguns minutos"); toast "Gerando… não feche o app" antes do trabalho pesado. **Custo no CAP de 50M, modo Otimizado (medida v0.32.3)**: ~800 MB de typed arrays (ArrayBuffer) + ~400-600 MB de heap JS (ordenação) e sort síncrono de 1-4 minutos — os modos por-alvo são bem mais leves (sem ordenação global e sem `candTarget`).
- **v0.32.1 (hotfix da revisão dupla)**: debounce do rascunho ganha FLUSH (fechar o app/F5 dentro dos 400ms não perde mais a última mutação — cleanup + beforeunload, disciplina do `usePreferences`); migração das prefs antigas limpa a origem com `savePrefsNow` (imediato) e TAMBÉM quando o store já está povoado (mata a ressurreição pós-"Limpar todos" em todas as janelas); **cotas com coordenada duplicada ENTRE grupos não desalinham mais** ("A; A B; C" com 5;1;9 aplicava [5,1,1] — cursor agora anda só nas coords únicas; duplicata entre grupos também é CONTADA no rótulo, sem descarte silencioso); `JsonStore.load` não sobrescreve cache após save concorrente (race latente); "Gerar Operação" dá 1 frame de yield antes do trabalho pesado (o spinner pinta ANTES do congelamento síncrono de ~2,5s); linha do grupo mostra **"N pares (OP pesada)"** em âmbar quando cruza 100k (o aviso deixou de ser só pós-geração); soak de 60s com a escala real no harness (`tests/diag/soak-planner.mjs`).
- **v0.32.0 ESCALA REAL** (correções do relato de 01/09 — OP "full" de 2428 origens × 183 alvos):
  - **Teto de pares 250k → 1.000.000**: a OP real da staff (444k pares) era RECUSADA com "acima do teto"; agora gera (~2,5s). Acima de 100k pares a engine emite o aviso "OP pesada" para a espera não parecer travamento.
  - **Rascunho em store DEDICADO `planner-draft`** (`src/main/ipc-planner-draft.ts`, JsonStore próprio com teto de 2 MB): o rascunho real passa de 97k — 5× o cap de 20k por string das prefs — e era DESCARTADO ("vive só nesta sessão", perdia ao fechar). Migração automática: prefs antigas (≤19k) sobem para o store na 1ª abertura e a origem é apagada (sem "grupo fantasma" após "Limpar todos"). Gravação com debounce de 400ms; aviso em tela SÓ em falha real de disco. Canal PROTEGIDO pelo gate central (dado de produto da Sala de Guerra).
  - **Exportações imunes a bloco gigante**: `Math.min(...rows)` com spread estourava a call stack em blocos >65k linhas (RangeError: Maximum call stack size exceeded); a chegada mínima do bloco passou a ser pré-computada com mínimo iterativo.
  - **Perf dos modos por-alvo**: candidatos indexados POR ALVO (por-jogador / mais-perto / mais-longe deixaram de varrer o conjunto inteiro a cada slot — resultado idêntico, escala linear).
  - **ErrorBoundary com stack visível**: "Detalhes técnicos" (stack do erro + pilha de componentes, truncados) em `<details>` — o crash da staff chegava SEM NENHUMA pista de origem.
  - **E2E de captura na escala real** (`tests/diag/cap-planner-stress.mjs`): API auth LOCAL (DB tmp) + login persistido no userData isolado + rascunho 2428×183 hidratado do disco → captura da Sala de Guerra sem crash (prova da montagem). `SHS_CAPTURE_DELAY` permite esperar hidratações IPC antes da foto.
- **v0.29.0 ALINHAMENTO TOTAL à ferramenta real** (semânticas PROVADAS por gerações reais com a chave do dono; ZIPs de prova em tests/diag/twmp/):
  - **Comandos por Origem/Alvo = listas por grupo** "1;2" (textareas divididas por ";"; um valor só aplica a todos; erros reais reproduzidos: "O número de separadores (;) é diferente" / "Valor de comando inválido."); totais vivos "até N comandos" por lado.
  - **Chegadas**: Fixa / **Intervalo = início e fim** (2 datetimes) / **Fixa com intervalo por aldeia = Delay entre ataques (s)** — stagger SEQUENCIAL na ordem de distância (o mais perto fica na base; prova real com 30s).
  - **Modos de cálculo**: Otimizado (guloso global, aproximação do matching do tool real) / **Distribuído por players** (justo entre jogadores de origem — heurística determinística documentada) / Mais perto / Mais longe (extra nosso; o tool real não tem).
  - **Exportações BYTE-FIÉIS ao tool real**: Russian Planner e TW Mass Planner agora são o BBCode do CADERNO PREMIUM — blocos por jogador de origem ("Mass plan for [player]NICK[/player]"), horários em milissegundos "HH:MM:SS:mmm dd.mm.aaaa", dono do alvo, recap "targets" por modelo e LINK DA PRAÇA com o ID da vila de ORIGEM do dump (TWMP acrescenta Time arrival + Attack building, default farm). Testes comparam byte-a-byte com os arquivos capturados. O formato colável do app (T-minus/conferência) segue como terceira saída.
  - IPC/ctx: villageIdByCoord (dump village.txt) alimenta os links; comandos carregam IDs de origem/alvo.
  - Rascunhos da v0.28 migram sozinhos (modo fixa-por-aldeia→sequencial; perVillageSeconds→delay; cotas ausentes=1).
  - QA: gancho SHS_CAPTURE com 3 tentativas + diagnóstico .err (UnknownVizError do compositor é intermitente).
- **v0.28.0 (base)**: conceito de GRUPOS (fake/nuke/nobre) com 17 campos da spec, cruzamento com capacidades, torre de vigia ponto→segmento (raio 15), moral por pontos, proteção de bônus noturno, conflito de ms por jogador, abas Planner×Monitoramento, rascunho persistente no módulo "guerra", solver noturno por bisseção.

### Sistema — Login e proteção de acesso (v0.30.0)
- **API `staffhub-auth` na VPS** (`vps/staffhub-auth/`, deploy por `scripts/deploy-auth.mjs` — chave SSH root existente): Node puro + `node:sqlite` (WAL) na 8787 atrás do nginx **:443 com cert self-signed PINADO no app** (`src/main/auth-ca.ts`; sem o pin o TLS recusa). Contas: register→pending→admin aprova; scrypt+timingSafeEqual; JWT HS256 15min + refresh rotativo 30d (reuso mata a família); **1 sessão ativa** (login novo expulsa o antigo); rate-limit por IP/nick; auditoria com IP+versão do app; `/healthz`; backup diário cron (`/var/backups/staffhub-auth`); seed admin por `deploy-auth.mjs --reset-admin <nick>`.
- **`AuthService` (main)**: único dono dos tokens; refresh em `safeStorage` (DPAPI); **modo guerra 72h** (falha de rede mantém a sessão usável; 401 encerra; recuo de relógio detectado por `maxClockSeen`); renovação silenciosa a cada 10min; eventos `auth:changed`.
- **Gate central de produto**: wrapper do `ipcMain.handle` com lista de canais protegidos (jogo/coleta/mutação/arquivo/t-minus/sessão do jogo/capturas) — sem sessão válida, resposta PT-BR "faça login". Updater/journal/prefs/settings LIVRES (banido ainda atualiza).
- **UI**: `LoginPage` (login/criar conta/aguardando aprovação; erros específicos pending/banido/rate; aria) trava o app no `App.tsx`; banner de offline-72h; `AdminPage` (aprovar/banir/reabilitar/resetar senha com temporária + auditoria) para role admin; "Sair da conta" na Sessão e na paleta Ctrl+K; conta do Staff Hub + trocar senha na página Sessão.
- **Proteção contra cópia (defesa em profundidade, honesta)**: sem conta aprovada o app não abre nada (gate no main, não só na tela); banimento a distância mata sessões; `app.asar` (o @electron/packager JÁ entrega por padrão — NUNCA reempacotar manualmente: sobrescreve por asar vazio, incidente pego no E2E); código minificado. Sem ofuscação pesada/anti-debug (quebra QA/updater — decisão documentada).

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
