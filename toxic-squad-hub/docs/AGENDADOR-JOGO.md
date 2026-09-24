# Agendador × jogo — endpoints e estruturas (BR142)

Levantamento feito em **24/09/2026** na conta do dono (sessão logada, só
leituras GET — nenhum comando enviado). Serve de referência para o Agendador
de Comandos e o envio em segundo plano (v3.3.0). Se o jogo mudar, os parsers
falham fechado e esta tabela é o primeiro lugar a conferir.

## Endpoints usados pelo Agendador

| Para quê | Endpoint | Resposta (BR142) | Onde no script |
|---|---|---|---|
| Formulário da Praça (tropas, alvo, Ataque/Apoio) | `GET /game.php?village=<id>&screen=place` | 200, ~85 KB, ~200 ms | motor (`command-scheduler.ts`), quadro do 2º plano (`tsh-envio-quadro.ts`), modelos (`tsh-templates.ts`) |
| Confirmação do comando (passo 1 → 2) | `POST /game.php?village=<id>&screen=place&try=confirm` (form `#command-data-form`) | tela de confirmação com `form#command-data-form[action*="action=command"]` | `tsh-transport.ts` (`prearmCommandStep1`, `clickCommandConfirmNow`) |
| Modelos de tropas (tela própria) | `GET /game.php?village=<id>&screen=place&mode=templates` | 200, ~77 KB | — (os modelos já vêm na Praça) |
| Conferir chegada / cancelar | `GET /game.php?village=<id>&screen=overview_villages&mode=commands&type=all&page=-1` | 200, `#commands_table tr.nowrap` (858 comandos na conta) | conferência de chegada e cancelamento cronometrado |
| Detalhe de um comando | `GET /game.php?village=<id>&screen=info_command&ajax=details&id=<cmd>` | JSON | cancelamento |
| Configuração do mundo | `GET /interface.php?func=get_config` | `speed 1.5`, `unit_speed 0.75`, `commands/millis_arrival 1`, `command_cancel_time 600`, `fake_limit 2`, `night active 1 · 23h–7h`, `archer 1`, `knight 3` | velocidades, fakes, **bônus noturno** |
| Velocidade das unidades | `GET /interface.php?func=get_unit_info` | min/campo: lança 16 · espada 19,56 · bárbaro 16 · arqueiro 16 · explorador 8 · leve 8,89 · arq. cavalo 8,89 · pesada 9,78 · aríete/catapulta 26,67 · paladino 8,89 · nobre 31,11 | cálculo chegada ↔ envio |
| Aldeias do mapa | `GET /map/village.txt` | 274 mil linhas, **~1,3 s** (cachear!) | nome/pontos do alvo, suas aldeias |
| Grupos | `GET /game.php?village=<id>&screen=groups&mode=overview&ajax=load_group_menu` | JSON `{result:[…]}` | agendamento em bloco |

## Praça (`screen=place`) — o que o script lê

- `#command-data-form` com `action="/game.php?village=<id>&screen=place&try=confirm"`.
- Tropas: `input.unitsInput#unit_input_<unit>[name=<unit>][data-all-count=<disponível>]`
  (12 unidades: spear, sword, axe, archer, spy, light, marcher, heavy, ram,
  catapult, knight, snob). **`data-all-count` é o total disponível** — é o que o
  "Todas" e o modo percentual usam no disparo.
- Link "(200)" de cada tropa: `a.units-entry-all#units_entry_all_<unit>` (reserva).
- Alvo: `input#inputx[name=x]`, `input#inputy[name=y]`, `input[name=input]` (autocomplete).
- Botões: `#target_attack[name=attack]`, `#target_support[name=support]`.
- Campo oculto de proteção (nome aleatório por sessão, ex. `f572c8b6ba3f0e90379a26`),
  `template_id`, `source_village` — o formulário real é submetido como está.
- **Modelos de tropas**: `<script>` com `TroopTemplates.current = {…};`
  - cada modelo: `id`, `name`, quantidades **em texto** (`"spy":"1"`), `use_all` (unidades que vão todas);
  - do jogo: `all` ("Todas as tropas"), `fake` ("Fake": 26 catapultas + 1 explorador), `snob` ("Nobre": 1 nobre + todas bárbaro/leve/arq. cavalo);
  - do jogador (ex.: "1 Explorador", "fake 2", "FULL ATK", "nobre padrao").

## Envio em segundo plano (v3.3.0)

- `game.php` responde com `X-Frame-Options: NONE` → a Praça pode abrir num
  iframe da mesma origem. Verificado: carrega em ~700 ms, `contentDocument`
  acessível, `window.name` preservado ao navegar para `try=confirm`.
- Nada de captcha/evasão: se o desafio anti-bot aparecer no quadro, o
  disjuntor pausa tudo e o jogador resolve numa aba normal.
