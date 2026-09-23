// Etiquetador (port do TW Vanta, linhas 5909-6019): na tela
// overview_villages > incomings > attacks, detecta comandos ainda sem etiqueta
// (quickedit-label começando com "Ataque"/"Apoio") e dispara o select_all +
// "Etiqueta" nativo do jogo, recarregando a página no intervalo configurado.
// Correções embutidas:
// - P2: o ramo hasNew (original 5986-5994) clicava Etiqueta mas NÃO agendava
//   reload — se o jogo não recarregasse sozinho, o loop morria. Agora TODOS os
//   ramos agendam o reload via scope.after (60s após o clique, pois a página
//   pode recarregar antes e o timer morre com o dispose — aceitável).
// - Confirmação ao LIGAR o automático (automação assumida pelo dono; sem
//   confirmação por ciclo).
// - P1-4: listeners/timers/node via ModuleScope (nada solto acumulando).
// - ONDA 3: alarme sonoro local (4 sons) disparado conforme o gatilho
//   configurado (qualquer ataque / nobre+aríete / apenas nobre) quando o
//   etiquetador encontra novidades.

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { parsePtBrInt } from './vanta-utils';
import {
  ALARM_SOUND_LABELS,
  ALARM_TRIGGER_LABELS,
  normalizeAlarmConfig,
  playAlarm,
  testAlarm,
  type AlarmConfig,
} from './alarm-sound';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const INTERVAL_KEY = 'tsh-vanta:etiquetador:interval';
const ENABLED_KEY = 'tsh-vanta:etiquetador:enabled';
const ALARM_KEY = 'tsh-vanta:etiquetador:alarm';

function isEnabled(): boolean {
  return gm.get<boolean>(ENABLED_KEY, false);
}

function alarmConfig(): AlarmConfig {
  return normalizeAlarmConfig(gm.get<unknown>(ALARM_KEY, null));
}

function saveAlarmConfig(config: AlarmConfig): void {
  gm.set(ALARM_KEY, config);
}

