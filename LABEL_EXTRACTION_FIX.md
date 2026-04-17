# Fix: Robust Label Extraction for User Input Panel

**File changed:** `apps/desktop/src/renderer/features/dashboard/components/live-automation-preview.tsx`  
**Date:** April 2026

---

## Problem

The User Input Panel was showing generic fallback names like `Field 3`, `Field 5`, `Dropdown 7` instead of human-readable question labels like `"Are you open to relocation?"` or `"What is your notice period?"`.

This happened because the old `getLabel()` function only checked four simple sources and gave up early on any miss.

---

## Root Cause — Old `getLabel` hierarchy (too shallow)

```js
var getLabel = function(el, doc) {
  var al = el.getAttribute("aria-label");        // 1. aria-label
  if (id) { doc.querySelector("label[for=id]") } // 2. <label for=id>
  el.closest("label")                             // 3. parent <label>
  el.closest("fieldset legend")                   // 4. fieldset legend
  return el.placeholder || el.name || el.id;      // 5. last resort
};
```

Missing entirely:
- `aria-labelledby` (Workday, Ashby, Greenhouse all use this)
- Parent sibling text nodes (question text next to an `<input>`)
- DOM climb (label is a cousin element 2-3 levels up)
- Label cleaning (asterisks, collapsed whitespace)

---

## Fix — Two new functions: `cleanLabel` + `getBestLabel`

### `cleanLabel(raw)`

Strips asterisks/bullets, collapses whitespace, trims:

```js
var cleanLabel = function(raw) {
  return String(raw)
    .replace(/[*•]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
};
```

### `getBestLabel(el, doc)` — 9-level fallback hierarchy

| Priority | Source | Why it matters |
|---|---|---|
| 1 | `aria-label` attribute | Direct, highest confidence |
| 2 | `aria-labelledby` → `getElementById` | Workday, Greenhouse, Ashby all use this pattern |
| 3 | `<label for=id>` (clone + strip children) | Standard HTML forms |
| 4 | Closest `<label>` wrapper (clone + strip) | Wrapped inputs |
| 5 | Closest `<fieldset><legend>` | Radio/checkbox groups |
| 6 | Parent sibling text nodes before the input | ATS layouts with inline question text |
| 7 | Walk up DOM 4 levels | Deeply nested inputs where label is a cousin |
| 8 | `placeholder` attribute | Last meaningful hint |
| 9 | `name` attribute (underscores → spaces) | Last resort — better than "Field N" |

---

## Key Additions Explained

### `aria-labelledby` (Priority 2)

```js
var labelledBy = el.getAttribute("aria-labelledby");
var ids = labelledBy.trim().split(/\s+/);
var parts = [];
for each id: ref = doc.getElementById(id); parts.push(ref.innerText);
return cleanLabel(parts.join(" "));
```

Many ATS systems (Workday in particular) render the question text in a separate `<span id="q-123">` and then link the input with `aria-labelledby="q-123"`. The old code never looked there.

### Parent sibling text nodes (Priority 6)

```js
var children = Array.from(par.childNodes);
for each node before el:
  if textNode → collect text
  if element (not input/select/etc) → collect innerText
return cleanLabel(sibTexts.join(" "));
```

Many modern ATS layouts put the question text as a peer node next to the input:

```html
<div>
  Are you open to relocation?    ← text node or <span>
  <input type="text" />          ← the input
</div>
```

The old code couldn't see this pattern at all.

### DOM climb (Priority 7)

```js
var cur = el.parentElement?.parentElement;
var depth = 0;
while (cur && depth < 4) {
  var text = cleanLabel(cur.innerText || cur.textContent);
  if (text.length > 5 && text.length < 150) return text;
  cur = cur.parentElement; depth++;
}
```

Some forms wrap inputs in deeply nested containers. Climbing 4 levels up finds the section label even if it's a cousin of the input.

### `cleanLabel`

Many ATS systems add asterisks for required fields (`"First Name *"`). Without cleaning, `fieldValue("First Name *")` doesn't match because `"first name *"` ≠ `"first name"`. `cleanLabel` strips them before matching.

---

## Call site updates

### Pass 2 (input/textarea/select scan)

**Before:**
```js
var label = getLabel(el, doc);
```

**After:**
```js
var rawLabel = getBestLabel(el, doc);
var label = cleanLabel(rawLabel);
console.log("[Label Debug]", { selector, rawLabel, label, val });
```

### Pass 3 (div/button comboboxes — Workday-style)

**Before:**
```js
var clabel = tr(cel.getAttribute("aria-label") || "");
if (!clabel) {
  var cfor = cel.id ? doc3.querySelector("label[for=...]") : null;
  if (cfor) clabel = tr(cfor.textContent);
}
```

**After:**
```js
var clabel = cleanLabel(getBestLabel(cel, doc3));
console.log("[Label Debug Combo]", { selector: csel, label: clabel });
```

`getBestLabel` handles all 9 fallback strategies for comboboxes too — they now benefit from the same `aria-labelledby`, sibling text, and DOM-climb logic.

---

## Debug Logging

Every field now logs its label resolution:

```
[Label Debug] { selector: "input[name='relocation']", rawLabel: "Are you open to relocation?", label: "Are you open to relocation?", val: "Yes" }
[Label Debug] { selector: "#salary-expectation", rawLabel: "What is your expected salary? *", label: "What is your expected salary?", val: "" }
[Label Debug Combo] { selector: "div.combo:nth-of-type(2)", label: "Preferred work arrangement" }
```

If a label still resolves empty, you can see exactly which selector is the problem and which HTML pattern is missing.

---

## Expected Result

| Before | After |
|---|---|
| `Field 3` | `Are you open to relocation?` |
| `Field 5` | `What is your notice period?` |
| `Dropdown 7` | `Preferred work arrangement` |
| `Field 9` | `Why are you interested in this role?` |
