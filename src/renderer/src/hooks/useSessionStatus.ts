import { useEffect, useState } from 'react';
import type { SessionStatus } from '@shared/ipc-types';

const INITIAL_STATUS: SessionStatus = {
  state: 'unknown',
  world: null,
  player: null,
  checkedAt: null,
};

/**
 * Status atual da sessão do jogo, sincronizado com o evento onSessionChanged.
 * O cleanup devolve o unsubscribe do evento e ignora atualizações após desmontagem.
 */
export function useSessionStatus(): SessionStatus {
  const [status, setStatus] = useState<SessionStatus>(INITIAL_STATUS);

  useEffect(() => {
    let cancelled = false;
    let latestFromEvent = false;

    const unsubscribe = window.staffhub.events.onSessionChanged((next) => {
      // Evento é sempre mais recente que o snapshot do invoke inicial.
      latestFromEvent = true;
      if (!cancelled) setStatus(next);
    });

    void window.staffhub.session
      .status()
      .then((current) => {
        if (!cancelled && !latestFromEvent) setStatus(current);
      })
      .catch(() => {
        // Status indisponível (ex.: ponte IPC ainda não respondeu); mantém "unknown".
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}