// useAuthStatus (v0.30) — sessão do SISTEMA no renderer: snapshot no mount +
// eventos auth:changed do main. Sem polls, sem loops: o main é quem empurra.
import { useEffect, useState } from 'react';
import type { AuthStatus } from '@shared/ipc-types';

const INICIAL: AuthStatus = { estado: 'verificando', user: null, offlineAte: null };

export function useAuthStatus(): AuthStatus {
  const [status, setStatus] = useState<AuthStatus>(INICIAL);

  useEffect(() => {
    let cancelado = false;
    let veioDoEvento = false;
    const unsubscribe = window.staffhub.events.onAuthChanged((next) => {
      veioDoEvento = true;
      if (!cancelado) setStatus(next);
    });
    void window.staffhub.auth
      .status()
      .then((atual) => {
        if (!cancelado && !veioDoEvento) setStatus(atual);
      })
      .catch(() => {
        if (!cancelado && !veioDoEvento) setStatus({ estado: 'deslogado', user: null, offlineAte: null });
      });
    return () => {
      cancelado = true;
      unsubscribe();
    };
  }, []);

  return status;
}
