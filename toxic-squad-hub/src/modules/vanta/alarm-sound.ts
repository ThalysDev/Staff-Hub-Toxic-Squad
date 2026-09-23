// Alarme sonoro LOCAL da Suite Vanta (infra compartilhada, não é launcher):
// 100% Web Audio API — zero arquivo externo, zero dependência, zero rede.
//
// Contrato:
// - Alarme sonoro acompanha um GATILHO (desligado / apenas_nobre /
//   nobre_ariete / qualquer) e um SOM (relogio / bip / relogio_digital /
//   sirene) + volume 0..1; a config crua (GM storage / UI) passa SEMPRE por
//   normalizeAlarmConfig antes de tocar (lixo → defaults, volume clampado).
// - AudioContext criado LAZY no 1º uso: criá-lo no load da página o deixa
//   "suspended" pela política de autoplay e o 1º toque sairia mudo. Aqui o
//   resume() acontece no início de cada play.
// - Falha de áudio NUNCA vira erro de produto: sem WebAudio (ou com o resume
//   bloqueado) playAlarm/testAlarm resolvem em silêncio — quem chama não
//   precisa de try/catch.
// - stopAlarm() para TUDO em curso: osciladores agendados são interrompidos,
//   timers cancelados e promessas pendentes resolvidas (fim de loop garantido).
//
// A parte pura (schema/normalize) é testável em node — o resto toca som de
// verdade e é coberto manualmente no navegador (ver alarm-sound.test.ts).

import { z } from 'zod';

export type AlarmSound = 'relogio' | 'bip' | 'relogio_digital' | 'sirene';
export type AlarmTrigger = 'desligado' | 'apenas_nobre' | 'nobre_ariete' | 'qualquer';

export interface AlarmConfig {
  trigger: AlarmTrigger;
  sound: AlarmSound;
  /** 0..1 (fora da faixa é clampado — nunca lança). */
  volume: number;
}

export const ALARM_SOUNDS = ['relogio', 'bip', 'relogio_digital', 'sirene'] as const;
export const ALARM_TRIGGERS = ['desligado', 'apenas_nobre', 'nobre_ariete', 'qualquer'] as const;
export const DEFAULT_ALARM_VOLUME = 0.7;

/** Rótulos PT-BR (UI da Suite Vanta). */
export const ALARM_SOUND_LABELS: Record<AlarmSound, string> = {
  relogio: 'Relógio (tique-taque)',
  bip: 'Bip (pulsos curtos)',
  relogio_digital: 'Relógio digital (beep duplo)',
  sirene: 'Sirene (varredura 600–1200 Hz)',
};

export const ALARM_TRIGGER_LABELS: Record<AlarmTrigger, string> = {
  desligado: 'Desligado',
  apenas_nobre: 'Apenas nobre',
  nobre_ariete: 'Nobre e aríete',
  qualquer: 'Qualquer ataque',
};

/**
 * Schema tolerante do storage/UI: campo inválido cai no default do campo
 * (`.catch`) em vez de derrubar a config inteira — alarme mudo silencioso é
 * pior que alarme com default.
 */
export const alarmConfigSchema = z.object({
  trigger: z.enum(ALARM_TRIGGERS).catch('desligado').default('desligado'),
  sound: z.enum(ALARM_SOUNDS).catch('relogio').default('relogio'),
  volume: z.number().catch(DEFAULT_ALARM_VOLUME).default(DEFAULT_ALARM_VOLUME),
});

/** Config default (tudo desligado / som neutro). */
export const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  trigger: 'desligado',
  sound: 'relogio',
  volume: DEFAULT_ALARM_VOLUME,
};

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_ALARM_VOLUME;
  return Math.min(1, Math.max(0, volume));
}

/**
 * Normaliza config crua (GM storage, JSON, formulário) em AlarmConfig válida.
 * Entrada que não é objeto vira os defaults; volume é clampado a 0..1 —
 * volume 0 é respeitado (silêncio é uma escolha, não "campo ausente").
 */
export function normalizeAlarmConfig(raw: unknown): AlarmConfig {
  const parsed = alarmConfigSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_ALARM_CONFIG };
  return {
    trigger: parsed.data.trigger,
    sound: parsed.data.sound,
    volume: clampVolume(parsed.data.volume),
  };
}

// ── Síntese (Web Audio) ─────────────────────────────────────────────────────

type AudioContextCtor = new () => AudioContext;

interface AlarmNote {
  /** Frequência inicial e final (Hz); diferentes = varredura linear. */
  from: number;
  to: number;
  /** Duração do tom em segundos. */
  duration: number;
  /** Silêncio depois do tom em segundos. */
  gap: number;
  wave: OscillatorType;
}

