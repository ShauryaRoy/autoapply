# UI Redesign - SaaS Refresh

## Design System Used

- Background: `#F8FAFC`
- Card Surface: `#FFFFFF`
- Primary: `#111827`
- Secondary Text: `#6B7280`
- Border: `#E5E7EB`

Component standards:

- Cards: `rounded-xl border border-slate-200 bg-white shadow-sm p-4/p-6`
- Buttons:
  - Primary: dark fill (`bg-slate-900 text-white`)
  - Secondary: outline (`border border-slate-200 bg-white`)
- Inputs: `rounded-lg border-slate-300 focus:ring-2 focus:ring-black`
- Badges: `rounded-full px-3 py-1 text-xs` with subtle semantic backgrounds

Typography standards:

- Page title: `text-xl font-semibold`
- Section title: `text-lg`
- Labels/helper text: `text-sm text-slate-500`

## Before vs After

Before:

- dark shells and gradient-heavy backgrounds
- glow/frosted cards and high-contrast neon accents
- mixed component hierarchy across pages
- inconsistent status chips and controls

After:

- light SaaS shell with white cards on slate background
- consistent card, button, input, and badge patterns
- reduced visual noise (no gradients/glows/heavy shadows)
- clearer content hierarchy and spacing-first layout

## Component Structure

Global primitives updated:

- `apps/desktop/src/renderer/components/ui/button.tsx`
- `apps/desktop/src/renderer/components/ui/card.tsx`
- `apps/desktop/src/renderer/components/ui/input.tsx`
- `apps/desktop/src/renderer/components/ui/badge.tsx`
- `apps/desktop/src/renderer/components/ui/dialog.tsx`
- `apps/desktop/src/renderer/components/ui/toast.tsx`
- `apps/desktop/src/renderer/components/ui/skeleton.tsx`

Shell and navigation:

- `apps/desktop/src/renderer/layouts/dashboard-layout.tsx`
- `apps/desktop/src/renderer/features/dashboard/components/dashboard-sidebar.tsx`

Page-level surfaces updated:

- Apply: job input, pipeline, intelligence, resume diff, logs, preview, approval modal
- Jobs dashboard cards/list and metric cards
- Job detail tracker sections (overview, resume, answers, logs)
- Onboarding (all 3 steps and progress shell)
- Profile overview rail in app shell
- Legacy token layer in `styles.css` to align old class-based surfaces

## Layout Decisions

- Standardized shell uses constrained width (`max-w-6xl`) and centered content
- Main dashboard grid preserves sidebar + navigation structure
- Apply page keeps requested split:
  - Left: Job Input card + run controls
  - Right: Pipeline on top, then intelligence/resume cards in a 2-column grid
- Spacing first: increased gaps (`gap-6`) and removed extra decorative borders

## Reusable UI Patterns

- Primary action pattern: dark CTA + secondary outline actions
- Status communication: semantic badges (`success`, `warning`, `danger`, `accent`)
- Data section pattern: `Card` + `CardHeader` + `CardContent`
- Empty state pattern: dashed card with concise action copy and one CTA
- Error pattern: subtle red panel (`border-rose-200 bg-rose-50 text-rose-700`)
- Progress pattern: neutral track + single-color fill without glow

## Notes

- Existing sidebar information architecture and navigation handlers were preserved.
- Functional behavior and API calls were not altered; only visual layer and layout classes were refactored.
