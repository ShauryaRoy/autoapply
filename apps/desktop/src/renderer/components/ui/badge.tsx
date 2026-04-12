import * as React from "react";
import { cn } from "./utils.js";

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "accent";

const toneClasses: Record<BadgeTone, string> = {
  neutral: "border-transparent bg-slate-100 text-slate-700",
  success: "border-transparent bg-emerald-100 text-emerald-700",
  warning: "border-transparent bg-amber-100 text-amber-700",
  danger: "border-transparent bg-rose-100 text-rose-700",
  accent: "border-transparent bg-sky-100 text-sky-700"
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
