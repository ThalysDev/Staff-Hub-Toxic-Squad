// Entrada do Staff Hub In-Game: licença → shell → seções registradas.

import './modules/mail'; // seção "MPs (pré-preencher)" — autorregistro no shell (global; fill em screen=mail)
import './modules/planner'; // seção "Planner de OP" — autorregistro no shell (global)
import './modules/sg5'; // SG_5: seção "Conferência" (info_village) — autorregistro no shell
import './modules/sg23'; // SG_2/SG_3: seção "Tropas & Defesa" — autorregistro no shell (global)
import './modules/sg7'; // SG_7: seção "Blindagem" (forum) — autorregistro via renderSg7 abaixo
import './modules/oda'; // ODA/ODD: seção "OD de guerra" — autorregistro via renderOda abaixo
import './modules/sg6'; // SG_6: seção "Reservas & MPs" (mutações) — autorregistro via renderSg6 abaixo

import { gate, licenseState, activate, logout, type LicenseState } from './core/license';
import { ensureHost, mountShell, registerSection } from './core/shell';
import { gameContext } from './core/shell';
import { card, cardTitle, iconButton, spinner } from './core/ui';
import { icon } from './core/icons';
import { renderSg7 } from './modules/sg7';
import { renderOda } from './modules/oda';
import { renderSg6 } from './modules/sg6';

/** Diálogo de ativação (renderiza dentro do host até a licença validar). */
function renderActivation(onActivate: () => void): void {
  const shadow = ensureHost();
  const box = document.createElement('div');
  box.className = 'shs-panel shs-activate';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Staff Hub In-Game — ativação da licença');
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
  brandName.textContent = 'Staff Hub In-Game';
  const brandSub = document.createElement('span');
  brandSub.textContent = 'Toxic Squad · acesso da liderança';
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

function main(): void {
  // Registro das seções ANTES do gate (P2-1 revisão pré-teste): após a 1ª
  // ativação o painel já nasce com as 7 abas, sem recarregar a página.
  registerSection({ id: 'sg7', label: 'Blindagem', icon: 'shieldCheck', matchScreen: 'forum', render: renderSg7 });
  registerSection({ id: 'oda', label: 'OD de guerra', icon: 'chart', render: renderOda });
  registerSection({ id: 'sg6', label: 'Reservas & MPs', icon: 'calendar', render: renderSg6 });

  const state: LicenseState = gate();
  if (state.kind === 'ausente') {
    renderActivation(() => {
      mountShell();
    });
    return;
  }

  mountShell();
  void logout;
  void licenseState;
}

void main();
