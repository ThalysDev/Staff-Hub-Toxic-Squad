// Entrada do Toxic Squad Hub (jogo INDIVIDUAL do jogador): licença → shell →
// Suite Vanta (base TW Vanta corrigida) + funcionalidades da extensão TSH.
// Os módulos de gestão de tribo (SG_5/2/3/6/7, Planner de OP, OD, MPs) vivem
// no Staff Hub In-Game (../userscript) — produto separado da liderança.

import { gate, licenseState, activate, logout, type LicenseState } from './core/license';
import { ensureHost, gameContext, mountShell, registerSection, registerSearchEntries, setFabAlert } from './core/shell';
import { card, cardTitle, iconButton, spinner } from './core/ui';
import { icon } from './core/icons';
import { renderVantaSuite, runVantaOnLoad } from './modules/vanta';
import { vantaLaunchers } from './modules/vanta/vanta-registry';
import { renderTshPanel, startTshHeartbeat } from './modules/tsh';
import { isTshEnabled, tshAutomations } from './modules/tsh/tsh-runtime';
import { revealTshAutomation } from './modules/tsh/tsh-panel';
import {
  isSentinelaTab,
  mountSentinelaLauncher,
  startSentinelaBadge,
} from './modules/tsh/tsh-sentinela';
import { nextScheduled, renderHome } from './modules/home';
import { currentWorld } from './core/page';
import { serverNowMs } from './core/game-clock';
import { clockLabelMs } from './ext/core/timing/precise-fire';
import { renderAjuda } from './modules/ajuda';
import { createModuleScope } from './modules/vanta/vanta-lifecycle';

/** Diálogo de ativação (renderiza dentro do host até a licença validar). */
function renderActivation(onActivate: () => void): void {
  const shadow = ensureHost();
  const box = document.createElement('div');
  box.className = 'shs-panel shs-activate';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Toxic Squad Hub — ativação da licença');
  box.style.display = 'flex';
  const ctx = gameContext();
  const contaOk = ctx.player !== '' && ctx.player !== '—';

  // Cabeçalho com brasão.
  const brand = document.createElement('div');
  brand.className = 'shs-head shs-brand';
  const brandBadge = document.createElement('span');
  brandBadge.className = 'shs-brand-badge';
  brandBadge.appendChild(icon('shield', 24));
  const brandTxt = document.createElement('span');
  brandTxt.className = 'shs-brand-txt';
  const brandName = document.createElement('strong');
  brandName.textContent = 'Toxic Squad Hub';
  const brandSub = document.createElement('span');
  brandSub.textContent = 'Toxic Squad · automação para o seu jogo';
  brandTxt.append(brandName, brandSub);
  brand.append(brandBadge, brandTxt);
  box.appendChild(brand);

  // Corpo.
  const inner = document.createElement('div');
  inner.style.padding = '14px 16px';
  const cardEl = card(cardTitle('key', 'Ativação da licença'));

  // Contexto: conta detectada no jogo (a chave vai se vincular a ela).
  const contexto = document.createElement('div');
  contexto.className = 'shs-row';
  if (contaOk) {
    const pill = document.createElement('span');
    pill.className = 'shs-pill shs-pill--ok';
    pill.setAttribute('data-tip', 'A chave ficará vinculada a esta conta do jogo.');
    pill.appendChild(icon('user', 11));
    pill.appendChild(document.createTextNode(`Ativando para: ${ctx.player}`));
    contexto.appendChild(pill);
  } else {
    const warn = document.createElement('div');
    warn.className = 'shs-warnbox';
    warn.appendChild(icon('alert', 13));
    warn.appendChild(
      document.createTextNode('Não consegui identificar sua conta do jogo — recarregue a página e tente de novo.'),
    );
    contexto.appendChild(warn);
  }
  cardEl.appendChild(contexto);

  // Campo da chave + colar.
  const field = document.createElement('div');
  field.className = 'shs-field';
  const label = document.createElement('label');
  label.className = 'shs-field-label';
  label.htmlFor = 'shs-key';
  label.textContent = 'Chave de ativação';
  const row = document.createElement('div');
  row.className = 'shs-row';
  const input = document.createElement('input');
  input.className = 'shs-input shs-input--key';
  input.id = 'shs-key';
  input.placeholder = 'SHS-XXXX-XXXX-XXXX';
  input.autocomplete = 'off';
  input.setAttribute('spellcheck', 'false');
  const colar = iconButton('Colar', 'copy', { variant: 'ghost', tip: 'Colar da área de transferência', small: true });
  row.append(input, colar);
  field.append(label, row);
  cardEl.appendChild(field);

  // Ação + mensagem.
  const acoes = document.createElement('div');
  acoes.className = 'shs-row';
  const button = iconButton('Ativar licença', 'key', {});
  button.id = 'shs-ativar';
  // Guarda da re-entrância do Enter (veja ativar()).
  let ativando = false;
  const message = document.createElement('div');
  message.className = 'shs-muted';
  message.id = 'shs-ativar-msg';
  acoes.append(button, message);
  cardEl.appendChild(acoes);

  // Rodapé orientativo.
  const foot = document.createElement('div');
  foot.className = 'shs-activate-foot';
  foot.appendChild(icon('info', 13));
  foot.appendChild(
    document.createTextNode(
      'Sem chave? Peça ao líder no painel Staff Hub (Admin → Chaves In-Game). A chave é pessoal — fica vinculada à sua conta do jogo.',
    ),
  );
  cardEl.appendChild(foot);

  inner.appendChild(cardEl);
  box.appendChild(inner);
  shadow.appendChild(box);

  async function ativar(): Promise<void> {
    // Guarda de re-entrância (P2 da revisão): Enter repetido durante o POST
    // disparava uma 2ª chamada de activate (risco de 429 confuso no fluxo).
    if (ativando || button.disabled) return;
    const code = input.value.trim();
    if (code === '') {
      message.textContent = 'Informe a chave.';
      input.focus();
      return;
    }
    if (!contaOk) {
      message.textContent = 'Conta do jogo não identificada — recarregue a página.';
      return;
    }
    ativando = true;
    button.disabled = true;
    colar.disabled = true;
    button.replaceChildren(spinner(), document.createTextNode('Ativando…'));
    message.textContent = '';
    try {
      await activate(code, ctx.player);
      box.remove();
      onActivate();
    } catch (error: unknown) {
      button.disabled = false;
      colar.disabled = false;
      button.replaceChildren(icon('key'), document.createTextNode('Ativar licença'));
      const texto = error instanceof Error ? error.message : String(error);
      message.textContent = '';
      const warn = document.createElement('div');
      warn.className = 'shs-warnbox';
      warn.appendChild(icon('alert', 13));
      warn.appendChild(document.createTextNode(texto));
      message.appendChild(warn);
      input.focus();
      input.select();
    } finally {
      ativando = false;
    }
  }

  button.addEventListener('click', () => {
    void ativar();
  });
  colar.addEventListener('click', () => {
    if (navigator.clipboard === undefined) {
      message.textContent = 'Área de transferência indisponível neste navegador — cole manualmente.';
      return;
    }
    navigator.clipboard
      .readText()
      .then((texto) => {
        const limpo = texto.trim();
        if (limpo !== '') {
          input.value = limpo;
          input.focus();
        }
      })
      .catch(() => {
        message.textContent = 'Não consegui ler a área de transferência — cole manualmente.';
      });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void ativar();
    }
  });
  input.focus();
}

