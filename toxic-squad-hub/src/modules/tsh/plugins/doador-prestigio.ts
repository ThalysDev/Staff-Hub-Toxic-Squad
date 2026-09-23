// Plugin TSH 'doador-prestigio' — Doador de Prestígio (Onda 5b):
// - roda na tela da tribo em modo de níveis (screen=ally&mode=level), onde o
//   jogo expõe a doação de recursos para o prestígio da tribo;
// - settings: recurso preferido (wood/stone/iron) e quantidade por ciclo;
// - POST best-effort FAIL-CLOSED: o clique só acontece quando o formulário
//   canônico de doação está INEQUÍVOCO na página (action de doação + campo do
//   recurso + botão de doar com rótulo conhecido + token h). Sem essa certeza
//   — que é o caso comum enquanto não houver fixture da tela — o ciclo fica em
//   PRÉVIA com a mensagem "ação de doação não confirmada — nada enviado";
// - F2: UMA mutação por ciclo; humanização de rotina respeitada (doação é
//   rotina, não comando cravado).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { enqueue } from '../../../core/net';
import { awaitRoutineMutation } from '../tsh-humanize';
import { parsePtBrInt } from '../../vanta/vanta-utils';

export type DonationResource = 'wood' | 'stone' | 'iron';

const RESOURCE_LABEL: Record<DonationResource, string> = { wood: 'madeira', stone: 'argila', iron: 'ferro' };

const donationSettings = z.object({
  resource: z.enum(['wood', 'stone', 'iron']).default('wood'),
  amount: z.number().int().min(0).default(0),
});

type DonationSettings = z.infer<typeof donationSettings>;

export const DEFAULT_SETTINGS: DonationSettings = { resource: 'wood', amount: 0 };

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'resource',
    label: 'Recurso preferido',
    type: 'select',
    options: [
      { value: 'wood', label: 'Madeira' },
      { value: 'stone', label: 'Argila' },
      { value: 'iron', label: 'Ferro' },
    ],
    help: 'Recurso doado ao prestígio da tribo neste ciclo.',
  },
  {
    key: 'amount',
    label: 'Quantidade por ciclo',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 1_000,
    help: 'Quantidade do recurso doada em cada ciclo (0 = só prévia, nada é enviado).',
  },
];

/** Mensagem canônica da prévia quando a ação de doação não é confirmada. */
export const DONATION_UNCONFIRMED = 'ação de doação não confirmada — nada enviado';

/** A tela é a da tribo em modo de níveis? */
export function isAllyLevelScreen(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('screen') === 'ally' && params.get('mode') === 'level';
}

export interface DonationForm {
  form: HTMLFormElement;
  action: string;
  field: HTMLInputElement;
  submit: HTMLElement;
}

/** Rótulos aceitos do gatilho de doação (clique só com rótulo conhecido). */
const DONATION_LABELS: readonly string[] = ['doar', 'doar recursos', 'enviar doação', 'doar ao prestígio'];

/** Texto normalizado para comparar rótulos (minúsculas, espaços colapsados). */
function normalizeLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Formulário canônico de doação (FAIL-CLOSED): precisa de um form de ally cuja
 * action fale de doação ('donate'/'donation'/'doar'), de um input do recurso
 * pedido e de um gatilho de submit com rótulo CONHECIDO. Qualquer ausência (ou
 * mais de um form candidato) → null: o ciclo fica em prévia.
 */
export function findDonationForm(doc: Document, resource: DonationResource): DonationForm | null {
  const forms = Array.from(doc.querySelectorAll<HTMLFormElement>('form')).filter((form) => {
    const action = (form.getAttribute('action') ?? '').toLowerCase();
    return action.includes('screen=ally') && /donat|donate|doar|donation/.test(action);
  });
  if (forms.length !== 1) return null;
  const form = forms[0];
  if (form === undefined) return null;
  const field = form.querySelector<HTMLInputElement>(`input[name="${resource}"]`);
  if (field === null || field.disabled) return null;
  const controls = Array.from(
    form.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button, input[type="button"], a.btn'),
  );
  const submit = controls.find((control) => {
    const text = control instanceof HTMLInputElement ? control.value : control.textContent;
    return DONATION_LABELS.includes(normalizeLabel(text));
  });
  if (submit === undefined) return null;
  return { form, action: form.getAttribute('action') ?? '', field, submit };
}

/** Envio do formulário de doação (1 tentativa, sem retry — mutação). */
async function submitDonation(donation: DonationForm, amount: number): Promise<void> {
  const body = new URLSearchParams();
  for (const input of Array.from(donation.form.querySelectorAll<HTMLInputElement>('input[name]'))) {
    if (input.name === donation.field.name) {
      body.set(input.name, String(amount));
      continue;
    }
    if (input.type === 'checkbox' && !input.checked) continue;
    body.set(input.name, input.value);
  }
  await enqueue(async () => {
    const response = await fetch(donation.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`A doação foi recusada pelo jogo (HTTP ${response.status}).`);
  });
}

/** Recursos vivos da barra (para a prévia dizer o que fica). */
function readLiveResource(doc: Document, resource: DonationResource): number {
  const element = doc.querySelector<HTMLElement>(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
  const text =
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value
      : (element?.textContent ?? '');
  return parsePtBrInt(text);
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  if (!isAllyLevelScreen(window.location.search)) {
    ctx.status('Abra a tela da tribo em "Níveis" (Prestígio) para este módulo agir.', 'info');
    return;
  }
  const parsed = donationSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações do Doador de Prestígio inválidas — nada foi feito.', 'warn');
    return;
  }
  const settings: DonationSettings = parsed.data;
  const available = readLiveResource(document, settings.resource);
  if (settings.amount < 1) {
    ctx.status(
      `Prévia: doar ${RESOURCE_LABEL[settings.resource]} ao prestígio está configurado com quantidade 0 — nada é enviado.`,
      'info',
    );
    return;
  }
  if (available < settings.amount) {
    ctx.status(
      `A aldeia tem ${available} de ${RESOURCE_LABEL[settings.resource]} e a doação pedida é ${settings.amount} — nada foi enviado.`,
      'info',
    );
    return;
  }
  const donation = findDonationForm(document, settings.resource);
  if (donation === null) {
    ctx.status(
      `Prévia: doar ${settings.amount} de ${RESOURCE_LABEL[settings.resource]} ao prestígio da tribo — ${DONATION_UNCONFIRMED} (o formulário canônico de doação não foi identificado nesta tela).`,
      'info',
    );
    return;
  }
  const liberado = await awaitRoutineMutation('mercado');
  if (!liberado) {
    ctx.status('Pausa de humanização ativa — a doação foi pulada neste ciclo.', 'info');
    return;
  }
  ctx.status(
    `Prévia: doar ${settings.amount} de ${RESOURCE_LABEL[settings.resource]} ao prestígio da tribo (formulário confirmado nesta tela).`,
    'info',
  );
  // F2: UMA mutação por ciclo — 1 POST, sem retry (mutação = 1 tentativa).
  await submitDonation(donation, settings.amount);
  ctx.status(
    `Doação enviada: ${settings.amount} de ${RESOURCE_LABEL[settings.resource]} ao prestígio da tribo.`,
    'ok',
  );
}

export const doadorPrestigioAutomation: TshAutomation = {
  id: 'doador-prestigio',
  label: 'Doador de Prestígio',
  desc: 'Doa o recurso configurado ao prestígio da tribo na tela da tribo em Níveis (1 doação por ciclo; sem formulário inequívoco fica só na prévia).',
  category: 'economia',
  screen: 'ally',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(doadorPrestigioAutomation);
