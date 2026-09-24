// Registro da Suite Vanta: cada módulo se autoregistra (padrão do Toxic Squad
// Hub) com um launcher; o painel "Suite Vanta" lista os launchers por grupo
// (Defesa / Blindagem / Utilidades, como no painel original do Vanta) e o
// bootstrap da suíte monta os módulos cuja tela casa (ou que foram abertos
// via flag de navegação, como o "Abrir" do Vanta fazia).

import { gm } from '../../core/storage';
import type { IconName } from '../../core/icons';
import { ensureDocumentTheme } from '../../core/theme';
import { createModuleScope, type ModuleScope } from './vanta-lifecycle';

export type VantaGroup = 'defesa' | 'blindagem' | 'utilidades';

export interface VantaLauncher {
  id: string;
  label: string;
  desc: string;
  group: VantaGroup;
  /** Ícone próprio da ferramenta (Onda C/D); ausente = ícone do grupo. */
  icon?: IconName;
  /** Injeção da UI na página atual. Deve ser idempotente (chamada 2× = 1 UI). */
  mount(scope: ModuleScope): void;
  /** Esta URL (relativa ao jogo) exibe a tela do módulo? null = qualquer tela. */
  match(): boolean;
  /** URL para navegar quando o launcher é acionado fora da tela certa. */
  url(): string;
  /** Url caseira já na tela certa (o launcher monta sem navegar)? */
}

const launchers = new Map<string, VantaLauncher>();
const scopes = new Map<string, ModuleScope>();

export function registerVanta(launcher: VantaLauncher): void {
  launchers.set(launcher.id, launcher);
}

export function vantaLaunchers(): VantaLauncher[] {
  return [...launchers.values()];
}

const GROUP_LABELS: Record<VantaGroup, string> = {
  defesa: 'Defesa',
  blindagem: 'Blindagem',
  utilidades: 'Utilidades',
};

export function groupLabel(group: VantaGroup): string {
  return GROUP_LABELS[group];
}

/** Módulo habilitado? (default: ligado, como no Vanta). */
export function isVantaEnabled(id: string): boolean {
  return gm.get<boolean>(`tsh-vanta:mod:${id}`, true);
}

export function setVantaEnabled(id: string, enabled: boolean): void {
  gm.set(`tsh-vanta:mod:${id}`, enabled);
  if (!enabled) unmountVanta(id);
}

/** Desmonta um módulo (remove UI, limpa timers/listeners/observers). */
export function unmountVanta(id: string): void {
  scopes.get(id)?.dispose();
  scopes.delete(id);
}

/** Monta um módulo: descarta o escopo anterior e cria um novo (remount limpo). */
export function mountVanta(id: string): { ok: boolean; error?: string } {
  const launcher = launchers.get(id);
  if (launcher === undefined) return { ok: false, error: 'módulo desconhecido' };
  unmountVanta(id);
  // Onda D: o tema único (--shs-*) precisa existir no documento do jogo,
  // onde as ferramentas Vanta são injetadas (fora do Shadow DOM).
  ensureDocumentTheme();
  const scope = createModuleScope(id);
  scopes.set(id, scope);
  try {
    launcher.mount(scope);
    return { ok: true };
  } catch (error) {
    scope.dispose();
    scopes.delete(id);
    console.warn(`[toxic-squad-hub] falha ao montar módulo ${id}:`, error);
    // Onda C: o motivo chega à linha do painel (antes só no console).
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Acionamento pelo painel: na tela certa monta direto; senão grava a flag e
 * navega (o bootstrap da próxima página monta ao chegar).
 */
export function launchVanta(id: string): void {
  const launcher = launchers.get(id);
  if (launcher === undefined) return;
  if (launcher.match()) {
    mountVanta(id);
    return;
  }
  try {
    sessionStorage.setItem(`tsh-vanta:open:${id}`, '1');
  } catch {
    /* sessionStorage indisponível — segue só com a navegação */
  }
  window.location.href = launcher.url();
}

function consumeOpenFlag(id: string): boolean {
  const key = `tsh-vanta:open:${id}`;
  try {
    if (sessionStorage.getItem(key) === '1') {
      sessionStorage.removeItem(key);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Bootstrap da suíte (1× por carregamento de página): monta cada módulo
 * habilitado SÓ na tela dele. A flag de abertura é consumida (limpa), mas não
 * monta sozinha: antes ela montava em QUALQUER tela que carregasse depois do
 * "Abrir" (redirecionamento do jogo, sub-tela diferente — ex.: a confirmação
 * do cravado aparecia na Praça comum).
 */
export function runVantaOnLoad(): void {
  for (const launcher of launchers.values()) {
    consumeOpenFlag(launcher.id);
    if (!isVantaEnabled(launcher.id)) continue;
    if (launcher.match()) mountVanta(launcher.id);
  }
}
