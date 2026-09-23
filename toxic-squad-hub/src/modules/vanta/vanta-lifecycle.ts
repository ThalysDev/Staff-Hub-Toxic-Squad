// Ciclo de vida das injeções de página da Suite Vanta.
// Correção do P1-4 da auditoria: o Vanta registrava setInterval/addEventListener
// soltos que acumulavam a cada re-render parcial (ajaxComplete). Aqui cada
// MÓDULO recebe um escopo rastreado — tudo que ele registra é descartável de
// uma vez (remount idempotente, troca de página, dispose global).

export interface ModuleScope {
  /** setInterval rastreado. */
  every(fn: () => void, ms: number): number;
  /** setTimeout rastreado (cancelado no dispose — evita callbacks órfãos). */
  after(fn: () => void, ms: number): number;
  /** Listener rastreado (document ou qualquer target). */
  on<K extends keyof HTMLElementEventMap>(
    target: Document | HTMLElement,
    type: K | string,
    fn: EventListener,
    opts?: AddEventListenerOptions,
  ): void;
  /** MutationObserver rastreado (já observando — o dispose desconecta). */
  observer(obs: MutationObserver): MutationObserver;
  /** Marca um nó raiz injetado para remoção no dispose (idempotente). */
  owns(node: HTMLElement): HTMLElement;
  /** Descarta TUDO que este escopo registrou. */
  dispose(): void;
}

export function createModuleScope(name: string): ModuleScope {
  const timers = new Set<number>();
  const listeners: Array<{
    target: Document | HTMLElement;
    type: string;
    fn: EventListener;
    opts: AddEventListenerOptions | undefined;
  }> = [];
  const observers = new Set<MutationObserver>();
  const nodes = new Set<HTMLElement>();
  let disposed = false;

  function assertLive(): void {
    if (disposed) throw new Error(`[toxic-squad-hub:${name}] escopo já descartado`);
  }

  return {
    every(fn, ms) {
      assertLive();
      const id = window.setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    after(fn, ms) {
      assertLive();
      const id = window.setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    on(target, type, fn, opts) {
      assertLive();
      target.addEventListener(type, fn, opts);
      listeners.push({ target, type, fn, opts });
    },
    observer(obs) {
      assertLive();
      observers.add(obs);
      return obs;
    },
    owns(node) {
      assertLive();
      nodes.add(node);
      return node;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      timers.forEach((id) => {
        window.clearInterval(id);
        window.clearTimeout(id);
      });
      timers.clear();
      listeners.forEach(({ target, type, fn, opts }) => target.removeEventListener(type, fn, opts));
      listeners.length = 0;
      observers.forEach((obs) => obs.disconnect());
      observers.clear();
      nodes.forEach((node) => node.remove());
      nodes.clear();
    },
  };
}
