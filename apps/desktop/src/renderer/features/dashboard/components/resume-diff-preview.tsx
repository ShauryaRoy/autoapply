import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import type { ResumeDiffLine } from "../types.js";

type ResumeDiffPreviewProps = {
  lines: ResumeDiffLine[];
};

export function ResumeDiffPreview({ lines }: ResumeDiffPreviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Resume Changes Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {lines.map((line, idx) => (
          <article key={`${line.before}-${idx}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-rose-700">- {line.before}</p>
            <p className="mt-2 text-xs text-emerald-700">+ {line.after}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {line.injectedKeywords.map((keyword) => (
                <span key={keyword} className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] uppercase tracking-widest text-slate-700">
                  {keyword}
                </span>
              ))}
            </div>
          </article>
        ))}
      </CardContent>
    </Card>
  );
}
