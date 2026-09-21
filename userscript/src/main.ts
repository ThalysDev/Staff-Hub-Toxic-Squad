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
import { renderSg7 } from './modules/sg7';
import { renderOda } from './modules/oda';
import { renderSg6 } from './modules/sg6';

/** Diálogo de ativação (renderiza dentro do host até a licença validar). */
function renderActivation(onActivate: () => void): void {
  const shadow = ensureHost();
  const box = document.createElement('div');
  box.className = 'shs-panel';
  box.style.display = 'flex';
  const ctx = gameContext();
  const strong = document.createElement('strong');
  strong.textContent = 'Staff Hub In-Game — ativação';
  const note = document.createElement('p');
  note.className = 'shs-muted';
  const notePre = document.createElement('span');
  notePre.textContent = 'Esta cópia precisa de uma chave emitida pelo líder (painel Staff Hub). A chave fica vinculada à sua conta do jogo (';
  const noteName = document.createElement('strong');
  noteName.textContent = ctx.player;
  noteName.id = 'shs-ativar-player';
  note.append(notePre, noteName, document.createTextNode(').'));
  const input = document.createElement('input');
  input.className = 'shs-input';
  input.id = 'shs-key';
  input.placeholder = 'Chave (ex.: SHS-XXXX-XXXX-XXXX)';
  const button = document.createElement('button');
  button.className = 'shs-btn';
  button.id = 'shs-ativar';
  button.textContent = 'Ativar';
  const message = document.createElement('span');
  message.className = 'shs-muted';
  message.id = 'shs-ativar-msg';
  const row = document.createElement('div');
  row.className = 'shs-row';
  row.append(button, message);
  const inner = document.createElement('div');
  inner.style.padding = '12px';
  inner.style.width = '100%';
  inner.append(strong, note, input, row);
  box.appendChild(inner);
  shadow.appendChild(box);
  button.addEventListener('click', () => {
    const code = input.value.trim();
    if (code === '') {
      message.textContent = 'Informe a chave.';
      return;
    }
    if (!ctx.player || ctx.player === '—') {
      message.textContent = 'Não consegui identificar sua conta do jogo — recarregue a página e tente de novo.';
      return;
    }
    button.disabled = true;
    message.textContent = 'Ativando…';
    activate(code, ctx.player)
      .then(() => {
        box.remove();
        onActivate();
      })
      .catch((error: unknown) => {
        button.disabled = false;
        message.textContent = error instanceof Error ? error.message : String(error);
      });
  });
}

function main(): void {
  // Registro das seções ANTES do gate (P2-1 revisão pré-teste): após a 1ª
  // ativação o painel já nasce com as 7 abas, sem recarregar a página.
  registerSection({ id: 'sg7', label: 'Blindagem', matchScreen: 'forum', render: renderSg7 });
  registerSection({ id: 'oda', label: 'OD de guerra', render: renderOda });
  registerSection({ id: 'sg6', label: 'Reservas & MPs', render: renderSg6 });

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
