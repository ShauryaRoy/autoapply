import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Badge } from "./badge.js";

type Toast = {
  id: string;
  title: string;
  description: string;
  tone: "success" | "danger" | "accent";
};

const TOAST_TIMEOUT = 2500;

const ToastContext = React.createContext<{
  pushToast: (toast: Omit<Toast, "id">) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const pushToast = React.useCallback((toast: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, TOAST_TIMEOUT);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] space-y-2">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="pointer-events-auto w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">{toast.title}</p>
                <Badge tone={toast.tone}>status</Badge>
              </div>
              <p className="text-xs text-slate-600">{toast.description}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
