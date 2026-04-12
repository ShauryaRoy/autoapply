# Frontend Control Layer

## Approval Flow

The control layer introduces a reusable pre-apply approval gate before queue submission.

- Component: apps/desktop/src/renderer/components/PreApplyApprovalDialog.tsx
- Integrated at dashboard level in apps/desktop/src/renderer/pages/Dashboard.tsx

Flow:

1. Parent prepares an approval draft payload (job score, decision, resume diff, answers preview, queue payload).
2. Dashboard renders PreApplyApprovalDialog when draft is provided.
3. Approve action calls addJobToQueue(payload).
4. Reject action closes/discards approval state.

Approval screen includes:

- confidence score and safe/risky labeling
- decision badge (APPLY, SKIP, RISKY)
- resume changes preview
- generated answers preview
- safety warning for low-confidence scenarios

## Retry Logic

Retry is implemented on Job Detail for failed outcomes.

- Location: apps/desktop/src/renderer/pages/JobDetail.tsx
- Trigger visible when status is FAILED or PARTIAL_SUCCESS

Behavior:

1. Attempt to reconstruct queue payload from existing result or retry payload fields.
2. Re-add job using addJobToQueue(...).
3. Preserve existing UI data and show action feedback.
4. Refresh live status after retry enqueue succeeds.

If required payload fields are missing, retry is blocked with a clear message.

## Action System

Job Detail now includes a dedicated Actions panel:

- Cancel
- Retry Job
- Copy answers

Cancel:

- confirmation prompt before action
- loading state while cancel request runs
- button disabled during cancel request

Retry:

- enabled only for FAILED or PARTIAL_SUCCESS
- loading state while retrying
- status message for success/failure

Copy answers:

- copies summary, why_role, strengths, and experience to clipboard
- shows success or fallback message

## UX Decisions

Design goals followed:

- clear calls to action
- low cognitive load
- safety-first guidance

Visual emphasis:

- confidence indicator with High, Medium, Low levels
- SAFE or RISKY labels
- warning message for low score or high missing-skill count
- explicit status feedback text (Applying, Completed, Failed at step)

## Status Feedback

Job Detail header now communicates runtime state clearly:

- Applying... while RUNNING
- Completed when SUCCESS
- Failed at: [step] when FAILED
- Partially completed for PARTIAL_SUCCESS
- Cancelled for CANCELLED

Failed step is inferred from execution timeline state.

## Edge Cases

Cancel during apply:

- cancel requires confirmation
- repeated clicks are prevented while cancelling
- status and action state remain synchronized with hook output

Retry after failure:

- supported for FAILED and PARTIAL_SUCCESS
- old diagnostics remain visible while retry is queued
- if payload reconstruction fails, user gets immediate guidance

Clipboard availability:

- copy answers uses Clipboard API
- failure path provides explicit feedback for restricted environments

Approval draft not present:

- dashboard remains unchanged
- approval dialog is fully optional and parent-driven

## Files Updated

- apps/desktop/src/renderer/components/PreApplyApprovalDialog.tsx
- apps/desktop/src/renderer/pages/Dashboard.tsx
- apps/desktop/src/renderer/pages/JobDetail.tsx
- docs/frontend_control_layer.md
