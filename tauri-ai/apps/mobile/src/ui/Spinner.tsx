export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={
        className ??
        "h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80"
      }
    />
  );
}