/**
 * Onda C — aviso de cravado: com um comando agendado nos próximos 2 min, o
 * escudo flutuante pulsa e o tooltip mostra o horário (quem está com o
 * painel fechado sabe que NÃO deve fechar a aba agora).
 */
function startAimWatcher(): void {
  window.setInterval(() => {
    // Agendador desligado não envia nada — sem alerta enganoso.
    if (!isTshEnabled('command-scheduler')) {
      setFabAlert(null);
      return;
    }
    const { nextAt } = nextScheduled(currentWorld());
    if (nextAt === null) {
      setFabAlert(null);
      return;
    }
    const falta = nextAt - serverNowMs();
    if (falta > 0 && falta <= 120_000) {
      setFabAlert(`Comando agendado às ${clockLabelMs(nextAt)} — mantenha esta aba aberta`);
    } else {
      setFabAlert(null);
    }
  }, 1_000);
}

function main(): void {
  // Aba Sentinela (Onda 5): aba de fundo do jogo — sem shell/painel (não há UI
  // a montar fora da aba do jogador), só o heartbeat normal + o badge do
  // título com a contagem de automações ativas. O registro das seções nem roda.
  if (isSentinelaTab()) {
    startSentinelaBadge(createModuleScope('tsh-sentinela'));
    startTshHeartbeat(createModuleScope('tsh-heartbeat'));
    return;
  }

  // Registro das seções ANTES do gate: após a 1ª ativação o painel já nasce
  // completo, sem recarregar a página. "Início" é a entrada padrão (1ª).
  registerSection({ id: 'inicio', label: 'Início', icon: 'home', render: renderHome });
  registerSection({ id: 'vanta', label: 'Suite Vanta', icon: 'sword', render: renderVantaSuite });
  registerSection({ id: 'tsh', label: 'Automações', icon: 'zap', render: renderTshPanel });
  registerSection({ id: 'ajuda', label: 'Ajuda & Sobre', icon: 'info', render: renderAjuda });

  // Busca rápida (Onda 6): seções + ferramentas Vanta + automações TSH.
  registerSearchEntries([
    { id: 'sec:inicio', label: 'Início', hint: 'Painel', sectionId: 'inicio', icon: 'home' },
    { id: 'sec:vanta', label: 'Suite Vanta', hint: 'Painel', sectionId: 'vanta', icon: 'sword' },
    { id: 'sec:tsh', label: 'Automações', hint: 'Painel', sectionId: 'tsh', icon: 'zap' },
    { id: 'sec:ajuda', label: 'Ajuda & Sobre', hint: 'Painel', sectionId: 'ajuda', icon: 'info' },
  ]);
  registerSearchEntries(
    vantaLaunchers().map((launcher) => ({
      id: `vanta:${launcher.id}`,
      label: launcher.label,
      hint: 'Suite Vanta',
      sectionId: 'vanta',
      icon: launcher.icon ?? 'sword',
      keywords: launcher.desc,
      targetId: `vanta:${launcher.id}`,
    })),
  );
  registerSearchEntries(
    tshAutomations().map((automation) => ({
      id: `tsh:${automation.id}`,
      label: automation.label,
      hint: 'Automações',
      sectionId: 'tsh',
      icon: 'zap' as const,
      keywords: automation.desc,
      targetId: `tsh:${automation.id}`,
      beforeNavigate: () => revealTshAutomation(automation.id),
    })),
  );

  const state: LicenseState = gate();
  if (state.kind === 'ausente') {
    renderActivation(() => {
      mountShell();
      runVantaOnLoad();
      startTshHeartbeat(createModuleScope('tsh-heartbeat'));
      mountSentinelaLauncher();
      startAimWatcher();
    });
    return;
  }

  mountShell();
  runVantaOnLoad();
  startTshHeartbeat(createModuleScope('tsh-heartbeat'));
  mountSentinelaLauncher();
  startAimWatcher();
  void logout;
  void licenseState;
}

void main();
