import { useMemo } from "react";

import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { useOnboardingStore } from "../../hooks/useOnboardingStore.js";
import { StepFirstApply } from "./StepFirstApply.js";
import { StepPreferences } from "./StepPreferences.js";
import { StepResumeUpload } from "./StepResumeUpload.js";

const STEPS = [
  { id: 1, label: "Resume Upload" },
  { id: 2, label: "Preferences" },
  { id: 3, label: "First Apply" }
] as const;

export function OnboardingLayout() {
  const store = useOnboardingStore();

  const stepProgress = useMemo(() => {
    return ((store.step - 1) / (STEPS.length - 1)) * 100;
  }, [store.step]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="relative mx-auto w-full max-w-6xl px-4 py-8 md:px-6">
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-xl">Welcome to AutoApply</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-500">Fast setup: upload resume, set preferences, launch your first application.</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Step {store.step} of {STEPS.length}</span>
                <span>{Math.round(stepProgress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-slate-900 transition-all duration-300" style={{ width: `${stepProgress}%` }} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {STEPS.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => {
                      if (step.id <= store.step) {
                        store.setStep(step.id);
                      }
                    }}
                    className={
                      step.id === store.step
                        ? "rounded-lg border border-slate-900 bg-slate-900 px-2 py-1.5 text-xs text-white"
                        : step.id < store.step
                          ? "rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700"
                          : "rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500"
                    }
                  >
                    {step.label}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {store.step === 1 ? (
          <StepResumeUpload
            fileName={store.resume.fileName}
            fileSize={store.resume.fileSize}
            uploadProgress={store.resume.uploadProgress}
            isUploading={store.resume.isUploading}
            error={store.resume.error}
            onSelectFile={(file) => {
              void store.uploadResumeFile(file);
            }}
          />
        ) : null}

        {store.step === 2 ? (
          <StepPreferences
            preferredRoles={store.preferences.preferredRoles}
            preferredLocations={store.preferences.preferredLocations}
            experienceLevel={store.preferences.experienceLevel}
            salaryExpectation={store.preferences.salaryExpectation}
            onRolesChange={store.setPreferredRoles}
            onLocationsChange={store.setPreferredLocations}
            onExperienceLevelChange={store.setExperienceLevel}
            onSalaryChange={store.setSalaryExpectation}
          />
        ) : null}

        {store.step === 3 ? <StepFirstApply store={store} onSkip={store.goBack} /> : null}

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" disabled={!store.canGoBack} onClick={store.goBack}>
            Back
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={!store.canGoNext || store.step >= 3}
            onClick={store.goNext}
          >
            Next
          </Button>
        </div>
      </main>
    </div>
  );
}
