import { useMemo, useRef } from "react";

import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Skeleton } from "../../components/ui/skeleton.js";

interface StepResumeUploadProps {
  fileName: string;
  fileSize: number;
  uploadProgress: number;
  isUploading: boolean;
  error: string | null;
  onSelectFile: (file: File) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function StepResumeUpload({
  fileName,
  fileSize,
  uploadProgress,
  isUploading,
  error,
  onSelectFile
}: StepResumeUploadProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasFile = useMemo(() => Boolean(fileName), [fileName]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Upload Your Resume</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">Start with your latest resume to auto-personalize your first application.</p>

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) onSelectFile(file);
          }}
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center transition hover:border-slate-500 hover:bg-white"
        >
          <p className="text-sm font-medium text-slate-900">Drag and drop resume here</p>
          <p className="mt-1 text-xs text-slate-500">PDF or DOCX</p>
          <Button type="button" size="sm" variant="ghost" className="mt-4">
            Choose file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onSelectFile(file);
            }}
          />
        </div>

        {hasFile ? (
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wider text-slate-500">File Preview</p>
            <p className="mt-1 text-sm font-medium text-slate-900">{fileName}</p>
            <p className="text-xs text-slate-500">{formatFileSize(fileSize)}</p>

            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{isUploading ? "Uploading..." : "Upload complete"}</span>
                <span>{Math.round(uploadProgress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-slate-900 transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          </div>
        ) : null}

        {isUploading ? <Skeleton className="h-10 w-full" /> : null}
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
