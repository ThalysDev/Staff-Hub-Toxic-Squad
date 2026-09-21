// Sala de Guerra · Planner de OP em Massa — WORKER (v0.36).
// A engine pura (@shared/mass-planner-engine, sem relógio/rede/DOM) rodava
// SÍNCRONA na thread do renderer: na OP "mundo inteiro" da staff (11,9M pares)
// a ordenação congelava a UI por 1-4 minutos ("Not Responding"). Aqui ela roda
// num Web Worker: recebe {grupos + contexto do mundo} por postMessage (o
// structured clone cobre os Maps do contexto), executa generateMassPlan e
// devolve o plano (objetos planos — clonável). Durante a geração o worker
// posta progresso de pares avaliados (~500k em ~500k) e o app segue VIVO.
//
// Ciclo de vida: UM worker POR GERAÇÃO — o caller encerra com terminate()
// assim que chega a resposta (ou o erro); sem estado para limpar entre OPs.

import { generateMassPlan } from '@shared/mass-planner-engine';
import type { MassGroupConfig, MassPlanContext, MassPlanResult } from '@shared/mass-planner-types';

/** Pedido do renderer (postMessage do caller). */
export interface MassPlannerWorkerRequest {
  /** Identifica a geração (o caller ignora mensagens de pedidos antigos). */
  requestId: number;
  groups: MassGroupConfig[];
  context: MassPlanContext;
}

/** Resposta do worker: sinal de vida, resultado ou falha (mensagem PT-BR). */
export type MassPlannerWorkerResponse =
  | { kind: 'progress'; requestId: number; evaluatedPairs: number }
  | { kind: 'ok'; requestId: number; result: MassPlanResult }
  | { kind: 'error'; requestId: number; message: string };

/** Superfície mínima do DedicatedWorkerGlobalScope: o tsconfig.web usa a lib
 *  DOM (que tipa `self` como Window) — este cast local evita puxar a lib
 *  "webworker" inteira só para o worker. */
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MassPlannerWorkerRequest>) => void) | null;
  postMessage(message: MassPlannerWorkerResponse): void;
};

workerScope.onmessage = (event) => {
  const { requestId, groups, context } = event.data;
  try {
    const result = generateMassPlan(groups, context, (evaluatedPairs) => {
      workerScope.postMessage({ kind: 'progress', requestId, evaluatedPairs });
    });
    workerScope.postMessage({ kind: 'ok', requestId, result });
  } catch (error) {
    workerScope.postMessage({
      kind: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
