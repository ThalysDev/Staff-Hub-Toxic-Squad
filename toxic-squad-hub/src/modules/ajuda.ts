// Seção "Ajuda & Sobre" (Onda 6): guia rápido de uso por área, glossário
// mínimo (cravado × humanizado, ARMAR, Sentinela) e créditos — reduz o apoio
// reativo via WhatsApp com as dúvidas previsíveis.

import { icon, type IconName } from '../core/icons';
import { SUPPORT_PHONE } from './home';

const AJUDA_STYLE_ID = 'tsh-ajuda-styles';
const AJUDA_CSS = `
  .ajuda-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .ajuda-card { background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0); border-radius: 10px; padding: 14px 16px; }
  .ajuda-card--full { grid-column: 1 / -1; }
  .ajuda-title { display: flex; align-items: center; gap: 7px; margin: 0 0 10px;
    font-family: var(--shs-font); font-size: 15px; font-weight: 600;
    color: var(--shs-ink-strong, #3c250a); }
  .ajuda-item { padding: 6px 0; border-bottom: 1px dashed var(--shs-border, #e0cda0); font-size: 12.5px; color: var(--shs-ink, #5a3a16); line-height: 1.55; }
  .ajuda-item:last-child { border-bottom: none; }
  .ajuda-item strong { color: var(--shs-ink-strong, #3c250a); }
  .ajuda-kbd { font-family: monospace; font-size: 11px; background: var(--shs-bg-inset, #f4ead0);
    border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 4px; padding: 1px 5px; }
`;

function ensureAjudaStyles(container: HTMLElement): void {
  const root = container.getRootNode() as ShadowRoot | Document;
  if (root instanceof ShadowRoot && root.getElementById?.(AJUDA_STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = AJUDA_STYLE_ID;
    style.textContent = AJUDA_CSS;
    root.appendChild(style);
  }
}

function card(titulo: string, iconName: IconName, full = false): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = document.createElement('div');
  box.className = full ? 'ajuda-card ajuda-card--full' : 'ajuda-card';
  const head = document.createElement('h3');
  head.className = 'ajuda-title';
  head.appendChild(icon(iconName, 15));
  head.appendChild(document.createTextNode(titulo));
  const body = document.createElement('div');
  box.append(head, body);
  return { box, body };
}

function item(body: HTMLDivElement, texto: string): void {
  const row = document.createElement('div');
  row.className = 'ajuda-item';
  // Texto com marcação leve: **negrito** vira <strong> (construído, não innerHTML).
  const parts = texto.split(/\*\*/);
  parts.forEach((part, index) => {
    if (part === '') return;
    if (index % 2 === 1) {
      const strong = document.createElement('strong');
      strong.textContent = part;
      row.appendChild(strong);
    } else {
      row.appendChild(document.createTextNode(part));
    }
  });
  body.appendChild(row);
}

