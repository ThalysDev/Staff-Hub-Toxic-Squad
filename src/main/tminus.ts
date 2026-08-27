// Notificações T-minus: alerta na bandeja do sistema quando falta X minutos
// para o horário de envio de um comando da OP. A agenda vem do SG_4 (formato
// "nick;alvo;HH:MM:SS") — este serviço monitora os próximos envios e dispara
// notification do Electron nos marcos 15min → 5min → 1min.
import { Notification } from 'electron';

export interface TMinusEntry {
  nick: string;
  target: string;
  sendAt: Date;
}

/** Marcos de alerta (em minutos antes do envio). */
const ALERT_MINUTES = [15, 5, 1];

/** Valida marcas customizadas: inteiros 1–1440, sem duplicatas; lança PT-BR. */
export function validateAlertMinutes(marks: number[]): number[] {
  const seen = new Set<number>();
  for (const mark of marks) {
    if (!Number.isInteger(mark) || mark < 1 || mark > 1440) {
      throw new Error(`Marca T-minus inválida: ${String(mark)} — use minutos inteiros entre 1 e 1440.`);
    }
    if (seen.has(mark)) {
      throw new Error(`Marca T-minus repetida: ${String(mark)}.`);
    }
    seen.add(mark);
  }
  return [...marks].sort((a, b) => b - a);
}

/** Parseia "nick;alvo;HH:MM:SS" → TMinusEntry (fail-closed PT-BR). */
export function parseScheduleLine(line: string): TMinusEntry | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(';');
  if (parts.length !== 3) return null;
  const [nick, target, time] = [parts[0]?.trim(), parts[1]?.trim(), parts[2]?.trim()];
  if (nick === undefined || target === undefined || time === undefined) return null;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  const now = new Date();
  const sendAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]), Number(match[3]));
  // Se o horário já passou hoje, é amanhã
  if (sendAt.getTime() < now.getTime()) {
    sendAt.setDate(sendAt.getDate() + 1);
  }
  return { nick, target, sendAt };
}

/**
 * Monitor de T-minus: dado um texto de agenda, agenda notifications nos marcos.
 * Retorna um cleanup() para cancelar os timeouts.
 */
export function scheduleTMinusAlerts(
  scheduleText: string,
  onAlert?: (message: string) => void,
  marksMinutes?: number[],
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  // Marcos customizados (validados na fronteira do IPC) ou o padrão histórico.
  const alertMinutes = marksMinutes !== undefined && marksMinutes.length > 0 ? [...marksMinutes].sort((a, b) => b - a) : ALERT_MINUTES;

  for (const line of scheduleText.split(/\r?\n/)) {
    const entry = parseScheduleLine(line);
    if (entry === null) continue;

    const msUntil = entry.sendAt.getTime() - Date.now();
    if (msUntil <= 0) continue;

    for (const minutes of alertMinutes) {
      const alertAtMs = msUntil - minutes * 60_000;
      // Só alertar se o marco está no futuro (não disparar atrasados)
      if (alertAtMs <= 0) continue;

      const label = minutes === 1 ? '1 minuto' : `${minutes} minutos`;
      const message = `⏰ Faltam ${label} — ${entry.nick} envia para ${entry.target} às ${entry.sendAt.toLocaleTimeString('pt-BR')}`;

      timers.push(
        setTimeout(() => {
          // Sem icon explícito: no app empacotado __dirname aponta para dentro
          // do asar — o Electron usa o ícone do exe por padrão (garantido).
          const notification = new Notification({
            title: 'Staff Hub — T-minus',
            body: message,
          });
          notification.show();
          onAlert?.(message);
        }, alertAtMs),
      );
    }
  }

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