registerVanta({
  id: 'vanta-etiquetador',
  label: 'Etiquetador',
  icon: 'bell',
  desc: 'Etiqueta ataques novos automaticamente e toca alarme',
  group: 'utilidades',
  match: () =>
    params().get('screen') === 'overview_villages' &&
    params().get('mode') === 'incomings' &&
    params().get('subtype') === 'attacks',
  url: () => '/game.php?screen=overview_villages&mode=incomings&type=unignored&subtype=attacks&page=-1',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-etiquetador-ui') !== null) return;

    const contentEl =
      document.getElementById('paged_view_content') ??
      document.querySelector('#incomings_table')?.parentElement ??
      document.getElementById('contentContainer');
    if (contentEl === null) return;

    const savedInterval = gm.get<number>(INTERVAL_KEY, 10);
    const savedEnabled = gm.get<boolean>(ENABLED_KEY, false);
    const alarm = alarmConfig();

    const container = document.createElement('div');
    container.id = 'vanta-etiquetador-ui';
    // Casca estática (sem dado dinâmico) — valores entram via .value abaixo.
    container.innerHTML = `
            <div id="vanta-etiquetador-header">
                <span id="vanta-etiquetador-header-title">Etiquetador</span>
            </div>
            <div id="vanta-etiquetador-body">
                <label>
                    Intervalo (minutos):
                    <input type="number" id="vanta-etiquetador-interval" min="1" max="60">
                </label>
                <label>
                    Ativar etiquetador automático:
                    <input type="checkbox" id="vanta-etiquetador-toggle" ${savedEnabled ? 'checked' : ''}>
                </label>
                <div id="vanta-etiquetador-alarm">
                    <label>
                        Alarme:
                        <select id="vanta-etiquetador-alarm-trigger"></select>
                    </label>
                    <label>
                        Som:
                        <select id="vanta-etiquetador-alarm-sound"></select>
                    </label>
                    <label>
                        Volume:
                        <input type="range" id="vanta-etiquetador-alarm-volume" min="0" max="100" step="5">
                    </label>
                    <button type="button" id="vanta-etiquetador-alarm-test">Testar som</button>
                </div>
                <div id="vanta-etiquetador-status"></div>
            </div>
        `;
    contentEl.insertBefore(container, contentEl.firstChild);
    scope.owns(container);

    const intervalInputEl = document.getElementById('vanta-etiquetador-interval');
    const toggleEl = document.getElementById('vanta-etiquetador-toggle');
    const statusEl = document.getElementById('vanta-etiquetador-status');
    const triggerEl = document.getElementById('vanta-etiquetador-alarm-trigger');
    const soundEl = document.getElementById('vanta-etiquetador-alarm-sound');
    const volumeEl = document.getElementById('vanta-etiquetador-alarm-volume');
    const testBtnEl = document.getElementById('vanta-etiquetador-alarm-test');
    if (
      !(intervalInputEl instanceof HTMLInputElement) ||
      !(toggleEl instanceof HTMLInputElement) ||
      statusEl === null ||
      !(triggerEl instanceof HTMLSelectElement) ||
      !(soundEl instanceof HTMLSelectElement) ||
      !(volumeEl instanceof HTMLInputElement) ||
      testBtnEl === null
    ) {
      return;
    }
    // Consts já estreitadas — o narrowing precisa valer dentro das closures.
    const intervalInput: HTMLInputElement = intervalInputEl;
    const toggle: HTMLInputElement = toggleEl;
    const status: HTMLElement = statusEl;
    const trigger: HTMLSelectElement = triggerEl;
    const sound: HTMLSelectElement = soundEl;
    const volume: HTMLInputElement = volumeEl;
    const testBtn: HTMLElement = testBtnEl;

    // Valor por propriedade (não por interpolação no innerHTML do casco).
    intervalInput.value = String(savedInterval);

    // Preenche os selects de alarme com os catálogos do módulo de som.
    for (const [value, label] of Object.entries(ALARM_TRIGGER_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === alarm.trigger;
      trigger.appendChild(option);
    }
    for (const [value, label] of Object.entries(ALARM_SOUND_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === alarm.sound;
      sound.appendChild(option);
    }
    volume.value = String(Math.round(alarm.volume * 100));

    const persistAlarm = (): void => {
      const current = alarmConfig();
      saveAlarmConfig({
        ...current,
        trigger: (trigger.value || current.trigger) as AlarmConfig['trigger'],
        sound: (sound.value || current.sound) as AlarmConfig['sound'],
        volume: Number.isFinite(Number(volume.value)) ? Math.min(1, Math.max(0, Number(volume.value) / 100)) : current.volume,
      });
    };
    scope.on(trigger, 'change', persistAlarm);
    scope.on(sound, 'change', persistAlarm);
    scope.on(volume, 'input', persistAlarm);
    scope.on(testBtn, 'click', () => {
      void testAlarm((sound.value || alarm.sound) as AlarmConfig['sound'], Number(volume.value) / 100);
    });

    function setStatus(color: string, text: string): void {
      status.style.color = color;
      status.textContent = text;
    }

    scope.on(intervalInput, 'change', () => {
      const val = Math.max(1, Math.min(60, parsePtBrInt(intervalInput.value) || 10));
      intervalInput.value = String(val);
      gm.set(INTERVAL_KEY, val);
    });

    scope.on(toggle, 'change', () => {
      const on = toggle.checked;
      if (
        on &&
        !window.confirm(
          'Ativar o etiquetador automático?\n\n' +
            'Ele vai etiquetar ataques novos e RECARREGAR a página automaticamente no intervalo configurado. Confirma?',
        )
      ) {
        toggle.checked = false;
        return;
      }
      gm.set(ENABLED_KEY, on);
      if (on) {
        runEtiquetador();
      } else {
        setStatus('#5a3a16', 'Desativado.');
      }
    });

    function scheduleReload(ms: number, label: string): void {
      if (!toggle.checked) return;
      setStatus('#5a3a16', label);
      scope.after(() => {
        if (isEnabled()) window.location.reload();
      }, ms);
    }

    function scheduleIntervalReload(): void {
      const mins = gm.get<number>(INTERVAL_KEY, 10);
      scheduleReload(mins * 60_000, `Próxima verificação em ${mins} minuto${mins !== 1 ? 's' : ''}...`);
    }

    /** O gatilho de alarme autoriza tocar para estas novidades? */
    function alarmShouldFire(hasNoble: boolean, hasRam: boolean): boolean {
      const cfg = alarmConfig();
      if (cfg.trigger === 'desligado') return false;
      if (cfg.trigger === 'qualquer') return true;
      if (cfg.trigger === 'apenas_nobre') return hasNoble;
      return hasNoble || hasRam; // 'nobre_ariete'
    }

    function runEtiquetador(): void {
      if (!toggle.checked) return;

      const table = document.getElementById('incomings_table');
      if (table === null) {
        setStatus('#c04038', 'Tabela de entradas não encontrada.');
        return;
      }

      let hasNew = false;
      let hasNoble = false;
      let hasRam = false;
      table.querySelectorAll('tbody tr').forEach((row) => {
        const label = row.querySelector('.quickedit-label');
        if (label === null) return;
        const text = label.textContent ?? '';
        const isNew = text.includes('Ataque') || text.includes('Apoio');
        if (!isNew) return;
        hasNew = true;
        // Ícones de unidade na linha revelam nobres/aríetes (best-effort: só
        // quando o jogo renderiza os ícones — gatilho nunca toca por menos).
        if (row.querySelector('img[src*="unit_snob"]') !== null) hasNoble = true;
        if (row.querySelector('img[src*="unit_ram"]') !== null) hasRam = true;
      });

      if (hasNew) {
        setStatus('#3f8f43', 'Ataques não etiquetados encontrados! Etiquetando...');
        if (alarmShouldFire(hasNoble, hasRam)) {
          const cfg = alarmConfig();
          void playAlarm(cfg.sound, cfg.volume);
        }
        scope.after(() => {
          const selectAll = table.querySelector<HTMLInputElement>('tbody tr input#select_all');
          if (selectAll !== null) selectAll.click();
          const etiquetaBtn = table.querySelector<HTMLInputElement>('tbody input[value="Etiqueta"]');
          if (etiquetaBtn !== null) etiquetaBtn.click();
          // P2 (original 5986-5994): agendar o reload TAMBÉM neste ramo — sem
          // isso o loop morria se o jogo não recarregasse sozinho. Delay maior
          // (60s): o clique pode recarregar a página antes (o timer morre com
          // o dispose do escopo — comportamento aceitável).
          scheduleReload(60_000, 'Etiquetado. Próxima verificação em 60 segundos...');
        }, 2000);
      } else {
        setStatus('#5a3a16', 'Nenhum ataque novo para etiquetar.');
        scheduleIntervalReload();
      }
    }

    // Auto-executa no carregamento se ligado (como o original 6016-6018).
    if (savedEnabled) runEtiquetador();
  },
});
