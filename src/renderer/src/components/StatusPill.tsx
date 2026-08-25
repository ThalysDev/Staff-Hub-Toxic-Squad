import type { SessionState } from '@shared/ipc-types';

interface StatusPillProps {
  state: SessionState;
}

const STATUS_META: Record<SessionState, { label: string; className: string }> = {
  'logged-in': { label: 'Sessão ativa', className: 'pill--ok' },
  'logged-out': { label: 'Sem sessão', className: 'pill--error' },
  'logging-in': { label: 'Fazendo login…', className: 'pill--info' },
  unknown: { label: 'Desconhecido', className: 'pill--muted' },
};

export default function StatusPill({ state }: StatusPillProps) {
  const meta = STATUS_META[state];
  return <span className={`pill ${meta.className}`}>{meta.label}</span>;
}