import { AnimatePresence, motion } from "framer-motion";
import { Circle, CircleCheckBig, LoaderCircle, Sparkles, FileSearch, BrainCircuit, FilePenLine, Send, Rocket } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import type { PipelineStep } from "../types.js";

const stepIconMap: Record<string, LucideIcon> = {
  queued: Circle,
  job_scraped: FileSearch,
  job_analyzed: BrainCircuit,
  resume_optimized: FilePenLine,
  answers_generated: Sparkles,
  form_filled: Rocket,
  submitted: Send
};

type PipelineStepperProps = {
  steps: PipelineStep[];
};

export function PipelineStepper({ steps }: PipelineStepperProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Application Pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
          {steps.map((step, index) => {
            const Icon = stepIconMap[step.id] ?? Circle;
            const stateClass =
              step.state === "completed"
                ? "border-emerald-200 bg-emerald-50"
                : step.state === "active"
                  ? "border-slate-300 bg-slate-100"
                  : "border-slate-200 bg-white";

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
                className={`relative overflow-hidden rounded-xl border p-3 ${stateClass}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <Icon size={16} className="text-slate-600" />
                  {step.state === "completed" ? (
                    <CircleCheckBig size={15} className="text-emerald-600" />
                  ) : step.state === "active" ? (
                    <LoaderCircle size={15} className="animate-spin text-slate-700" />
                  ) : null}
                </div>
                <p className="text-xs font-medium capitalize text-slate-700">{step.label}</p>
                <p className="mt-1 text-[11px] uppercase tracking-wider text-slate-500">{step.state}</p>

                <AnimatePresence>
                  {step.state === "active" ? (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 rounded-xl border border-slate-300"
                    />
                  ) : null}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
