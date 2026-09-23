// Canais de Alerta (Onda 6): arquitetura de notificações do Toxic Squad Hub.
// Decisão do dono: o que roda LOCAL entra completo (som via alarm-sound);
// webhooks externos (WhatsApp/Discord) ficam como STUB DESLIGADO — campos de
// config existem, vazios, e nenhum tráfego externo acontece enquanto não forem
// preenchidos E ligados explicitamente. Nenhum dado sai do navegador por padrão.
//
// Uso: alert('ataque_nobre', 'Nobre chegando em 001 (534|551) às 18:00') — a
// decisão de CANAIS fica centralizada aqui, os módulos só reportam eventos.

import { gm } from '../../core/storage';
import { normalizeAlarmConfig, playAlarm, type AlarmConfig, type AlarmTrigger } from '../vanta/alarm-sound';

/** Eventos que podem disparar alerta (vocabulário fechado, pt-BR). */
export type AlertEvent =
  | 'ataque_nobre'
  | 'ataque_ariete'
  | 'ataque_qualquer'
  | 'comando_enviado'
  | 'comando_falhou'
  | 'automacao_erro'
  | 'estoque_cheio';

export interface WebhookChannel {
  /** URL completa do webhook; vazia = canal desligado (nunca envia). */
  readonly url: string;
  readonly enabled: boolean;
}

export interface AlertsConfig {
  readonly alarm: AlarmConfig;
  /** Webhook genérico (stub): POST JSON {event, message, world, at}. DESLIGADO por padrão. */
  readonly webhook: WebhookChannel;
  /** Quais eventos geram SOM (gatilho do alarme sonoro local). */
  readonly soundTriggers: Readonly<Record<AlertEvent, boolean>>;
}

const KEY = 'tsh-alerts:config';

const DEFAULTS: AlertsConfig = {
  alarm: normalizeAlarmConfig(null),
  webhook: { url: '', enabled: false },
  soundTriggers: {
    ataque_nobre: true,
    ataque_ariete: true,
    ataque_qualquer: false,
    comando_enviado: false,
    comando_falhou: true,
    automacao_erro: true,
    estoque_cheio: false,
  },
};

export function getAlertsConfig(): AlertsConfig {
  const raw = gm.get<unknown>(KEY, null);
  if (typeof raw !== 'object' || raw === null) return DEFAULTS;  const stored = raw as Partial<Record<string, unknown>>;
  const triggers = { ...DEFAULTS.soundTriggers };
  const storedTriggers = stored.soundTriggers;
  if (typeof storedTriggers === 'object' && storedTriggers !== null) {
    for (const event of Object.keys(DEFAULTS.soundTriggers) as AlertEvent[]) {
      const value = (storedTriggers as Record<string, unknown>)[event];
      if (typeof value === 'boolean') triggers[event] = value;
    }
  }
  const webhookRaw = stored.webhook;
  const webhook: WebhookChannel =
    typeof webhookRaw === 'object' && webhookRaw !== null
      ? {
          url: typeof (webhookRaw as { url?: unknown }).url === 'string' ? (webhookRaw as { url: string }).url : '',
          enabled: (webhookRaw as { enabled?: unknown }).enabled === true,
        }
      : DEFAULTS.webhook;
  return { alarm: normalizeAlarmConfig(stored.alarm ?? null), webhook, soundTriggers: triggers };
}

export function saveAlertsConfig(config: AlertsConfig): void {
  gm.set(KEY, config);
}

/** O evento de ataque casa com o gatilho de alarme configurado? */
function attackEventMatchesTrigger(event: AlertEvent, trigger: AlarmTrigger): boolean {
  if (trigger === 'desligado') return false;
  if (trigger === 'qualquer') return true;
  if (trigger === 'apenas_nobre') return event === 'ataque_nobre';
  return event === 'ataque_nobre' || event === 'ataque_ariete'; // nobre_ariete
}

/**
 * Dispara um alerta por todos os canais ativos. Sempre seguro de chamar:
 * - som: só se o evento está em soundTriggers e (para ataques) o gatilho casa;
 * - webhook: só se url não-vazia E enabled — stub desligado não gera rede.
 */
export function alert(event: AlertEvent, message: string): void {
  const config = getAlertsConfig();
  if (config.soundTriggers[event] === true) {
    const isAttack = event === 'ataque_nobre' || event === 'ataque_ariete' || event === 'ataque_qualquer';
    const shouldRing = isAttack ? attackEventMatchesTrigger(event, config.alarm.trigger) : true;
    if (shouldRing) void playAlarm(config.alarm.sound, config.alarm.volume);
  }
  if (config.webhook.enabled && config.webhook.url !== '') {
    // Stub de webhook (Onda 6): entrega futura mediante serviço próprio. Hoje
    // apenas registra no console — NENHUM tráfego externo sai do navegador.
    console.info('[tsh-alerts:webhook-stub]', event, message);
  }
}

// ── Parte pura (testável) ──────────────────────────────────────────────────

export { attackEventMatchesTrigger };

/** Defaults expostos p/ testes/preview (mesma instância congelada). */
export function getAlertsConfigDefaults(): AlertsConfig {
  return DEFAULTS;
}

/** Decide canais para um evento dado a config (puro — usado em testes). */
export function channelsForEvent(
  config: AlertsConfig,
  event: AlertEvent,
): { sound: boolean; webhook: boolean } {
  const isAttack = event === 'ataque_nobre' || event === 'ataque_ariete' || event === 'ataque_qualquer';
  const sound =
    config.soundTriggers[event] === true &&
    (!isAttack || attackEventMatchesTrigger(event, config.alarm.trigger));
  const webhook = config.webhook.enabled && config.webhook.url !== '';
  return { sound, webhook };
}
