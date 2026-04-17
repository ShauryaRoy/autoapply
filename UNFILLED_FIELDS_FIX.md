# Fix: No Unresolved Field Should Ever Disappear from the Pipeline

**File changed:** `apps/desktop/src/renderer/features/dashboard/components/live-automation-preview.tsx`  
**Date:** April 2026

---

## Problem

Some form fields were being silently dropped — they failed auto-fill but also never reached the User Input Panel. Users had no chance to answer them and the system never learned those answers.

There were **four distinct drop points** in the pipeline.

---

## Root Causes & Fixes

### Bug 1 — `fillForm()` Pass 2: Fields with no label were silently skipped

**Before:**
```js
if (!val) {
  if (label && label.length >= 3) {   // ← DROP if label is short/missing
    unfilled.push({ label, ... });
  }
  continue;
}
```

**After:**
```js
if (!val) {
  // Always push — use fallback label so the user can still fill the field
  var effectiveLbl = (label && label.length >= 3) ? label : ("Field " + (unfilled.length + 1));
  unfilled.push({ label: effectiveLbl, selector: sel, fieldType: ft, options: fo, autoValue: "" });
  continue;
}
```

**Why this mattered:** Any input/textarea/select that had no detected label was completely invisible to the user, even if it was required by the job board.

---

### Bug 2 — `fillForm()` Pass 2: SELECT fill failures with short/missing labels were dropped

**Before:**
```js
if (el.tagName === "SELECT") {
  if (fillSel(el, val)) filled++;
  else if (label && label.length >= 3) {   // ← DROP if label is short/missing
    unfilled.push({ label, selector, fieldType: "select", options: fo2 });
  }
}
```

**After:**
```js
if (el.tagName === "SELECT") {
  var fo2 = Array.from(el.options).map(...);
  if (fillSel(el, val)) filled++;
  else {
    // Always push with fallback label — include the autoValue so user sees the suggested answer
    var fo2label = (label && label.length >= 3) ? label : ("Field " + (unfilled.length + 1));
    unfilled.push({ label: fo2label, selector, fieldType: "select", options: fo2, autoValue: val });
  }
}
```

**Why this mattered:** A `<select>` whose value couldn't be matched (wrong option text) AND had no label was dropped silently. The `autoValue` is now preserved so the user can see what was attempted.

---

### Bug 3 — `handleSaveAndApply()`: Failed fields were cleared from the panel regardless

**Before:**
```js
await applyUserAnswersToForm(toApply);
setUnfilledFields((prev) => prev.filter((f) => !toApply[f.selector]));
// ↑ Removes ALL submitted fields, even ones that still failed
```

**After:**
```js
const failedOnSave = await applyUserAnswersToForm(toApply);
setUnfilledFields((prev) => prev.filter(
  (f) => !toApply[f.selector] || failedOnSave.has(f.selector)
  //                              ↑ Keep failed fields IN the panel
));
if (failedOnSave.size > 0) {
  setStatus(`Applied ${ok} answer(s). ${failedOnSave.size} field(s) could not be filled — please try again.`);
}
```

**Why this mattered:** If a field answer failed to apply (e.g. a dropdown didn't match), it was removed from the panel anyway. User thought it was filled, but it wasn't.

---

### Bug 4 — Missing debug logging

Added `[Unfilled Fields Debug]` at the end of the webview `fillForm()` script:

```js
console.log("[Unfilled Fields Debug]", JSON.stringify({
  totalDetected: unfilled.length,
  afterDedup: deduped.length,
  autoAnswerCount: deduped.filter(f => !!f.autoValue).length,
  noAnswerCount: deduped.filter(f => !f.autoValue).length,
  fieldLabels: deduped.map(f => f.label),
  filled: filled
}));
```

And `[AutoApply:runLoop]` after `needsInput` is built in `runAutoModeSequence`:

```js
console.log("[AutoApply:runLoop] needsInput breakdown:", {
  totalEnriched,
  noAutoValue,
  failedAutoValue,
  finalNeedsInput
});
```

---

## How No Field Is Ever Lost

The pipeline now guarantees:

```
fillForm()
  → ALL detected fields → unfilled[] (with fallback labels)
  → deduped by selector (not label)
  → returned as unfilled[]

enrichUnfilledWithOptions()
  → adds dropdown options per field

autoApply (fields with autoValue)
  → attempts selection
  → failedSelectors = Set of selectors that didn't work

needsInput = fields with no autoValue  ∪  fields whose autoValue failed
  → shown in User Input Panel

handleSaveAndApply()
  → applies user answers
  → fields that STILL fail remain in the panel (not silently cleared)
  → user sees status message about remaining failures
```

### Decision Table

| Field state | Outcome |
|---|---|
| Auto-filled successfully | Removed from pipeline ✓ |
| Has `autoValue`, auto-apply succeeded | Removed from pipeline ✓ |
| Has `autoValue`, auto-apply **failed** | Stays in panel, `autoValue` pre-populated ✓ |
| No `autoValue`, has label | In panel ✓ |
| No `autoValue`, **no label** | In panel with fallback label `"Field N"` ✓ |
| SELECT fill failed, has label | In panel with `autoValue` set to attempted value ✓ |
| SELECT fill failed, **no label** | In panel with fallback label ✓ |
| User submits answer, apply fails | Stays in panel, user sees error count ✓ |

---

## Validation

A form with 5 fields where 2 auto-fill, 2 dropdowns fail, and 1 is unknown:

- **Before fix:** Panel may show 0–1 fields (most dropped silently)
- **After fix:** Panel shows exactly 3 fields (all unresolved ones)
