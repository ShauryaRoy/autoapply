import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Input } from "../../components/ui/input.js";

interface StepPreferencesProps {
  preferredRoles: string[];
  preferredLocations: Array<"remote" | "hybrid" | "onsite">;
  experienceLevel: "entry" | "mid" | "senior" | "lead" | "";
  salaryExpectation: string;
  onRolesChange: (roles: string[]) => void;
  onLocationsChange: (locations: Array<"remote" | "hybrid" | "onsite">) => void;
  onExperienceLevelChange: (level: "entry" | "mid" | "senior" | "lead" | "") => void;
  onSalaryChange: (value: string) => void;
}

const LOCATIONS: Array<{ value: "remote" | "hybrid" | "onsite"; label: string }> = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" }
];

const EXPERIENCE_LEVELS: Array<{ value: "entry" | "mid" | "senior" | "lead"; label: string }> = [
  { value: "entry", label: "Entry" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "lead", label: "Lead" }
];

export function StepPreferences({
  preferredRoles,
  preferredLocations,
  experienceLevel,
  salaryExpectation,
  onRolesChange,
  onLocationsChange,
  onExperienceLevelChange,
  onSalaryChange
}: StepPreferencesProps) {
  const [roleInput, setRoleInput] = useState("");

  const roleCount = useMemo(() => preferredRoles.length, [preferredRoles.length]);

  const addRole = () => {
    const normalized = roleInput.trim();
    if (!normalized) return;
    if (preferredRoles.includes(normalized)) {
      setRoleInput("");
      return;
    }
    onRolesChange([...preferredRoles, normalized]);
    setRoleInput("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Set Your Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="mb-2 text-sm font-medium text-slate-900">Preferred roles</p>
          <div className="flex gap-2">
            <Input
              value={roleInput}
              onChange={(event) => setRoleInput(event.target.value)}
              placeholder="Add a role and press Enter"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addRole();
                }
              }}
            />
            <Button type="button" size="sm" onClick={addRole}>
              Add
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {preferredRoles.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => onRolesChange(preferredRoles.filter((entry) => entry !== role))}
                className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
              >
                {role} ×
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">{roleCount} role(s) selected</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-900">Preferred locations</p>
          <div className="flex flex-wrap gap-2">
            {LOCATIONS.map((location) => {
              const active = preferredLocations.includes(location.value);
              return (
                <Button
                  key={location.value}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "ghost"}
                  onClick={() => {
                    if (active) {
                      onLocationsChange(preferredLocations.filter((value) => value !== location.value));
                    } else {
                      onLocationsChange([...preferredLocations, location.value]);
                    }
                  }}
                >
                  {location.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-900">Experience level</p>
          <div className="flex flex-wrap gap-2">
            {EXPERIENCE_LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                onClick={() => onExperienceLevelChange(level.value)}
                className={
                  experienceLevel === level.value
                    ? "rounded-lg border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs text-white"
                    : "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                }
              >
                {level.label}
              </button>
            ))}
          </div>
          {!experienceLevel ? <p className="mt-1 text-xs text-amber-700">Select one experience level to continue.</p> : null}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-900">Salary expectation (optional)</p>
          <Input
            value={salaryExpectation}
            onChange={(event) => onSalaryChange(event.target.value)}
            placeholder="e.g. 120k-140k USD"
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Badge tone="neutral">Tip</Badge>
          Keep this short. You can refine preferences later.
        </div>
      </CardContent>
    </Card>
  );
}
