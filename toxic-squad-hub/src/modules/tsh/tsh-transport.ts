// Transporte TSH do userscript: porta FIEL dos fluxos DOM/API canarados no
// mundo br142 pela extensão Toxic Squad Hub:
// - toxic-squad-hub-ext/.../modules/adapters/page-transport.ts (fluxos por
//   tela, incluindo os 2 passos da Troca Premium e do comando);
// - toxic-squad-hub-ext/.../modules/adapters/game-api.ts + entrypoints/main-bridge.ts
//   (API-first: market:map_send e scavenge_api:send_squads).
// Desvios do original (todos documentados nos pontos de uso):
// - A extensão invocava as APIs internas pela ponte main-bridge (allowlist +
//   CustomEvents entre mundos). O userscript vive NA página: o gateway
//   TribalWars.post é chamado direto via pageWindow(). A semântica fail-closed
//   é a mesma: gateway ausente → fallback DOM permitido; dispatch feito e sem
//   resposta/erro → mutação INCONCLUSIVA (afterMutation), nunca repetida aqui
//   (regra da casa: mutação = 1 tentativa, SEM retry automático).
// - Esperas por elemento usam setTimeout DENTRO da promise da chamada, sempre
//   com teto (poll + deadline). O transporte é efêmero e stateless por
//   chamada: nenhum timer sobrevive à promise que o criou.
// - TODA rede passa pelo core (serial, ≥200ms entre chamadas), em DUAS cadeias
//   (P1-3 da revisão): a NORMAL (leituras e rotina) e a URGENTE (precisão —
//   submit de comando e cancelamento cronometrado), que nunca espera a normal.
//   Funções API-first NÃO envolvem o fluxo inteiro em enqueue — a fila é uma
//   cadeia única e aninhá-la deadlockaria; cada toque de rede (POST da API ou
//   submit DOM que navega) é enfileirado individualmente.

import { enqueue, enqueueUrgent, pacedGet } from '../../core/net';
import { pageWindow } from '../../core/page';
import { currentCsrf, currentVillageId } from '../vanta/vanta-net';
import { awaitRoutineMutation } from './tsh-humanize';
import type { TimingLane } from '../../ext/core/humanize/humanize-policy';

/**
 * Porta de humanização para mutações de rotina (Onda 1): espera a vez FORA da
 * fila de rede; pausa programada ativa → erro HUMANIZE_PAUSE (o ciclo pula).
 * Mutações de PRECISÃO não passam por aqui (regra de ouro: nunca atrasadas).
 */
async function gateRoutine(kind: 'coleta' | 'recrutamento' | 'construcao' | 'mercado' | 'cunhagem'): Promise<void> {
  const liberado = await awaitRoutineMutation(kind);
  if (!liberado) {
    throw transportError('Pausa de humanização ativa — ação de rotina pulada neste ciclo.', 'HUMANIZE_PAUSE');
  }
}

/** Recursos do jogo (contrato zod das engines: premium-exchange/resource-balancer). */
export type ResourceType = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly ResourceType[] = ['wood', 'stone', 'iron'];

/** Durações de coleta (contrato zod da engine de Coleta). */
export type ScavengeDuration = 'pequena' | 'media' | 'grande' | 'extrema';

/** Duração → option_id comprovada da scavenge_api (1=Pequena..4=Extrema). */
export const SCAVENGE_OPTION_BY_DURATION: Record<string, number> = {
  pequena: 1,
  media: 2,
  grande: 3,
  extrema: 4,
};

/** Duração → índice da opção .scavenge-option no DOM (0=Pequena..3=Extrema). */
const SCAVENGE_DOM_INDEX: Record<string, number> = { pequena: 0, media: 1, grande: 2, extrema: 3 };

const POLL_INTERVAL_MS = 100;
const CONFIRM_TIMEOUT_MS = 3_000;
const COMMAND_CONFIRM_TIMEOUT_MS = 10_000;
const GAME_API_TIMEOUT_MS = 4_000;
/** Teto do POST urgente de cancelamento (mesmo espírito do GET de 30s do core). */
const CANCEL_POST_TIMEOUT_MS = 15_000;

export interface TransportError extends Error {
  code: string;
  /** true = o dispatch pode ter chegado ao jogo; o chamador NUNCA repete às cegas. */
  afterMutation: boolean;
}

export function transportError(message: string, code: string, afterMutation = false): TransportError {
  return Object.assign(new Error(message), { code, afterMutation });
}

/** Guarda para chamadores distinguirem mutação inconclusiva (sem retry). */
export function isUncertainMutationError(error: unknown): boolean {
  return error instanceof Error && (error as TransportError).afterMutation === true;
}

/** Inteiro ≥0 (porta do integerPayload da origem). */
function integerAmount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** "n238755" → "238755" (ids canônicos da extensão carregam o prefixo n). */
export function normalizeVillageId(villageId: string): string {
  return villageId.replace(/^n/, '');
}

