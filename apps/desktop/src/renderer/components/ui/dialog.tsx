import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "./utils.js";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function Dialog({ open, onOpenChange, title, children, footer }: DialogProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        >
          <motion.section
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={cn(
              "w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-6 text-slate-900 shadow-lg"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{title}</h2>
              <button
                className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                onClick={() => onOpenChange(false)}
                aria-label="Close dialog"
              >
                ×
              </button>
            </header>
            <div className="space-y-4">{children}</div>
            {footer ? <footer className="mt-6 flex justify-end gap-3">{footer}</footer> : null}
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
