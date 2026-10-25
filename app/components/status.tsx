export function Spinner({ className = "size-4" }: { className?: string }) {
  return <span className={`alfred-spin inline-block rounded-full border-2 border-current border-r-transparent ${className}`} aria-hidden="true" />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`alfred-pulse rounded-lg bg-surface-2 ${className}`} aria-hidden="true" />;
}