const alarmNotes: Record<AlarmSound, (short: boolean) => AlarmNote[]> = {
  // Tique-taque: 1 tique por segundo (2 no teste curto).
  relogio: (short) => {
    const ticks = short ? 2 : 4;
    const duration = short ? 0.05 : 0.06;
    const gap = short ? 0.25 : 0.94;
    return Array.from({ length: ticks }, (_, index) => ({
      from: 1500,
      to: 1500,
      duration,
      gap: index === ticks - 1 ? 0 : gap,
      wave: 'square',
    }));
  },
  // 3 pulsos curtos.
  bip: (short) => {
    const gap = short ? 0.06 : 0.1;
    return [
      { from: 880, to: 880, duration: 0.12, gap, wave: 'sine' },
      { from: 880, to: 880, duration: 0.12, gap, wave: 'sine' },
      { from: 880, to: 880, duration: 0.12, gap: 0, wave: 'sine' },
    ];
  },
  // Beep duplo do relógio digital.
  relogio_digital: () => [
    { from: 1046, to: 1046, duration: 0.1, gap: 0.08, wave: 'square' },
    { from: 1046, to: 1046, duration: 0.1, gap: 0, wave: 'square' },
  ],
  // Sirene: varredura 600→1200 Hz (3× no ciclo completo, 1× no teste).
  sirene: (short) => {
    const sweeps = short ? 1 : 3;
    const duration = short ? 0.35 : 0.5;
    return Array.from({ length: sweeps }, (_, index) => ({
      from: 600,
      to: 1200,
      duration,
      gap: index === sweeps - 1 ? 0 : 0.15,
      wave: 'sawtooth',
    }));
  },
};

let audioCtx: AudioContext | null = null;
/** Geração do alarme: qualquer stopAlarm()/novo play invalida o que veio antes. */
let generation = 0;
const liveOscillators = new Set<OscillatorNode>();
const liveTimers = new Set<number>();
const pendingResolvers = new Set<() => void>();

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (audioCtx !== null) return audioCtx;
  const Ctor = audioContextCtor();
  if (Ctor === null) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null; // navegador sem WebAudio: o alarme simplesmente fica mudo
  }
  return audioCtx;
}

/** Espera o ciclo terminar; um stopAlarm() resolve na hora. */
function waitOrStop(gen: number, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let timer = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      liveTimers.delete(timer);
      pendingResolvers.delete(finish);
      resolve();
    };
    timer = window.setTimeout(finish, ms);
    liveTimers.add(timer);
    pendingResolvers.add(finish);
    if (gen !== generation) finish();
  });
}

/** Agenda UM ciclo do padrão e devolve a duração total em ms. */
function scheduleCycle(ctx: AudioContext, notes: AlarmNote[], volume: number): number {
  const peak = Math.max(volume, 0.0001); // rampa exponencial não aceita 0
  let at = ctx.currentTime + 0.03;
  const startAt = at;
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const attack = Math.min(0.01, note.duration / 4);
    const release = Math.min(0.05, note.duration / 3);
    osc.type = note.wave;
    osc.frequency.setValueAtTime(note.from, at);
    if (note.to !== note.from) osc.frequency.linearRampToValueAtTime(note.to, at + note.duration);
    // Envelope curto: sem clique no ataque e no fim do tom.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.setValueAtTime(peak, at + Math.max(attack, note.duration - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + note.duration + 0.02);
    liveOscillators.add(osc);
    osc.onended = (): void => {
      liveOscillators.delete(osc);
      gain.disconnect();
      osc.disconnect();
    };
    at += note.duration + note.gap;
  }
  return Math.max(0, (at - startAt) * 1000) + 40;
}

export interface PlayAlarmOptions {
  /** Repete o ciclo até um stopAlarm() (alarme contínuo). Default: 1 ciclo. */
  repeat?: boolean;
}

async function startAlarm(sound: AlarmSound, volume: number, short: boolean, repeat: boolean): Promise<void> {
  const ctx = ensureContext();
  if (ctx === null) return;
  stopAlarm(); // um alarme por vez (e libera quem esperava o anterior)
  const gen = generation;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    /* resume bloqueado: agenda assim mesmo — toca quando o navegador liberar */
  }
  if (gen !== generation) return; // stopAlarm() durante o resume
  const peak = clampVolume(volume);
  if (peak <= 0) return; // volume 0 é silêncio explícito
  const notes = alarmNotes[sound](short);
  do {
    if (gen !== generation) return;
    await waitOrStop(gen, scheduleCycle(ctx, notes, peak));
  } while (repeat && gen === generation);
}

/** Toca UM ciclo completo do alarme e resolve quando ele termina (ou no stop). */
export function playAlarm(sound: AlarmSound, volume: number, opts?: PlayAlarmOptions): Promise<void> {
  return startAlarm(sound, volume, false, opts?.repeat === true);
}

/** 1 ciclo CURTO do som escolhido — para testar o alarme sem esperar o ciclo cheio. */
export function testAlarm(sound: AlarmSound, volume: number): Promise<void> {
  return startAlarm(sound, volume, true, false);
}

/** Interrompe qualquer som em curso (inclusive loop) e libera as promessas pendentes. */
export function stopAlarm(): void {
  generation += 1;
  for (const id of liveTimers) window.clearTimeout(id);
  liveTimers.clear();
  for (const osc of liveOscillators) {
    try {
      osc.stop();
    } catch {
      /* já parado */
    }
    osc.disconnect();
  }
  liveOscillators.clear();
  for (const resolve of [...pendingResolvers]) resolve();
  pendingResolvers.clear();
}