/** "534|551" → { x: 534, y: 551 } — lança em formato inválido (fail-closed). */
export function parseCommandTarget(target: string): { x: number; y: number } {
  const match = target.trim().match(/^(\d{1,3})\|(\d{1,3})$/);
  if (match === null) {
    throw transportError(
      `Alvo inválido para o comando: "${target}" (formato esperado: x|y, ex.: 534|551).`,
      'PLAN_INVALID',
    );
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * Achata o corpo da API na notação de colchetes que o TribalWars.post da
 * página coloca no wire (jQuery form-urlencoded): squad_requests →
 * squad_requests[0][candidate_squad][unit_counts][spear] etc. Booleanos viram
 * "true"/"false" — igual ao serialize do jogo.
 */
export function flattenGameApiBody(body: Record<string, unknown>, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  const emit = (name: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => emit(`${name}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) emit(`${name}[${key}]`, inner);
      return;
    }
    flat[name] = String(value);
  };
  for (const [key, value] of Object.entries(body)) emit(prefix === '' ? key : `${prefix}[${key}]`, value);
  return flat;
}

export type GameApiResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; afterMutation: boolean };

/**
 * POST numa API interna do jogo via TribalWars.post (gateway da página),
 * serializado pelo enqueue. Porta do callGameApi da origem adaptada ao gateway
 * promise-style do userscript: gateway ausente = único caso SEM risco de
 * mutação (autoriza fallback DOM); timeout/rejeição APÓS o dispatch =
 * afterMutation (inconclusivo). Desvio: todos os campos vão no corpo do POST
 * (o gateway do userscript recebe um único payload; o jogo lê via $_REQUEST).
 */
async function postGameApi(screen: string, action: string, body: Record<string, unknown>): Promise<GameApiResult> {
  const params = new URLSearchParams({ ...flattenGameApiBody(body), h: currentCsrf() });
  return enqueue(
    () =>
      new Promise<GameApiResult>((resolve) => {
        const gateway = pageWindow().TribalWars;
        if (typeof gateway?.post !== 'function') {
          resolve({
            ok: false,
            error: 'O gateway do jogo (TribalWars.post) não está disponível nesta página.',
            afterMutation: false,
          });
          return;
        }
        let settled = false;
        // Timeout após o dispatch: o POST pode ter chegado ao jogo — tratar
        // como mutação inconclusiva, nunca como "não aconteceu" (origem game-api.ts).
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: 'Tempo esgotado aguardando a resposta da API do jogo.', afterMutation: true });
        }, GAME_API_TIMEOUT_MS);
        try {
          void gateway.post(screen, action, params).then(
            (result: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ ok: true, result });
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({
                ok: false,
                error: error instanceof Error ? error.message : 'A API do jogo recusou a operação.',
                afterMutation: true,
              });
            },
          );
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            error: error instanceof Error ? error.message : 'Falha ao chamar a API do jogo.',
            afterMutation: true,
          });
        }
      }),
  );
}

/** Soneca efêmera DENTRO da promise da chamada (sempre sob um deadline). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sonda o DOM até achar algo, com TETO — nunca loop infinito. */
async function pollUntil<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

function isChallengePage(doc: Document): boolean {
  const body = doc.body?.textContent?.toLocaleLowerCase('pt-BR') || '';
  return (
    Boolean(doc.querySelector('[id*="captcha"], [class*="captcha"], iframe[src*="captcha"]')) ||
    body.includes('captcha')
  );
}

function isSessionPage(doc: Document): boolean {
  return Boolean(doc.querySelector('form[action*="login"], input[name="username"][type="text"]'));
}

/** Gates de página da origem (assertMutable, sem o flag "armed" — transporte stateless). */
function assertMutablePage(doc: Document): void {
  if (isChallengePage(doc))
    throw transportError('Captcha detectado; a automação foi pausada para intervenção manual.', 'CAPTCHA_DETECTED');
  if (isSessionPage(doc))
    throw transportError('A sessão do Tribal Wars precisa ser atualizada manualmente.', 'SESSION_REQUIRED');
}

function fillFormFields(form: HTMLFormElement, fields: Record<string, number | string>): void {
  for (const [name, value] of Object.entries(fields)) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input === null)
      throw transportError(
        `O campo canônico "${name}" não foi encontrado no formulário da página.`,
        'PAGE_SELECTOR_CHANGED',
      );
    input.value = String(value);
  }
}

function submitForm(form: HTMLFormElement): void {
  const submitter = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
  form.requestSubmit(submitter ?? undefined);
}

/** Localiza o botão "Confirmar" revelado pelo cálculo da oferta da Troca. */
function findConfirmButton(root: ParentNode): HTMLElement | null {
  const controls = Array.from(root.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"]'));
  return (
    controls.find(
      (control) => (control.textContent ?? (control as HTMLInputElement).value ?? '').trim() === 'Confirmar',
    ) ?? null
  );
}

/** Cunhagem de moedas (origem page-transport.ts ~107-121, runtime coin-center). */
export async function mintCoins(count: number): Promise<void> {
  await gateRoutine('cunhagem');
  await enqueue(async () => {
    assertMutablePage(document);
    const form = document.querySelector<HTMLFormElement>('form[action*="screen=snob"][action*="action=coin"]');
    const countInput = form === null ? null : form.querySelector<HTMLInputElement>('input[name="count"]');
    if (form === null || countInput === null)
      throw transportError('O formulário canônico de cunhagem não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
    countInput.value = String(Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1);
    // O submit navega — fronteira irreversível: a próxima página reconcilia o
    // saldo de moedas antes de qualquer nova cunhagem.
    submitForm(form);
  });
}

export interface PremiumExchangeStep {
  buy?: Partial<Record<ResourceType, number>>;
  sell?: Partial<Record<ResourceType, number>>;
}

/**
 * Troca Premium (origem page-transport.ts ~124-163): 2 passos — preencher
 * buy_/sell_<recurso> → clicar "Calcular melhor oferta" (.btn-premium-
 * exchange-buy) → um botão "Confirmar" aparece e executa a troca. O submit
 * direto do form NÃO executa; campos ficam disabled quando o estoque da troca
 * está na capacidade. Generalização da origem (um recurso+direção por ação
 * lá): a assinatura pedida preenche vários campos num único cálculo.
 */
export async function premiumExchange(step: PremiumExchangeStep): Promise<void> {
  await gateRoutine('mercado');
  await enqueue(async () => {
    assertMutablePage(document);
    let form: HTMLFormElement | null = null;
    let filled = 0;
    for (const direction of ['buy', 'sell'] as const) {
      const amounts = step[direction];
      if (amounts === undefined) continue;
      for (const resource of RESOURCES) {
        const amount = amounts[resource];
        if (amount === undefined) continue;
        const input = document.querySelector<HTMLInputElement>(`input[name="${direction}_${resource}"]`);
        if (input === null)
          throw transportError('O formulário canônico da Troca Premium não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
        if (input.disabled)
          throw transportError(
            'A Troca Premium está com o estoque cheio para este recurso e direção.',
            'EXCHANGE_UNAVAILABLE',
          );
        input.value = String(integerAmount(amount));
        form ??= input.closest('form');
        filled += 1;
      }
    }
    if (filled === 0)
      throw transportError('Nenhuma quantidade de compra ou venda foi informada para a Troca Premium.', 'PLAN_INVALID');
    if (form === null)
      throw transportError('O formulário canônico da Troca Premium não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
    const calculateButton = form.querySelector<HTMLElement>('.btn-premium-exchange-buy');
    if (calculateButton === null)
      throw transportError(
        'O botão "Calcular melhor oferta" da Troca Premium não foi encontrado.',
        'PAGE_SELECTOR_CHANGED',
      );
    calculateButton.click();
    const exchangeForm: HTMLFormElement = form;
    // P3 (revisão Onda 6): busca do "Confirmar" restrita ao FORM da troca —
    // varrer o documento inteiro poderia clicar um "Confirmar" alheio.
    const confirmButton = await pollUntil(() => findConfirmButton(exchangeForm), CONFIRM_TIMEOUT_MS);
    if (confirmButton === null)
      throw transportError(
        'O botão "Confirmar" da Troca Premium não apareceu após o cálculo da oferta.',
        'PAGE_SELECTOR_CHANGED',
      );
    confirmButton.click();
  });
}

function findCommandConfirmForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>(
    'form#command-data-form[action*="action=command"], form[action*="screen=place"][action*="action=command"]',
  );
}

function clickConfirmSend(form: HTMLFormElement): void {
  // Passo 2 certificado: a tela de confirmação (screen=place&try=confirm) usa
  // o mesmo #command-data-form com action=command e o botão canônico
  // submit_confirm ("Enviar ataque"/"Enviar apoio"). Ponto irreversível.
  const send = form.querySelector<HTMLInputElement>('input[name="submit_confirm"], input.troop_confirm_go');
  if (send === null)
    throw transportError('A tela de confirmação do comando não foi encontrada nesta página.', 'PAGE_SELECTOR_CHANGED');
  send.click();
}

type ConfirmMatch = 'match' | 'mismatch' | 'unknown';

/**
 * P1-2 da revisão: o alvo de edifício da Praça é `select[name="building"]`
 * (valores = chaves de CATAPULT_TARGETS). Fail-closed: alvo pedido com
 * catapultas no conjunto e SEM o select canônico = erro explícito — nunca
 * confirmar em silêncio com o alvo padrão do jogo. Sem catapultas o alvo é
 * inócuo (o jogo ignora) e a ausência do campo não é erro.
 */
function requireCatapultTargetSelect(
  form: HTMLFormElement,
  catapultTarget: string | undefined,
  units: Record<string, number>,
): HTMLSelectElement | null {
  if (catapultTarget === undefined || catapultTarget === '') return null;
  const select = form.querySelector<HTMLSelectElement>('select[name="building"]');
  if (select !== null) return select;
  if (integerAmount(units.catapult) > 0) {
    throw transportError('Alvo de catapulta não aplicável nesta tela.', 'CATAPULT_TARGET_UNAVAILABLE');
  }
  return null;
}

/** Aplica o alvo pedido; opção inexistente no select também é fail-closed. */
function setCatapultTarget(select: HTMLSelectElement, wanted: string): void {
  select.value = wanted;
  if (select.value !== wanted) {
    throw transportError(
      `O alvo de catapulta "${wanted}" não existe no formulário desta tela.`,
      'CATAPULT_TARGET_UNAVAILABLE',
    );
  }
}

/**
 * Conferência defensiva da tela de confirmação (semântica do matcher da
 * extensão, doc vivo 20/08/2026): hidden `support` presente → apoio, ausente →
 * ataque; x/y/unidades são lidos do próprio form quando expostos. Quando a tela
 * expõe o alvo de catapulta (`building`), ele também precisa casar — o campo
 * ausente é tela sem o dado (não vira "unknown" por isso). Tela sem dados
 * legíveis = "unknown" — o chamador decide falhar-fechado.
 */
function matchConfirmScreen(
  form: HTMLFormElement,
  coords: { x: number; y: number },
  units: Record<string, number>,
  opts: { attack: boolean; catapultTarget?: string },
): ConfirmMatch {
  const screenIsSupport = form.querySelector('input[name="support"]') !== null;
  if (screenIsSupport === opts.attack) return 'mismatch';
  let known = false;
  const xInput = form.querySelector<HTMLInputElement>('input[name="x"]');
  const yInput = form.querySelector<HTMLInputElement>('input[name="y"]');
  if (xInput !== null && yInput !== null) {
    known = true;
    if (Number(xInput.value) !== coords.x || Number(yInput.value) !== coords.y) return 'mismatch';
  }
  for (const [unit, amount] of Object.entries(units)) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
    if (input === null) continue;
    known = true;
    if (Number(input.value) !== integerAmount(amount)) return 'mismatch';
  }
  const catapultTarget = opts.catapultTarget ?? '';
  if (catapultTarget !== '') {
    const building = form.querySelector<HTMLSelectElement | HTMLInputElement>(
      'select[name="building"], input[name="building"]',
    );
    if (building !== null && building.value !== catapultTarget) return 'mismatch';
  }
  return known ? 'match' : 'unknown';
}

export interface CommandOptions {
  attack: boolean;
  /**
   * Faixa de envio (Onda 1, REGRA DE OURO): 'precisao' (default) = o clique
   * acontece NO milissegundo planejado, sem nenhuma humanização; 'humanizado'
   * = fakes e envios de rotina respeitam intervalo/variação/pausa. O agendador
   * deriva com laneForSchedulerRecord(record) — nunca chuta.
   */
  lane?: TimingLane;
  /**
   * Alvo das catapultas (Onda 1, P1-2 da revisão): chave de CATAPULT_TARGETS
   * (ex.: 'wall'). Quando preenchido, o alvo de edifício do formulário da
   * Praça recebe este valor antes do submit — sem isto a catapulta bate no
   * alvo padrão do jogo enquanto o operador acha que mirou outro edifício.
   */
  catapultTarget?: string;
}

/**
 * Comando da Praça de Reunião em 2 passos (origem page-transport.ts ~166-224).
 * Passo 1: #command-data-form + unidades + x/y + requestSubmit no botão do
 * tipo pedido (#target_attack / #target_support — o kind decide o botão; o
 * botão ausente falha fechado, nunca adivinha). Passo 2: input[name=
 * submit_confirm] da tela de confirmação.
 *
 * P1-3 da revisão (regra de ouro): os DOIS passos vão pela fila URGENTE — um
 * cravado não pode entrar atrás de leituras penduradas na fila normal. A
 * espera da tela de confirmação (poll no DOM, não é rede) fica FORA da fila:
 * só o clique final do passo 2 passa pela urgente, no instante planejado.
 *
 * Desvio estrutural do userscript: o passo 1 NAVEGA (contexto atual morre).
 * A função cobre os dois cenários reais:
 * - chamada na tela da Praça: submete o passo 1 e aguarda a tela de
 *   confirmação com TETO (10s) para completar o passo 2 no mesmo contexto;
 *   se a navegação destruir a página (fluxo normal do TW), a promise morre
 *   com ela e o passo 2 deve ser re-executado na tela de confirmação;
 * - chamada JÁ na tela de confirmação: executa só o passo 2, mas só depois
 *   do matcher fail-closed (tipo/alvo/tropas) — nunca confirma às cegas.
 */
export async function submitCommand2Step(
  target: string,
  units: Record<string, number>,
  opts: CommandOptions,
): Promise<void> {
  // Faixa de envio (Onda 1): precisão NUNCA espera; humanizado (fakes/rotina)
  // respeita a política — espera fora da fila de rede.
  const lane = opts.lane ?? 'precisao';
  if (lane === 'humanizado') {
    const liberado = await awaitRoutineMutation('fake');
    if (!liberado) {
      throw transportError('Pausa de humanização ativa — comando humanizado pulado.', 'HUMANIZE_PAUSE');
    }
  }
  const coords = parseCommandTarget(target);
  // Já na tela de confirmação: só o passo 2, pela fila urgente, com o matcher
  // fail-closed DENTRO do slot (a tela é re-lida ali — nunca clica numa tela
  // que mudou entre a leitura e o clique).
  if (findCommandConfirmForm() !== null) {
    await enqueueUrgent(async () => {
      assertMutablePage(document);
      const current = findCommandConfirmForm();
      if (current === null)
        throw transportError(
          'A tela de confirmação do comando desapareceu antes do clique final — nada foi confirmado.',
          'CONFIRM_SCREEN_NOT_REACHED',
        );
      const match = matchConfirmScreen(current, coords, units, opts);
      if (match !== 'match')
        throw transportError(
          'A tela de confirmação atual não corresponde ao comando pedido (tipo, alvo ou tropas) — nada foi confirmado.',
          'RESULT_UNCERTAIN',
        );
      clickConfirmSend(current);
    });
    return;
  }
  const form = document.querySelector<HTMLFormElement>(
    '#command-data-form, form[action*="screen=place"][action*="try=confirm"]',
  );
  if (form === null)
    throw transportError('O formulário canônico da Praça de Reunião não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
  const submitter = form.querySelector<HTMLElement>(
    opts.attack ? 'input[name="attack"], input#target_attack' : 'input[name="support"], input#target_support',
  );
  if (submitter === null) {
    throw transportError(
      `O botão canônico de ${opts.attack ? 'ataque' : 'apoio'} (#target_${opts.attack ? 'attack' : 'support'}) não foi encontrado na Praça de Reunião.`,
      'PAGE_SELECTOR_CHANGED',
    );
  }
  const fields: Record<string, number> = { x: coords.x, y: coords.y };
  for (const [unit, amount] of Object.entries(units)) fields[unit] = integerAmount(amount);
  // P1-2: alvo de catapulta resolvido ANTES do submit — fail-closed explícito
  // (nada foi submetido ainda quando isto lança).
  const catapultSelect = requireCatapultTargetSelect(form, opts.catapultTarget, units);
  const catapultTarget = opts.catapultTarget ?? '';
  // Passo 1 (urgente): preencher e submeter. Nenhuma mutação aconteceu ainda:
  // o envio real é o passo 2 (submit_confirm) — mas a tela de confirmação
  // precisa estar pronta no ms planejado.
  await enqueueUrgent(async () => {
    assertMutablePage(document);
    if (catapultSelect !== null) setCatapultTarget(catapultSelect, catapultTarget);
    fillFormFields(form, fields);
    form.requestSubmit(submitter);
  });
  // Espera da tela de confirmação FORA da fila (P1-3): poll no DOM não é rede
  // e um poll de até 10s dentro do enqueue segurava a fila inteira. O probe
  // devolve null enquanto a tela não existe (pollUntil devolve o próprio valor
  // da sonda quando ele não é null).
  const reached = await pollUntil(
    () => (findCommandConfirmForm() === null ? null : true),
    COMMAND_CONFIRM_TIMEOUT_MS,
  );
  if (reached !== true)
    throw transportError(
      'O passo 1 foi enviado, mas a tela de confirmação não apareceu neste contexto — execute o passo 2 nela (nenhuma tropa foi enviada ainda).',
      'CONFIRM_SCREEN_NOT_REACHED',
    );
  // Passo 2 (urgente): re-lê a tela no slot da fila e passa o matcher
  // fail-closed antes do clique — confirmação nunca às cegas.
  await enqueueUrgent(async () => {
    assertMutablePage(document);
    const current = findCommandConfirmForm();
    if (current === null)
      throw transportError(
        'A tela de confirmação do comando desapareceu antes do clique final — nada foi confirmado.',
        'CONFIRM_SCREEN_NOT_REACHED',
      );
    const postMatch = matchConfirmScreen(current, coords, units, opts);
    if (postMatch !== 'match') {
      throw transportError(
        'A tela de confirmação que apareceu não corresponde ao comando pedido (tipo, alvo ou tropas) — nada foi confirmado.',
        'RESULT_UNCERTAIN',
      );
    }
    clickConfirmSend(current);
  });
}

/**
 * Recrutamento (origem page-transport.ts ~226-245): #train_form +
 * input[name=<unidade>] (só unidades PESQUISADAS aparecem — input ausente
 * falha fechado) + requestSubmit. Generalização da origem (uma unidade por
 * ação): o form do jogo recebe todas as unidades no mesmo submit.
 */
export async function recruitUnits(units: Record<string, number>): Promise<void> {
  await gateRoutine('recrutamento');
  await enqueue(async () => {
    assertMutablePage(document);
    const entries = Object.entries(units);
    if (entries.length === 0)
      throw transportError('Nenhuma unidade de recrutamento foi informada.', 'PLAN_INVALID');
    const form = document.querySelector<HTMLFormElement>(
      '#train_form, form[action*="screen=train"][action*="action=train"]',
    );
    if (form === null)
      throw transportError('O formulário canônico de recrutamento não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
    const missing: string[] = [];
    for (const [unit, amount] of entries) {
      const input = form.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
      if (input === null) {
        missing.push(unit);
        continue;
      }
      input.value = String(integerAmount(amount, 1));
    }
    if (missing.length > 0)
      throw transportError(
        `O formulário canônico de recrutamento para "${missing.join('", "')}" não foi encontrado (unidade pesquisada?).`,
        'PAGE_SELECTOR_CHANGED',
      );
    submitForm(form);
  });
}

/**
 * Ampliação de edifício (origem page-transport.ts ~247-264): clique no link
 * screen=main&action=upgrade_building&id=<edifício> (href real inclui type= e
 * &h= — casar por id= OU type=, como a origem). O clique navega; só a
 * releitura do Edifício Principal confirma a fila.
 */
export async function upgradeBuilding(buildingId: string): Promise<void> {
  await gateRoutine('construcao');
  await enqueue(async () => {
    assertMutablePage(document);
    const link = document.querySelector<HTMLAnchorElement>(
      `a[href*="screen=main"][href*="action=upgrade_building"][href*="id=${buildingId}"], a[href*="screen=main"][href*="action=upgrade_building"][href*="type=${buildingId}"]`,
    );
    if (link === null)
      throw transportError(
        `O link canônico de ampliação de ${buildingId} não foi encontrado nesta página.`,
        'PAGE_SELECTOR_CHANGED',
      );
    link.click();
  });
}

export interface SendResourcesPayload {
  wood: number;
  stone: number;
  iron: number;
  /** Id da aldeia destino (habilita o caminho API map_send). */
  receiverId?: string;
  /** Coordenadas do destino (fallback DOM do Mercado). */
  target?: { x: number; y: number };
}

/**
 * Envio de mercado (origem page-transport.ts ~266-303 + game-api.ts:93).
 * Caminho primário comprovado (3 scripts da comunidade): market/map_send —
 * 1 POST por transferência, sem tela de confirmação. Desvio: o campo village
 * viaja no corpo (gateway single-payload; o jogo lê via $_REQUEST). Falha
 * APÓS o dispatch é mutação inconclusiva (sem retry cego via DOM). Fallback
 * DOM: form do Mercado (mode=send/try=confirm_send) + x/y + requestSubmit.
 */
export async function sendResources(villageId: string, payload: SendResourcesPayload): Promise<void> {
  await gateRoutine('mercado');
  const sourceId = normalizeVillageId(villageId) || normalizeVillageId(currentVillageId());
  const receiverId = typeof payload.receiverId === 'string' ? normalizeVillageId(payload.receiverId) : '';
  if (receiverId !== '') {
    const api = await postGameApi('market', 'map_send', {
      village: sourceId,
      target_id: receiverId,
      wood: integerAmount(payload.wood),
      stone: integerAmount(payload.stone),
      iron: integerAmount(payload.iron),
    });
    if (api.ok) return;
    if (api.afterMutation)
      throw transportError(
        `Envio por API inconclusivo: ${api.error} — releia o jogo antes de nova tentativa.`,
        'RESULT_UNCERTAIN',
        true,
      );
  }
  await enqueue(async () => {
    assertMutablePage(document);
    const form = document.querySelector<HTMLFormElement>('form[action*="screen=market"][action*="mode=send"]');
    if (form === null)
      throw transportError('O formulário canônico de envio do Mercado não foi encontrado.', 'PAGE_SELECTOR_CHANGED');
    const x = integerAmount(payload.target?.x);
    const y = integerAmount(payload.target?.y);
    if (x === 0 && y === 0) throw transportError('Destino do envio sem coordenadas válidas.', 'PLAN_INVALID');
    const fields: Record<string, number> = { x, y };
    for (const resource of RESOURCES) {
      const amount = payload[resource];
      if (amount) fields[resource] = integerAmount(amount);
    }
    fillFormFields(form, fields);
    submitForm(form);
  });
}

export interface ScavengeSquad {
  duration: ScavengeDuration;
  units: Record<string, number>;
}

export function scavengeOptionId(duration: string): number {
  return SCAVENGE_OPTION_BY_DURATION[duration] ?? 2;
}

export function scavengeDomIndex(duration: string): number {
  return SCAVENGE_DOM_INDEX[duration] ?? 1;
}

function sanitizedUnitCounts(units: Record<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [unit, amount] of Object.entries(units)) counts[unit] = integerAmount(amount);
  return counts;
}

/**
 * Coleta individual (origem page-transport.ts ~329-388 + game-api.ts:74).
 * Caminho primário comprovado (3 scripts da comunidade): API interna
 * scavenge_api/send_squads — 1 POST com todas as esquadrilhas. Falha APÓS o
 * dispatch = mutação inconclusiva; sem retry via DOM. Fallback DOM: inputs
 * GLOBAIS input.unitsInput[name=<unidade>] + evento "change" (o jogo só
 * registra o valor no change) + gatilho <a> com o rótulo do botão-oculto
 * .free_send_button ("Começar") da opção — uma esquadrilha por tela.
 */
export async function sendScavengingSquads(villageId: string, squads: ScavengeSquad[]): Promise<void> {
  await gateRoutine('coleta');
  if (squads.length === 0) throw transportError('Nenhuma esquadrilha de coleta foi informada.', 'PLAN_INVALID');
  const normalizedVillageId = normalizeVillageId(villageId) || normalizeVillageId(currentVillageId());
  const api = await postGameApi('scavenge_api', 'send_squads', {
    squad_requests: squads.map((squad) => ({
      village_id: normalizedVillageId,
      candidate_squad: { unit_counts: sanitizedUnitCounts(squad.units), carry_max: 9_999_999_999 },
      option_id: scavengeOptionId(squad.duration),
      use_premium: false,
    })),
  });
  if (api.ok) return;
  if (api.afterMutation)
    throw transportError(
      `Coleta por API inconclusiva: ${api.error} — releia o jogo antes de nova tentativa.`,
      'RESULT_UNCERTAIN',
      true,
    );
  if (squads.length > 1)
    throw transportError(
      'O envio DOM de coleta suporta apenas uma opção por tela — use o caminho da API (TribalWars.post) para múltiplas esquadrilhas.',
      'UNSUPPORTED_PAGE_ACTION',
    );
  const squad = squads[0];
  if (squad === undefined) throw transportError('Nenhuma esquadrilha de coleta foi informada.', 'PLAN_INVALID');
  await enqueue(async () => {
    assertMutablePage(document);
    const index = scavengeDomIndex(squad.duration);
    const option = document.querySelectorAll<HTMLElement>('.scavenge-option, [data-scavenge-option]')[index] ?? null;
    if (option === null)
      throw transportError(
        `A opção de coleta "${squad.duration}" não foi encontrada nesta página.`,
        'PAGE_SELECTOR_CHANGED',
      );
    for (const [unit, amount] of Object.entries(squad.units)) {
      const input =
        document.querySelector<HTMLInputElement>(`input.unitsInput[name="${unit}"]`) ??
        document.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
      if (input === null) continue;
      input.value = String(integerAmount(amount));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const hiddenButton = document.querySelector<HTMLElement>('.free_send_button');
    const label = (hiddenButton?.textContent ?? 'Começar').trim();
    const start = Array.from(option.querySelectorAll<HTMLAnchorElement>('a')).find(
      (link) => (link.textContent ?? '').trim() === label && !link.classList.contains('btn-disabled'),
    );
    if (start === undefined)
      throw transportError(
        'O gatilho canônico "Começar" desta opção de coleta não foi encontrado (opção em andamento?).',
        'PAGE_SELECTOR_CHANGED',
      );
    start.click();
  });
}

/**
 * Coleta em Massa (origem page-transport.ts ~389-424, tela place&mode=
 * scavenge_mass): inputs globais por unidade, checkbox "Selecionar todos" e
 * um gatilho "Coletar recursos" por nível (Pequena..Extrema) — tudo via JS.
 * Fail-closed: sem os gatilhos canônicos de nível, nada é clicado.
 */
export async function sendScavengingMass(units: Record<string, number>, duration: ScavengeDuration = 'media'): Promise<void> {
  await gateRoutine('coleta');
  await enqueue(async () => {
    assertMutablePage(document);
    const index = scavengeDomIndex(duration);
    // Fail-closed (P2 revisão Onda 6): unidade SEM input canônico aborta ANTES
    // de qualquer clique — sem isso, o "Selecionar todos" dispararia coleta
    // com TODAS as tropas em vez do lote planejado.
    const missing: string[] = [];
    for (const unit of Object.keys(units)) {
      if (document.querySelector<HTMLInputElement>(`input[name="${unit}"]`) === null) missing.push(unit);
    }
    if (missing.length > 0) {
      throw transportError(
        `Input de coleta em massa ausente para: ${missing.join(', ')} — nada foi clicado.`,
        'PAGE_SELECTOR_CHANGED',
      );
    }
    for (const [unit, amount] of Object.entries(units)) {
      const input = document.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
      if (input !== null) input.value = String(integerAmount(amount));
    }
    const selectAll = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((checkbox) =>
      checkbox.closest('tr')?.textContent?.includes('Selecionar todos'),
    );
    if (selectAll instanceof HTMLInputElement && !selectAll.checked) selectAll.click();
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>('.scavenge-option a.btn, .scavenge-option .btn-default'),
    ).filter((element) => (element.textContent ?? '').includes('Coletar recursos'));
    if (triggers.length === 0)
      throw transportError('Os gatilhos canônicos de coleta em massa não foram encontrados.', 'PAGE_SELECTOR_CHANGED');
    if (triggers.length <= index)
      throw transportError(
        `O nível de coleta pedido (índice ${index}) não está disponível nesta página (${triggers.length} níveis).`,
        'PAGE_SELECTOR_CHANGED',
      );
    triggers[index]?.click();
  });
}

/**
 * Recrutamento do Paladino (origem page-transport.ts ~305-327): o botão
 * "Recrutar" da Estátua é o lançador JS a.knight_recruit_launch — ÚNICO
 * mecanismo certificado. Nenhum link de ação genérico é clicado (fail-closed:
 * um link action= arbitrário poderia equipar item, trocar arma etc.).
 */
export async function launchPaladinTraining(): Promise<void> {
  await gateRoutine('recrutamento');
  await enqueue(async () => {
    assertMutablePage(document);
    const launcher = document.querySelector<HTMLAnchorElement>('a.knight_recruit_launch');
    if (launcher === null)
      throw transportError(
        'O lançador canônico de recrutamento do Paladino não foi encontrado (paladino presente ou sem slot?).',
        'PAGE_SELECTOR_CHANGED',
      );
    launcher.click();
  });
}

// ── Cancelamento Cronometrado (Onda 1) ─────────────────────────────────────
// Mecanismo comprovado na revisão do modo=commands (br142): cada linha com
// cancelamento possível expõe a própria URL action=cancel&id=N (com h do
// jogo); quando a linha não expõe, o fallback é o POST ajaxaction=cancel da
// família info_command (mesma do edit_other_comment do vanta-net). O alvo é
// FAIXA DE PRECISÃO: nenhum delay de humanização — o cancelamento snipe
// acontece no milissegundo planejado (regra de ouro).

export interface CancelCommandsResult {
  /** Comandos cujo POST de cancelamento respondeu OK. */
  readonly cancelled: number;
  /** Comandos cujo POST falhou (a lista para no primeiro erro). */
  readonly failed: number;
  readonly message: string;
}

export interface CancelableRow {
  readonly commandId: string;
  readonly url: string; // URL de cancelamento pronta (com h)
}

/**
 * Descobre linhas canceláveis cujo DESTINO é a coordenada-alvo. Pura (recebe o
 * HTML): o agendador pode pré-ler a página ANTES do instante sendAt e passar o
 * corpo pronto. O href de cancelamento casa com `id=` ANTES ou DEPOIS de
 * `action=cancel` (a ordem não é contrato do template).
 */
export function parseCancelableRows(html: string, target: { x: number; y: number }): CancelableRow[] {
  const rows: CancelableRow[] = [];
  const wanted = `${target.x}|${target.y}`;
  for (const raw of html.split(/<tr[^>]*>/i).slice(1)) {
    const hrefMatch = raw.match(/href="([^"]*action=cancel[^"]*)"/i);
    if (hrefMatch === null) continue;
    const rawHref = hrefMatch[1];
    if (rawHref === undefined) continue;
    const href = rawHref.replace(/&amp;/g, '&');
    if (!/\/game\.php/i.test(href)) continue;
    const idMatch = href.match(/[?&]id=(\d+)/);
    if (idMatch === null || idMatch[1] === undefined) continue;
    // Destino = primeiro link info_village da linha (ordem do template:
    // Destino | Origem — ver revisão do cancelamento-bloco).
    const destMatch = raw.match(/screen=info_village&amp;id=\d+[^"]*"[^>]*>[^<]*?\((\d+\|\d+)\)/);
    if (destMatch === null || destMatch[1] !== wanted) continue;
    rows.push({ commandId: idMatch[1], url: href });
  }
  return rows;
}

/**
 * Cancela até `count` comandos PRÓPRIOS cujo destino é `target` ("x|y").
 * PRECISÃO: sem gate de humanização; os POSTs vão pela fila URGENTE (nunca
 * atrás de leituras penduradas, e serializados entre si com o gap da fila).
 * `preparsedHtml` (P2-2 da revisão): HTML da Visão de Comandos lido ANTES do
 * instante sendAt pelo chamador — quando ausente, a leitura acontece aqui
 * (comportamento anterior). Para no primeiro POST que falha (fail-closed —
 * nunca martela o jogo) e devolve o resumo do que conseguiu; o POST tem teto
 * de 15s (abort = falha) para não pendurar a fila urgente.
 */
export async function cancelGameCommandsAtTarget(
  target: string,
  count: number,
  preparsedHtml?: string,
): Promise<CancelCommandsResult> {
  const coords = parseCommandTarget(target);
  const village = currentVillageId();
  const html =
    preparsedHtml ??
    (await pacedGet(`/game.php?village=${village}&screen=overview_villages&mode=commands&page=-1`, { fresh: true }));
  const rows = parseCancelableRows(html, coords);
  if (rows.length === 0) {
    return {
      cancelled: 0,
      failed: 0,
      message: `Nenhum comando cancelável com destino ${target} encontrado na Visão de Comandos.`,
    };
  }
  const alvo = rows.slice(0, Math.max(1, Math.floor(count)));
  let cancelled = 0;
  let failed = 0;
  let message = '';
  for (const row of alvo) {
    const ok = await enqueueUrgent(async () => {
      // Timeout do POST urgente (pré-canário): sem AbortController um fetch
      // pendurado trava a fila URGENTE INTEIRA para sempre. Abort = falha do
      // POST (mesmo tratamento do HTTP não-OK: para o lote).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CANCEL_POST_TIMEOUT_MS);
      try {
        const response = await fetch(row.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '',
          signal: controller.signal,
        });
        return response.ok;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    if (ok) {
      cancelled += 1;
    } else {
      failed += 1;
      message = `Cancelamento do comando ${row.commandId} falhou (HTTP não-OK) — lote interrompido.`;
      break;
    }
  }
  return {
    cancelled,
    failed,
    message:
      message !== ''
        ? message
        : `${cancelled} comando(s) com destino ${target} cancelado(s)${failed > 0 ? `, ${failed} falha(s)` : ''}.`,
  };
}
