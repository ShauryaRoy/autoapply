import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Skeleton } from "../../../components/ui/skeleton.js";

type LiveAutomationPreviewProps = {
  previewUrl: string;
  status: string;
  loading: boolean;
};

export function LiveAutomationPreview({ previewUrl, status, loading }: LiveAutomationPreviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Live Automation Preview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-rose-400/80" />
            <span className="h-2 w-2 rounded-full bg-amber-400/80" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
            <p className="ml-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">Browser Session</p>
          </div>

          <div className="relative aspect-[16/9]">
            {loading && !previewUrl ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-[220px] w-full" />
              </div>
            ) : previewUrl ? (
              <img src={previewUrl} alt="Automation preview" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                Start an application run to stream the browser automation preview.
              </div>
            )}

            <div className="absolute bottom-3 left-3 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700">
              {status || "idle"}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
