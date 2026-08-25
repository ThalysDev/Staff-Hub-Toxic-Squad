interface ProgressBarProps {
  done: number;
  total: number;
  label?: string;
}

export default function ProgressBar({ done, total, label }: ProgressBarProps) {
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;

  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-label">
        {label ? `${label} — ` : ''}
        {done}/{total}
      </span>
    </div>
  );
}