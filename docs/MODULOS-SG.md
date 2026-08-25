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
