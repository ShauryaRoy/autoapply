import { cn } from "./utils.js";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-slate-200", className)} />;
}
