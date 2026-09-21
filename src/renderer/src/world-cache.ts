// Cache do dump de aldeias (world:villages) no RENDERER — singleton de módulo
// (mesmo padrão do cache do OpMapSection, que continua com o dele). Antes, cada
// página keep-mounted (SG_1/SG_3/SG_4/Planner/Pós-OP/Evolução) mantinha o SEU
// clone de 7k vilas vivo na sessão; agora todos compartilham a MESMA array.
//
// Contrato:
//  - getWorldVillages(): dedup chamadas concorrentes (uma só IPC em voo) e
//    devolve a array cacheada quando o MUNDO ativo é o mesmo (lido pela mesma
//    fonte das páginas: session:status). Fetch falho não popula o cache —
//    a próxima chamada tenta de novo.
//  - invalidateWorldVillages(): chamado após world:refresh() completar —
//    o dump mudou no main, a cópia daqui está velha. Não há evento do bridge
//    para world:refresh (preload), então os handlers que refresham chamam
//    isto (Sg1 "Atualizar dados do mundo", SG_4/Pós-OP no ensure antes do uso).
// O cache morre com o app (as páginas são keep-mounted por design).

import type { WorldVillage } from '@shared/types';

let cache: { world: string | null; villages: WorldVillage[] } | null = null;
let inflight: Promise<WorldVillage[]> | null = null;
let inflightWorld: string | null = null;

/** Mundo ativo pela MESMA fonte das páginas (useSessionStatus assina o evento;
 *  aqui vale o snapshot do invoke — mudou de mundo, o cache erra e refaz). */
async function currentWorld(): Promise<string | null> {
  try {
    const status = await window.staffhub.session.status();
    return status.world;
  } catch {
    return null;
  }
}

export async function getWorldVillages(): Promise<WorldVillage[]> {
  const world = await currentWorld();
  if (cache !== null && cache.world === world) return cache.villages;
  // O voo em curso vale SÓ para o mundo dele (P3 da revisão 1 da 0.36: troca
  // de mundo durante um fetch devolveria as aldeias do mundo VELHO ao
  // consumidor novo).
  if (inflight !== null && inflightWorld === world) return inflight;
  inflightWorld = world;
  inflight = (async () => {
    try {
      const villages = await window.staffhub.world.villages();
      cache = { world, villages };
      return villages;
    } finally {
      inflight = null;
      inflightWorld = null;
    }
  })();
  return inflight;
}

export function invalidateWorldVillages(): void {
  cache = null;
}
