import { Search, Sparkles, Link as LinkIcon } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import { ROLE_SUGGESTIONS } from "../data.js";

type ApplyMode = "assist" | "smart_auto" | "full_auto";

type JobInputPanelProps = {
  jobUrl: string;
  targetRole: string;
  applyMode: ApplyMode;
  autoSubmit: boolean;
  pauseOnLowConfidence: boolean;
  pauseOnLongAnswers: boolean;
  loading: boolean;
  hasApplication: boolean;
  error: string;
  onJobUrlChange: (value: string) => void;
  onTargetRoleChange: (value: string) => void;
  onApplyModeChange: (value: ApplyMode) => void;
  onAutoSubmitChange: (value: boolean) => void;
  onPauseOnLowConfidenceChange: (value: boolean) => void;
  onPauseOnLongAnswersChange: (value: boolean) => void;
  onSubmit: () => void;
};

function isLikelyUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol.startsWith("http") && !!parsed.hostname;
  } catch {
    return false;
  }
}

export function JobInputPanel({
  jobUrl,
  targetRole,
  applyMode,
  autoSubmit,
  pauseOnLowConfidence,
  pauseOnLongAnswers,
  loading,
  hasApplication,
  error,
  onJobUrlChange,
  onTargetRoleChange,
  onApplyModeChange,
  onAutoSubmitChange,
  onPauseOnLowConfidenceChange,
  onPauseOnLongAnswersChange,
  onSubmit
}: JobInputPanelProps) {
  const isUrlValid = isLikelyUrl(jobUrl);

  return (
    <Card className="p-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl font-semibold">
          <Sparkles size={16} className="text-slate-900" />
          Job Input
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm text-slate-500">Job URL</label>
          <div className="relative">
            <LinkIcon size={15} className="pointer-events-none absolute left-3 top-3.5 text-slate-400" />
            <Input
              className="pl-9"
              value={jobUrl}
              disabled={loading || hasApplication}
              placeholder="https://boards.greenhouse.io/..."
              onChange={(e) => onJobUrlChange(e.target.value)}
            />
          </div>
          {jobUrl && !isUrlValid ? (
            <p className="text-xs text-rose-600">Enter a valid job posting URL.</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm text-slate-500">Target Role</label>
          <Input
            list="role-suggestions"
            value={targetRole}
            disabled={loading || hasApplication}
            placeholder="Senior Frontend Engineer"
            onChange={(e) => onTargetRoleChange(e.target.value)}
          />
          <datalist id="role-suggestions">
            {ROLE_SUGGESTIONS.map((role) => (
              <option key={role} value={role} />
            ))}
          </datalist>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Execution Mode</p>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="apply-mode"
              checked={applyMode === "assist"}
              onChange={() => onApplyModeChange("assist")}
              disabled={loading || hasApplication}
            />
            Assist
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="apply-mode"
              checked={applyMode === "smart_auto"}
              onChange={() => onApplyModeChange("smart_auto")}
              disabled={loading || hasApplication}
            />
            Smart Auto
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="apply-mode"
              checked={applyMode === "full_auto"}
              onChange={() => onApplyModeChange("full_auto")}
              disabled={loading || hasApplication}
            />
            Full Auto
          </label>

          <div className="space-y-2 border-t border-slate-200 pt-2">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={autoSubmit}
                onChange={(event) => onAutoSubmitChange(event.target.checked)}
                disabled={loading || hasApplication}
              />
              Auto submit after fill
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={pauseOnLowConfidence}
                onChange={(event) => onPauseOnLowConfidenceChange(event.target.checked)}
                disabled={loading || hasApplication}
              />
              Pause on low confidence
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={pauseOnLongAnswers}
                onChange={(event) => onPauseOnLongAnswersChange(event.target.checked)}
                disabled={loading || hasApplication}
              />
              Pause on long answers
            </label>
          </div>

          <p className="text-[11px] text-slate-500">
            {applyMode === "assist"
              ? "Assist mode keeps full review UI before fill."
              : applyMode === "smart_auto"
                ? "Smart Auto runs silently until a safety fallback requires review."
                : "Full Auto minimizes review interruptions and relies on safety stops + logs."}
          </p>
        </div>

        {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p> : null}

        <motion.div whileHover={{ y: -1 }} whileTap={{ scale: 0.99 }}>
          <Button
            size="lg"
            variant="default"
            className="w-full"
            onClick={onSubmit}
            disabled={loading || hasApplication || !isUrlValid || !targetRole.trim()}
          >
            <Search size={16} className="mr-2" />
            {loading ? "Launching automation..." : "Analyze and Start Applying"}
          </Button>
        </motion.div>
      </CardContent>
    </Card>
  );
}
