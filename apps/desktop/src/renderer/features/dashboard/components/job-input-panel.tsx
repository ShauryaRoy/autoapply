import { Search, Sparkles, Link as LinkIcon } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import { ROLE_SUGGESTIONS } from "../data.js";

type JobInputPanelProps = {
  jobUrl: string;
  targetRole: string;
  loading: boolean;
  hasApplication: boolean;
  error: string;
  onJobUrlChange: (value: string) => void;
  onTargetRoleChange: (value: string) => void;
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
  loading,
  hasApplication,
  error,
  onJobUrlChange,
  onTargetRoleChange,
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
