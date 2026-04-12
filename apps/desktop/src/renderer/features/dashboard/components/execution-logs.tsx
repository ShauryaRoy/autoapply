import { CheckCircle2, AlertCircle, LoaderCircle, OctagonAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import type { DashboardLog } from "../types.js";

const iconByStatus = {
  success: CheckCircle2,
  running: LoaderCircle,
  warning: AlertCircle,
  error: OctagonAlert
};

type ExecutionLogsProps = {
  logs: DashboardLog[];
};

export function ExecutionLogs({ logs }: ExecutionLogsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Execution Logs</CardTitle>
      </CardHeader>
      <CardContent className="max-h-[320px] overflow-auto pr-1">
        {!logs.length ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            No logs yet. Launch an application to stream events.
          </p>
        ) : (
          <ul className="space-y-2">
            {logs.map((log) => {
              const Icon = iconByStatus[log.status];
              return (
                <li key={log.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className={log.status === "running" ? "animate-spin text-slate-700" : "text-slate-500"} />
                    <p className="text-xs text-slate-500">{log.timestamp}</p>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{log.action}</p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
