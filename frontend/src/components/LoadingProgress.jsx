export default function LoadingProgress({ completed, total, label, details }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const active = completed < total;

  return (
    <div className="p-6 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-black-80">
          {label || "Loading"}
        </span>
        <span className="text-sm text-cool-grey">
          · {completed}/{total} queries
        </span>
      </div>
      {details && details.length > 0 && (
        <div className="text-sm text-cool-grey">
          {details.join(" · ")}
        </div>
      )}
      <div className="w-full max-w-md h-2 bg-black-10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${
            active ? "progress-shimmer" : "bg-digital-red"
          }`}
          style={{ width: `${Math.max(pct, active ? 5 : 0)}%` }}
        />
      </div>
    </div>
  );
}