/** Seção "Ajuda & Sobre" — registrada em main.ts. */
export function renderAjuda(container: HTMLElement): void {
  ensureAjudaStyles(container);
  container.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'ajuda-grid';

  const comecando = card('Começando', 'play');
  item(comecando.body, '**Abra o painel** pelo escudo flutuante. A busca rápida atende **Ctrl+K** — ache qualquer ferramenta pelo nome.');
  item(comecando.body, '**Tudo nasce desligado.** Cada automação precisa ser ativada no switch; as que agem no jogo ainda pedem **Armar** (autorização de 30 minutos) — o **Agendador de Comandos** é exceção: agendar já é a autorização.');
  item(comecando.body, 'O intervalo entre ciclos, a janela de horário e a **parada programada** ficam no botão Configurar de cada automação.');
  item(comecando.body, 'Atalhos: **Ctrl+K** busca (↑/↓ e Enter escolhem), **Esc** fecha diálogos e o painel. O painel lembra se estava aberto e em qual aba você parou.');
  grid.appendChild(comecando.box);

  const agendador = card('Central de Agendamentos', 'clock');
  item(agendador.body, '**Cravado = precisão máxima.** Comandos agendados (ataques de OP, nobres, snipes, cancelamentos) saem no milissegundo planejado — nada os atrasa.');
  item(agendador.body, '**Como ele crava:** alguns segundos antes (a "antecipação do pré-arme", padrão 8s) o script abre a tela de confirmação na Praça; o clique final sai no **ms exato**, já descontando o tempo de resposta da sua internet. Se a confirmação atrasar além da tolerância, o comando **não sai atrasado** — fica marcado como falhou, com o motivo.');
  item(agendador.body, '**Relógio:** a tela Comandos mostra a hora do servidor com milissegundos e a precisão medida (ex.: ±20 ms). "Calibrar relógio" mede de novo. Digite os horários na **Hora do servidor** (padrão) ou mude para a hora do seu computador.');
  item(agendador.body, '**Envio em segundo plano.** Basta deixar uma aba do jogo aberta, em qualquer tela: **2 min antes** ela abre a Praça da aldeia de origem num quadro invisível e o comando sai de lá, no ms — sua tela não muda. Cada origem ganha o próprio quadro, então várias origens podem sair no mesmo minuto.');
  item(agendador.body, '**Plano B.** Se o envio em segundo plano falhar (ou estiver desligado), a aba vai sozinha até a Praça 60 s antes, envia e volta — com faixa de aviso, "Ir agora" e "Não levar esta aba". Aba em uso (texto sendo escrito, comando sendo montado) nunca é levada.');
  item(agendador.body, '**O computador precisa estar ligado e acordado**, com o navegador aberto. Se ele dormir, nada sai — e o comando mostra o motivo no histórico.');
  item(agendador.body, '**OP com várias origens:** o envio em segundo plano atende todas ao mesmo tempo. Só o plano B (levar a aba) é limitado a **uma origem por vez**, com 30 s entre os envios — a seção Comandos marca em cada comando quem vai enviá-lo.');
  item(agendador.body, '**Tropas:** digite as quantidades ou marque **"Todas"** embaixo de cada tropa — sai tudo o que houver dela na aldeia na hora do envio (lido na Praça). Os **seus modelos de tropas do jogo** ("FULL ATK", "Nobre"…) aparecem acima da grade: 1 clique preenche. Comando por **chegada** com uma tropa em "Todas" que zerou não sai (a chegada mudaria) — o motivo fica no histórico.');
  item(agendador.body, '**Central de comandos em abas:** **Fila** (busca, filtro por tipo, pausar/cancelar em lote, exportar/importar), **Novo comando**, **Em bloco**, **Mapa** e **Histórico** (precisão de cada envio e o motivo das falhas).');
  item(agendador.body, '**"Todas" sem a tropa na hora:** com "Enviar às" o comando sai sem ela (e avisa se a chegada mudou); com "Chegar às" ele não sai se ela era a mais lenta. "Todas" não vale no modo Percentual nem no trem de nobres.');
  item(agendador.body, '**Agendar é confirmado:** antes de criar, uma janela mostra exatamente o que vai sair (tropas, alvo, envio e chegada). Depois, o resultado aparece ao lado do botão, com **Desfazer**.');
  item(agendador.body, '**Na Fila:** **Editar** abre o comando no formulário e **Salvar alterações** substitui o original; **Mudar horário** ajusta só a hora (pela chegada, se o comando foi criado assim); **Duplicar** e **Usar de novo** criam um comando NOVO; **Cancelar envio** deixa o registro no histórico. Comando já na mira (pré-armado) não se altera — cancele e crie outro.');
  item(agendador.body, '**Detalhes** em cada comando mostra a linha do tempo: pré-arme, envio, e quando a Praça invisível abriu e fechou. Na precisão, o clique sai alguns ms ANTES de propósito (compensa a sua latência) — o que vale é a **chegada conferida no jogo**.');
  item(agendador.body, '**Aba Sentinela aberta = envio mais seguro:** ela não navega, então é ela que abre a Praça invisível. Sem ela, a aba em que você joga hospeda — e se você trocar de página a menos de 45 s de um envio, o navegador pede confirmação.');
  item(agendador.body, '**Tropas no horário do envio:** embaixo de cada tropa, "no envio: N" mostra quantas devem estar em casa na hora — em casa agora + voltando (ataques, farm, apoios retirados, coleta) + recrutamento − outros comandos agendados da mesma aldeia. Se faltar, a confirmação avisa; quem decide é o jogo.');
  item(agendador.body, '**Automações respeitam os comandos agendados:** Coleta, Auto-farm, Cultivador, Demolidor e Apoio em massa não levam as tropas que um comando agendado da aldeia vai precisar (a Coleta calcula a volta e só reserva se ela chegaria depois). "Todas" reserva o tipo inteiro.');
  item(agendador.body, '**Sinal de Aflição (apoios):** informe a % do alvo, ou deixe 0. Com **Chegar às**, no pré-arme o script lê a duração real na confirmação; se a viagem ficou mais curta, calcula a aflição, **reagenda** para chegar na hora e lembra a % desse alvo (se ficou mais longa, não envia e diz o motivo). Com **Enviar às**, ele só corrige a chegada prevista.');
  item(agendador.body, '**O jogo decide:** o script só avisa sobre regras que podem mudar até a hora (tropas, tribo, limite de fakes, distância do nobre). Se o jogo recusar, a mensagem dele aparece como motivo no histórico. As regras vêm do próprio mundo (BR142, BR143, BR144…), nunca fixas.');
  item(agendador.body, '**Bônus noturno:** o resumo e o cartão na Fila avisam quando um ataque chega na janela do bônus noturno do mundo (defesa em dobro).');
  item(agendador.body, 'Com um comando chegando em até 2 minutos, o escudo flutuante **pulsa em dourado** e diz de qual aldeia ele sai — não feche a aba dessa aldeia. Escudo **vermelho** = script pausado (captcha ou sessão): nada sai até você retomar.');
  item(agendador.body, 'Da **mesma aldeia**, deixe pelo menos **5 s entre partidas** (cada envio abre a própria confirmação). Para nobres colados (100 ms), use o **Trem do jogo**.');
  item(agendador.body, '**Fakes e rotinas são humanizados**: intervalos, variação e pausas configuráveis para não parecer robô.');
  item(agendador.body, 'A **Sequência de Nobres (2-5)** monta o trem com gap calibrado; o **Cancelamento Cronometrado** cancela de 1 a 20 comandos no alvo na hora marcada.');
  item(agendador.body, 'O **Mapa de Operações** filtra, detecta conflitos de milissegundos e edita horários em massa.');
  grid.appendChild(agendador.box);

  const apoios = card('Distribuidor de Apoios', 'shieldCheck');
  item(apoios.body, 'Na aba **Apoio em massa** do jogo: totais da conta, origens por grupo e a lista de apoios em formato de texto.');
  item(apoios.body, 'Uma data = chegada cravada; **i** + data + data-alvo = janela (chega depois de X, até Y).');
  item(apoios.body, 'O botão **Avançado** controla a distribuição: mínimo/máximo/pacotes por aldeia, mais perto/mais longe, tropas reservadas e conflitos de ms.');
  grid.appendChild(apoios.box);

  const coleta = card('Coleta', 'layers');
  item(coleta.body, '**Roda em segundo plano, em todas as aldeias:** com o jogo aberto em qualquer tela, lê a Coleta em massa e envia até 50 grupos por vez. Sobrou aldeia? O próximo envio vem em 1 minuto, até passar por todas as páginas.');
  item(coleta.body, '**Equilibrada (padrão):** divide as tropas entre todos os níveis livres para voltarem juntas: mais recursos por hora. Também dá para usar **um nível só** ou um **lote fixo** por tropa.');
  item(coleta.body, '**Tempo-alvo:** diga em quantas horas a coleta deve voltar, separado para aldeias **ofensivas** e **defensivas**. Vai só a tropa necessária; o resto fica em casa. Sem limite = manda tudo.');
  item(coleta.body, '**Tropas:** desligue as que nunca coletam e diga quantas **ficam em casa**. As tropas de comandos do Agendador ficam em casa sozinhas até o comando sair.');
  item(coleta.body, '**Regras por grupo:** escolha o grupo pelo nome e como ele coleta (Equilibrada, um nível ou **Não coletar**), com tempo-alvo e tropas próprias. Aldeia em dois grupos segue o primeiro cartão.');
  item(coleta.body, '**Desbloquear níveis sozinho:** sem nada para coletar e com recursos, desbloqueia o próximo nível da aldeia (um por ciclo).');
  grid.appendChild(coleta.box);

  const sentinela = card('Modo Sentinela', 'eye');
  item(sentinela.body, 'O botão da Sentinela abre **uma aba de fundo do jogo** que mantém as automações ciclando enquanto você faz outra coisa.');
  item(sentinela.body, 'O cadeado impede duas abas de enviarem a mesma coisa: no **Agendador** ele vale **por aldeia** (uma aba por origem); nas outras automações vale por mundo, e a Sentinela e a aba normal se revezam sem duplicar.');
  item(sentinela.body, '**Captcha ou sessão expirada pausam tudo** (automações e pedidos ao jogo) no mundo afetado. Resolva no jogo e clique em **Já resolvi, retomar** (faixa vermelha acima do escudo ou aba Início).');
  grid.appendChild(sentinela.box);

  const seguranca = card('Uso consciente', 'alert');
  item(seguranca.body, 'Automação em jogo online tem risco de punição — os limites são seus. A **Humanização** (intervalos, variação, pausa, fake limit) existe para reduzir o padrão de robô, não para eliminá-lo.');
  item(seguranca.body, 'Mutação de jogo **nunca repete sozinha**: um envio incerto fica marcado, não reenviado.');
  item(seguranca.body, 'Nada vai para terceiros: notas, config e alertas são **locais**; não há telemetria. (A calibração do relógio só consulta o próprio servidor do jogo.)');
  grid.appendChild(seguranca.box);

  const sobre = card('Sobre', 'info', true);
  item(sobre.body, `**Toxic Squad Hub v${__SHS_VERSION__}** — suite de ferramentas para o jogo individual. Licença pessoal e intransferível.`);
  item(sobre.body, `Suporte: ${SUPPORT_PHONE} (WhatsApp). Bug, dúvida ou sugestão — chame.`);
  grid.appendChild(sobre.box);

  container.appendChild(grid);
}
