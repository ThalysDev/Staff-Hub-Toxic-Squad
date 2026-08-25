import type { ReactNode } from 'react';

interface FieldProps {
  /** id do controle — conecta label/hint/erro ao input. */
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

/**
 * Rótulo + controle + hint/erro. O hint recebe id `{id}-hint` e o erro `{id}-error`
 * para a página ligar via aria-describedby no input.
 */
export default function Field({ id, label, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>
      )}
    </div>
  );
}
