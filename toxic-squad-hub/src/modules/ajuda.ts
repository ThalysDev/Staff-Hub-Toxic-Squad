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
    font-family: var(--shs-font-display, Georgia, serif); font-size: 16px; font-weight: 700;
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
  item(agendador.body, 'Deixe a **Praça da aldeia de origem aberta** na hora do envio. Com um comando chegando em até 2 minutos, o escudo flutuante **pulsa** — não feche a aba.');
  item(agendador.body, '**Fakes e rotinas são humanizados**: intervalos, variação e pausas configuráveis para não parecer robô.');
  item(agendador.body, 'A **Sequência de Nobres (2-5)** monta o trem com gap calibrado; o **Cancelamento Cronometrado** cancela de 1 a 20 comandos no alvo na hora marcada.');
  item(agendador.body, 'O **Mapa de Operações** filtra, detecta conflitos de milissegundos e edita horários em massa.');
  grid.appendChild(agendador.box);

  const apoios = card('Distribuidor de Apoios', 'shieldCheck');
  item(apoios.body, 'Na aba **Apoio em massa** do jogo: totais da conta, origens por grupo e a lista de apoios em formato de texto.');
  item(apoios.body, 'Uma data = chegada cravada; **i** + data + data-alvo = janela (chega depois de X, até Y).');
  item(apoios.body, 'O botão **Avançado** controla a distribuição: mínimo/máximo/pacotes por aldeia, mais perto/mais longe, tropas reservadas e conflitos de ms.');
  grid.appendChild(apoios.box);

  const sentinela = card('Modo Sentinela', 'eye');
  item(sentinela.body, 'O botão da Sentinela abre **uma aba de fundo do jogo** que mantém as automações ciclando enquanto você faz outra coisa.');
  item(sentinela.body, 'O cadeado por mundo impede duas abas de agirem juntas — a Sentinela e a aba normal se alternam sem duplicar.');
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
