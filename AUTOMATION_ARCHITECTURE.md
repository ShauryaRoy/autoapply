# Automation Architecture & Documentation

**Last Updated:** April 2026  
**Component:** `apps/desktop/src/renderer/features/dashboard/components/live-automation-preview.tsx`

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Core Execution Flow](#core-execution-flow)
4. [Phase 1: Form Detection (locateForm)](#phase-1-form-detection-locateform)
5. [Phase 2: Field Filling (fillForm)](#phase-2-field-filling-fillform)
6. [Phase 3: Dropdown Handling](#phase-3-dropdown-handling)
7. [Phase 4: Navigation (advanceForm)](#phase-4-navigation-advanceform)
8. [User Input Panel & Apply](#user-input-panel--apply)
9. [Webview-to-Electron Communication](#webview-to-electron-communication)
10. [Error Handling & Recovery](#error-handling--recovery)
11. [Critical Design Decisions](#critical-design-decisions)

---

## Overview

The **Live Automation Preview** is an intelligent form-filling engine embedded in an Electron webview. It:

- **Auto-detects** application form fields across diverse job board platforms (Greenhouse, Lever, Workday, Ashby, etc.)
- **Auto-fills** known fields (name, email, phone, LinkedIn, GitHub, etc.) from the user's saved profile
- **Auto-applies** predefined answers to custom dropdown questions ("Are you open to relocation?" → "Yes")
- **Asks the user** to manually fill fields that can't be auto-answered via an interactive panel
- **Navigates multi-page** forms by clicking Next/Submit buttons
- **Recovers gracefully** from context destruction, network delays, and React state races

The system is **loop-based**: it detects a form, fills what it can, asks about what it can't, advances to the next page, and repeats until submission or user intervention is required.

---

## System Architecture

### Component Hierarchy

```
LiveAutomationPreview (React Component)
├── Webview (Electron <webview> tag)
│   ├── Job board application page (HTML/React/Vue)
│   └── Injected automation scripts (executed via executeJavaScript)
├── Status Panel (real-time feedback)
├── Unfilled Fields Panel (user input UI)
└── Control Buttons (Play/Pause/Stop)
```

### Data Flow

```
User Profile (name, email, phone, answers)
          ↓
fillForm() → Detects & fills fields from profile
          ↓
applyUserAnswersToForm() → Applies pre-known answers to dropdowns
          ↓
[Unfilled fields with no answer] → Shows in User Input Panel
          ↓
User manually fills panel → Submitted back to form
          ↓
advanceForm() → Click Next/Submit
          ↓
Loop repeats or form complete
```

### Key State Management

| Ref/State | Purpose |
|-----------|---------|
| `contextReadyRef` | **Critical gate**: Only inject scripts when `true` (set by `dom-ready` event) |
| `loopTokenRef` | Current automation session ID; cleared by user "Stop" or nav failure |
| `profileRef` / `answersRef` | Always-fresh profile & pre-written answers (survives stale closures) |
| `unfilledFields` | Current list of fields needing user input |
| `userAnswers` | User's manual inputs to fields |
| `autoModeRunning` | UI state: are we currently in the automation loop? |

---

## Core Execution Flow

### Full Automation Loop (runAutoModeSequence)

```
STEP 1: locateForm()
   ↓ Success? Clicked Apply button?
   └─ No → Continue
   
STEP 2: fillForm()
   ├─ Direct field matches (name, email, etc.) → filled count
   └─ Custom dropdowns & no-answer fields → unfilled list
   
STEP 3: Enrich unfilled with options
   ├─ For each dropdown with no options
   └─ Open dropdown → read options → close
   
STEP 4: Apply auto-answers
   ├─ Fields with autoValue (e.g., "Yes") → try to fill
   └─ Track failures → surface in user panel
   
STEP 5: User input panel
   ├─ Show unfilled fields that need user decision
   ├─ Pre-fill failed auto-answers (user just confirms)
   └─ Wait for "Apply & Save" or continue to next step
   
STEP 6: advanceForm()
   ├─ Find & click Next/Submit button
   └─ Page navigates → navigation handler → restart loop
   
STEP 7: Loop condition check
   └─ If submit button → stop (success)
   └─ If no progress → stop
   └─ Else → STEP 1
```

**Maximum iterations:** 12 steps (prevents infinite loops on stuck forms)

---

## Phase 1: Form Detection (locateForm)

**Purpose:** Find & click the "Apply" button to enter the form  
**Returns:** `{ clicked: boolean; fields: number; message: string }`

### Logic

1. **Count fillable fields** (across document + iframes)
   - Skip: `hidden`, `disabled`, `readonly`, `file`, `submit`, `button`, `reset`, `image` inputs
   - Check visibility via `getBoundingClientRect()` and `getComputedStyle()`
   - If ≥2 fields found → form already visible, don't click Apply

2. **Score all buttons** for "Apply" button
   - "Apply" / "Apply Now" / "Start Application" → score 100
   - "Continue Application" → score 70
   - "Next" / "Continue" → score 60
   - Pick highest-scoring visible button

3. **Click with timing safety**
   ```js
   setTimeout(() => { best.click(); }, 10);
   ```
   - Defers click by 10ms so `executeJavaScript` can return promise before page unloads
   - Prevents "context destroyed" Electron crash

### Common Issues Handled

| Issue | Solution |
|-------|----------|
| Multiple Apply buttons | Score and pick best match |
| Apply button inside iframe | Scan all iframes in `getDocs()` |
| Form already visible | Return without clicking |
| Button disabled/hidden | Skip it, find visible one |

---

## Phase 2: Field Filling (fillForm)

**Purpose:** Auto-fill basic fields (name, email, etc.) and detect custom dropdowns  
**Returns:** `{ filled: number; unfilled: UnfilledField[]; message: string }`

### Payload Encoding

User profile data (with newlines, special chars) must survive 3 transformation layers:
1. TypeScript → JSON.stringify (escapes `\n` to `\\n`)
2. Template literal interpolation (backslashes must be doubled in regex)
3. JavaScript string inside webview (eval unwraps)

**Solution: Base64 wrapper**

```typescript
const b64Json = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));

// Inside webview:
var data = JSON.parse(decodeURIComponent(escape(atob(b64Json))));
```

This completely isolates the payload from template literal syntax issues.

### Unique Selector Generation (`getUniqueSelector`)

**Critical:** Every field — including every dropdown — must get a **unique, stable CSS selector** so the pipeline can target it precisely across open/read/select/close operations.

**Priority order:**

1. `#id` — if the element has an `id`
2. `tagname[name="..."]` — if it has a `name` attribute
3. `[data-testid="..."]` — if it has a `data-testid`
4. **Ancestor path** — build a selector by walking up the DOM, tagging each node with its tag name, up to 2 safe CSS class names (letters/digits/hyphen/underscore only), and `:nth-of-type(n)` when siblings share the same tag. Stops at depth 8 or at a node with an `id`.

```js
var getUniqueSelector = function(el) {
  if (el.id) return "#" + CSS.escape(el.id);
  var n = el.getAttribute("name"); if (n) return tagname + "[name=...]";
  var td = el.getAttribute("data-testid"); if (td) return "[data-testid=...]";
  // Walk ancestors, build path segments with class + nth-of-type
  var path = []; var cur = el;
  while (cur && ...) {
    var seg = cur.nodeName.toLowerCase();
    // Only ASCII-safe class names (no special chars → no escaping needed)
    var cls = cur.className ... filter(/^[a-zA-Z_\-][a-zA-Z0-9_\-]*$/).slice(0,2);
    if (cls.length > 0) seg += "." + cls.join(".");
    var sibs = parent.children matching same nodeName;
    if (sibs.length > 1) seg += ":nth-of-type(n)";
    path.unshift(seg); if (path.length >= 8) break;
  }
  return path.join(" > ");
};
```

**Why this matters:** The previous `buildSel(el, idx)` used the loop index as the `:nth-of-type` value — but `:nth-of-type` counts siblings, not document-wide elements, so the generated selectors were wrong and non-unique. `getUniqueSelector` builds the correct per-element path.

### Field Matching Strategy

#### Pass 1: Direct Selectors (100% match)
```js
{ sel: "input[name='email']", val: profile.email }
{ sel: "input[autocomplete='given-name']", val: profile.firstName }
```
- Uses hardcoded selectors for common patterns
- Fast, high-confidence matches

#### Pass 2: Label-based matching
For each `<input>`, extract label via:
1. `aria-label` attribute
2. Associated `<label for="id">` element
3. Parent `<label>` wrapper
4. Placeholder or name attribute
5. Fieldset legend

Then match label text to profile fields:
- "First Name" → `profile.firstName`
- "Email Address" → `profile.email`
- "LinkedIn Profile" → `profile.linkedIn`
- "Why interested in {company}?" → saved custom answer

#### Pass 3: Div/Button Comboboxes (Workday-style)
- Detects `[role='combobox']` elements without nested inputs
- Reads `aria-label` or associated label
- Marks as "custom-select" for later dropdown handling
- Each combo gets its own unique selector via `getUniqueSelector`

### Deduplication — Selector-based (not label-based)

**Critical fix:** `unfilledFields` is deduplicated by **selector**, not label.

```js
// CORRECT — selector is the unique identity of a field
var seenSel = {};
var deduped = unfilled.filter(function(f) {
  if (!f.selector || seenSel[f.selector]) return false;
  seenSel[f.selector] = true;
  return true;
});
```

The previous label-based dedup (`seenL[label]`) silently dropped any second dropdown that shared a label with the first — causing only one dropdown to appear in the user panel even when multiple existed on the form.

### Fallback Label for Unlabelled Dropdowns

**Critical fix:** Dropdowns without a detectable `aria-label` / `<label>` association are **no longer silently dropped**.

Previous behavior:
```js
// WRONG — silently drops the dropdown if no label found
if (label && label.length >= 3) unfilled.push(...);
```

Fixed behavior:
```js
// CORRECT — always add; use fallback label so the user can still fill the field
var effectiveLabel = (label && label.length >= 3) ? label : ("Dropdown " + (unfilled.length + 1));
unfilled.push({ label: effectiveLabel, selector, fieldType: "custom-select", options: [], autoValue: fieldValue(effectiveLabel) || "" });
```

Same fix applies to Pass 3 (div/button comboboxes): `if (!clabel || clabel.length < 3) clabel = "Dropdown N";` replaces the previous `continue`.

### Visibility Check
```js
var isVisible = (el) => {
  var s = getComputedStyle(el);
  var r = el.getBoundingClientRect();
  return s.display !== "none" 
      && s.visibility !== "hidden" 
      && r.width > 0 && r.height > 0;
};
```

### Value Setting (handles React)
```js
var setVal = (el, v) => {
  try {
    // Get React-internal setter if available
    var d = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), 
      "value"
    );
    if (d && d.set) d.set.call(el, v);
    else el.value = v;
  } catch(e) { el.value = v; } // Fallback
};

// Then dispatch React events
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
```

### Field Classification

**Done:** Basic text/select/textarea field filled
**Custom:** Dropdown (role='combobox', class contains 'control', etc.) → needs separate handler
**Skip:** Phone country picker, demographic questions (gender, race, disability status), referral sources
**Missing:** Element not found

---

## Phase 3: Dropdown Handling

**Challenge:** React dropdowns are highly varied (react-select, Workday, Lever, Ashby all use different structures)

**Solution:** Multi-phase snapshot + matching + restore

### openCustomDropdownInWebview(selector)

**Order is critical:**

1. **Close any open dropdown**
   - Dispatch Escape keydown to document
   - Click body to dismiss any popovers

2. **Hard assertion on selector with uniqueness enforcement**
   - `document.querySelectorAll(selector)` must resolve to exactly 1 node
   - Logs `[Dropdown Open] { selector, matchCount }` unconditionally
   - **If matchCount ≠ 1:** Tag the first element with `data-auto-id="aa-{timestamp}-{random}"`, then narrow the selector to include this attribute to guarantee uniqueness
   - `console.warn` if selector required tagging
   - Returns `{ opened: false, reason: "no-match" }` if 0 matches
   - **Propagates `resolvedSelector`** (original or tagged) to all downstream read/select/close calls

3. **Snapshot current DOM**
   - Mark all existing option-like nodes with `data-autoapply-before="{token}"`
   - Selectors: `[role='option']`, `[role='menuitem']`, `[role='listitem']`, `li`, `[class*='option']`, `[class*='item']`, `[data-value]`, etc.
   - Large selector set because different ATS systems use different HTML patterns

4. **Open the dropdown**
   - Find container: `[role='combobox']` → `[aria-haspopup='listbox']` → closest parent → self
   - Dispatch `mousedown` → `mouseup` → `click` sequence (React synthetic events need all three)
   - Focus input if applicable

**Returns:** `{ token: string; resolvedSelector: string }` (unique ID + guaranteed-unique selector) or `null` (failed to open)

### readCustomDropdownOptionsInWebview(selector, token)

1. Query ALL option-like elements in the **entire document** (not scoped to the dropdown container) — essential for React portals which render options outside the original DOM tree
2. **Three-phase fallback strategy with spatial filtering:**
   - **DOM-insert pattern** (React portals): options are newly inserted → `fresh` nodes (no snapshot attr) exist → use those
   - **CSS-toggle pattern** (options pre-rendered, visibility toggled): `fresh` is empty → filter visible nodes by **proximity** to prevent cross-dropdown contamination
     - **Proximity function** `isNearDropdown(optionNode, dropdownEl)`: option is valid if within **300px vertically** of the dropdown's bottom edge **AND** horizontally overlapping
     - Apply proximity filter: if any visible nodes are nearby, use only those (not all visible)
     - Last resort: if no nearby visible nodes, fall back to all visible (for frameworks with unusual layouts)
3. Extract `.textContent`, normalize whitespace, deduplicate, filter length 2-120 chars
4. Log `[Dropdown Read Debug] { selector, freshCount, visibleCount, nearVisibleCount, finalCount }` plus `[Dropdown Read] { selector, freshCount, sourceCount, optionCount, preview }` for full diagnostic
5. Return as `string[]`

**Critical bug fix:** Previous fallback `fresh.length > 0 ? fresh : all` would return every option-like node in the document. On a page with a phone country-code picker, `all` would include hundreds of country entries and corrupt every other dropdown's option list. Multi-level fallback (proximity → visible → all) prevents this.

**Two-pattern support with spatial isolation:**
- **DOM-insert** (React portals, most modern ATS): options are inserted into DOM on open → detected as `fresh` → used directly
- **CSS-toggle** (options pre-rendered, visibility toggled, possibly multiple lists open): `fresh` is empty → visibility + spatial proximity only use options near the target dropdown element, preventing cross-field contamination

### selectCustomDropdownOptionInWebview(selector, token, value)

1. **Collect all candidate nodes** using 17 different selectors (document-wide)
2. **Partition by freshness** using token attribute:
   - Fresh (no `data-autoapply-before` marker, or different token) → preferred candidates (DOM-insert pattern)
   - Stale (marked with current token, pre-existed) → fallback
3. **CSS-toggle fallback with spatial filtering:** if `fresh` is empty, filter stale candidates by:
   - **Visibility**: `getBoundingClientRect().height > 0 && width > 0` (option is rendered)
   - **Proximity**: `isNearDropdown(node, dropdownEl)` (option within 300px vertically + horizontal overlap)
   - Use proximity-filtered set if non-empty; fall back to all-visible; last resort to all-stale
   - Prevents country-code picker entries and other pre-rendered options from contaminating an unrelated dropdown
4. **Score each candidate** for match quality:
   - Exact text match → score 100
   - Starts-with or ends-with → score 80
   - Contains → score 60 (if short) or 30 (if long)
5. **Click best match** with `mousedown` → `mouseup` → `click`
6. **Debug logging:**
   ```js
   console.log("[Dropdown Select Debug]", { selector, value, freshCount, staleCount, nearVisibleCount, candidateCount });
   ```
7. **Return:** success bool + diagnostics (freshCount, staleCount, candidateCount, bestScore)

### closeCustomDropdownInWebview(resolvedSelector, token)

1. Dispatch Escape keydown to element (using resolvedSelector, guaranteed to target correct element)
2. Blur the element
3. Click body to dismiss
4. Clean up markers (remove `[data-autoapply-before]` attributes for this token only)

**Note:** Uses `resolvedSelector` returned from `openCustomDropdownInWebview` to guarantee targeting the exact dropdown element, even if the original selector was non-unique.

---

## Phase 4: Navigation (advanceForm)

**Purpose:** Click Next, Continue, or Submit button to advance or complete  
**Returns:** `{ clicked: boolean; isSubmit: boolean; message: string }`

### Button Scoring

| Text | Score | Intent |
|------|-------|--------|
| "Submit Application" | 100 | Final step |
| "Submit" | 90 | Final step |
| "Complete Application" \| "Apply" | 80 | Final step |
| "Save and Continue" \| "Save & Continue" | 65 | Intermediate |
| "Next" | 60 | Intermediate |
| "Continue" | 50 | May be intermediate |

### Timing Safety

```js
setTimeout(() => { best.click(); }, 10);
```

Same 10ms defer as `locateForm` to prevent navigation races.

### Determines Submission

`isSubmit = bestScore >= 80` — high-confidence signal that form is being submitted (not just advancing).

---

## User Input Panel & Apply

### When Panel Shows

User input panel appears when:
- `needsInput.length > 0` (fields without answers + failed auto-fills)

### Field Item

Each field shows:
- **Label:** "Are you open to relocation?", "Why interested in us?", etc.
- **Field Type:** "text", "textarea", "select", "custom-select"
- **Options (if select):** Pre-read from dropdown
- **Input:** Text input or dropdown selector

### Pre-filling Strategy

For fields with `autoValue` that failed to auto-fill:
- The suggested answer is **pre-populated** in the text box
- User just confirms by clicking "Apply & Save"
- Reduces friction for edge-case failures

```typescript
// Example:
// Field: "Are you open to relocation?"
// autoValue: "Yes"
// If auto-fill failed → panel shows text box with "Yes" pre-filled
```

### Apply & Save Flow

1. **User submits answers** via "Apply & Save" button
2. `handleSaveAndApply()` triggers:
   - Calls `applyUserAnswersToForm(toApply)` with user inputs
   - Returns `failedSelectors` set (tracks what didn't work)
   - Saves answers to profile → backend
   - Clears those fields from panel
   - Re-resumes auto-mode loop

3. **Skip All** button:
   - User can skip unfilled fields
   - Loop continues to `advanceForm()` without filling

---

## Webview-to-Electron Communication

### Execution Layer

```typescript
runInWebview(script: string, timeoutMs = 15000, label = "unknown")
```

**Critical flow:**

1. **Context check:** Poll `contextReadyRef` and `isLoading()` until ready (max 15s)
2. **Ping test:** Quick `executeJavaScript("(function(){return '__ping__';})()")` to verify context alive
3. **Wrap injection:**
   ```typescript
   const wrapperScript = `(function(){
     try {
       return eval(${JSON.stringify(script)});
     } catch(__e) {
       return { __AUTOAPPLY_SCRIPT_ERROR__: true, name: ..., message: ..., stack: ... };
     }
   })()`;
   ```
4. **Execute:** `await node.executeJavaScript(wrapperScript, true)`
5. **Parse result:** If `__AUTOAPPLY_SCRIPT_ERROR__` flag, display error in status bar
6. **Return:** `{ ... }` object or `null` on failure

### Why eval() Wrapper?

Native `SyntaxError` and pre-try/catch runtime errors crash the Electron IPC bridge with generic `GUEST_VIEW_MANAGER_CALL` error. Wrapping in `eval()` makes **all** errors catchable and returnable.

### String Interpolation Safety

**Problem:** Template literals don't escape backslashes
```typescript
// BROKEN:
const script = `var data = ${JSON.stringify({a: 'b\nc'})}`;
// Results in: var data = {"a":"b
//                        c"};  ← SyntaxError
```

**Solution:** Use JSON.stringify the interpolation itself
```typescript
// CORRECT:
const script = `var data = ${JSON.stringify(JSON.stringify({a:'b\nc'}))}`;
// Results in: var data = "{\"a\":\"b\\nc\"}"; ✓
```

Or better: Base64 for complex payloads
```typescript
const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
const script = `var data = JSON.parse(decodeURIComponent(escape(atob("${b64}"))));`;
```

### DOM Access

Automation can access:
- `document` (main page)
- `document.querySelectorAll("iframe")` for iframes
- `iframe.contentDocument` for iframe content (same-origin only)

**Cannot access:**
- Cross-origin iframes (security)
- Shadow DOM (use `, ::slotted()` selectors instead)
- Web Components internals (use event handlers)

---

## Error Handling & Recovery

### Navigation Races

**Problem:** User clicks a link, page starts navigating while script is mid-execution. Electron context destroyed mid-IPC call.

**Symptom:** `GUEST_VIEW_MANAGER_CALL` error with message `/context|destroyed|navigation/i`

**Recovery:**
1. `contextReadyRef` immediately set `false` on `did-navigate` event
2. `runInWebview()` catches error, logs, returns `null`
3. Caller interprets `null` as "try again after page loads"
4. `onNavigate` handler schedules `setTimeout(() => runAutoRef.current?.(), 2000)`
5. Loop restarts on `dom-ready`

### Syntax Errors in Injected Scripts

**Symptom:** Status bar shows `❌ JS Error [fillForm] SyntaxError: Invalid or unexpected token`

**Debug:** Script preview is logged to console with first 400 chars visible

**Common causes:**
1. Unescaped backslashes in regex (now fixed: `/\d/` → `/\\d/`)
2. Multi-line strings breaking template literal (now fixed: Base64 wrapper)
3. `JSON.stringify()` interpolation with newlines (now fixed: use b64 or double-escape)

### Timeout Waiting for Context

**Symptom:** Status bar shows "Timed out waiting for page context. contextReady=false"

**Causes:**
- Page taking >15s to load
- Electron not firing `dom-ready` event
- `isLoading()` stuck returning true

**Recovery:** Timeout returns `null`, caller bails, human must reload page

### Dropdown Won't Open

**Symptom:** Status bar shows `⚠️ Dropdown: no option matched "Yes" (0 options found)`

**Debugging:**
1. Log message includes tried node count and best score
2. Script tries 17 different selectors + mousedown/up/click sequence
3. If still no options:
   - Dropdown might require specific focus state
   - Custom JS framework (Alpine, htmx) might need special event
   - Framework lazy-loads options from API (needs more wait time)

**Fallback:** Field surfaced in user panel; user fills manually

### Script Execution Silently Fails

**Symptom:** Script returns object but with unexpected structure (null, undefined, wrong shape)

**Recovery:** Fallback logic in each function:
```typescript
const result = await runInWebview(...);
const mode = result?.mode ?? "missing"; // Defaults to "missing" on null/undefined
```

---

## Critical Design Decisions

### 1. Loop-Based vs. Single-Shot Approach

**Decision:** Loop (detect → fill → advance → repeat)

**Why:**
- Multi-page forms are common (job boards have 3-5 steps)
- Single-shot would leave pages unfinished
- Loop scales to arbitrary form lengths

**Safeguard:** 12-step max prevents infinite loops

### 2. Webview Over Native Browser Control

**Decision:** Embed `<webview>` in Electron instead of using native browser APIs

**Why:**
- User sees actual website UI (matches real application experience)
- Webview renders using Chromium (same as user's browser)
- Can inspect/debug with DevTools
- No extra browser window to manage

**Tradeoff:** `executeJavaScript` is lower-level, more brittle

### 3. Synchronous-Only Webview Scripts

**Decision:** No `async function() { }` or `await` in injected scripts

**Why:**
- Electron's `executeJavaScript()` doesn't properly handle promise rejections
- Unhandled promise rejection → generic `GUEST_VIEW_MANAGER_CALL` error
- Pure synchronous scripts are fast & reliable

**Pattern:** Orchestrate async delays in TypeScript, inject fast sync scripts

### 4. Base64 Payload Encoding

**Decision:** Encode user data as Base64 before template interpolation

**Why:**
- Eliminates `SyntaxError` from newlines, quotes, backslashes in user data
- Simple transformation: `btoa(unescape(encodeURIComponent(JSON.stringify(data))))`
- Decoding is equally simple: `JSON.parse(decodeURIComponent(escape(atob(b64))))`

### 5. Multi-Selector Approach for Dropdowns

**Decision:** 17+ selectors per dropdown to find options (document-wide, not container-scoped)

**Why:**
- React-select, Workday, Lever, Ashby, Greenhouse all use different HTML structures
- React portals render dropdown options **outside** the dropdown container's DOM subtree — scoping to the container misses them
- Token snapshot (`data-autoapply-before`) isolates the correct options: only nodes that appeared **after** the dropdown was clicked are "fresh" and belong to the current dropdown
- No single selector works across all job boards; document-wide + token filtering is robust & future-proof

**Cost:** Slightly broader DOM query, but still <1ms per query

### 6. Token-Based Option Snapshot

**Decision:** Mark existing options with attribute before opening, detect newly-rendered ones as "fresh"

**Why:**
- React dropdowns lazy-render options only when opened
- Distinguishing "old" (pre-open) vs "fresh" (post-open) is key to matching the correct field's options
- The token changes per `openCustomDropdownInWebview` call, so options from field N are never confused with options from field N+1
- Attribute marker is fast & doesn't interfere with styling

**Two-pattern handling:**
- **DOM-insert** (fresh exists): use fresh nodes directly
- **CSS-toggle** (fresh is empty): fall back to **visible** stale nodes (not `all`). Using `all` as the fallback was a critical bug — it returned every option-like node in the document, causing country-code picker entries to appear under unrelated questions.

### 7. Unique Per-Element Selectors (`getUniqueSelector`)

**Decision:** Build a DOM-path-based CSS selector rather than relying on loop indices

**Why:**
- Multiple dropdowns with the same `[role='combobox']` or the same tag make `document.querySelector` always return the **first match**
- The old `buildSel(el, idx)` used the iteration index as `:nth-of-type`, but `:nth-of-type` counts DOM siblings — an iteration counter bears no relation to sibling position, producing wrong or non-existent selectors
- `getUniqueSelector` builds the correct ancestor path: `id` when available, then `tagname.classA.classB:nth-of-type(n)` walking up max 8 levels
- Every field — including every dropdown on a multi-dropdown page — gets a selector that targets exactly one DOM node

### 8. Selector-Based Deduplication (not label-based)

**Decision:** Deduplicate `unfilledFields` by `selector`, not by `label`

**Why:**
- Multiple dropdowns can share the same label (e.g., two "Select" comboboxes, or two with no detected label)
- Label-based dedup silently dropped every dropdown after the first with a matching label
- Selector dedup is correct: two DOM elements always have distinct selectors from `getUniqueSelector`

### 9. Spatial Filtering for Multi-Dropdown Forms

**Decision:** Filter dropdown options by proximity to target element to prevent cross-dropdown contamination

**Why:**
- Many ATS systems keep multiple option lists in the DOM simultaneously (not fully closing previous dropdowns)
- Visibility alone is insufficient — nearby dropdowns have overlapping visible regions
- Spatial proximity (300px vertical + horizontal overlap) isolates the correct dropdown's options
- Prevents country-code picker entries from appearing under "relocation" or unrelated questions

**Pattern:**
```js
var isNearDropdown = (optionNode, dropdownEl) => {
  var dr = dropdownEl.getBoundingClientRect();
  var or = optionNode.getBoundingClientRect();
  var verticalDistance = Math.abs(or.top - dr.bottom);
  var horizontalOverlap = or.left < dr.right && or.right > dr.left;
  return verticalDistance < 300 && horizontalOverlap;
};
```

### 10. User Input Panel Instead of Prompts

**Decision:** Show all unfilled fields at once in a panel; let user fill together

**Why:**
- Multiple unfilled fields → multiple JavaScript `confirm()` prompts would be annoying
- Panel shows field context (label, type, options)
- User can see & answer all unknowns at once
- Can pre-fill with suggested answers

### 11. Direct Per-Field Dropdown Enrichment

**Decision:** `enrichUnfilledWithOptions` does open → read → close directly for each field. Does NOT route through a shared `fetchDropdownOptions` helper.

**Why:**
- Each field must have its own independent token — no state leaks between fields
- The previous indirect path (`fetchDropdownOptions`) added a redundant DOM inspection step and obscured the pipeline
- **Required contract:** `field.selector → open(selector) → { token, resolvedSelector } → read(resolvedSelector, token) → field.options → close(resolvedSelector, token)` must be traceable and linear
- `resolvedSelector` ensures that even non-unique input selectors are narrowed to a single guaranteed-unique node
- Logs `[AutoApply:enrich] Dropdown N/M: "label" selector="..."` before each open so the full pipeline is observable per field

---

## Debugging Tips

### Enable Console Logging

All injected scripts are wrapped with error reporting. Open DevTools:
1. Click Electron window (not webview)
2. Press **Ctrl+Shift+I**
3. Go to **Console** tab
4. Look for `[AutoApply:*]` prefixed messages

### Common Log Messages

| Message | Meaning |
|---------|---------|
| `[AutoApply:fillForm] Payload encoded OK. b64 length: 4521` | Profile successfully Base64 encoded |
| `[AutoApply:openDropdown] Opened true` | Dropdown opened successfully |
| `[AutoApply:selectDropdownOption] No match – tried 42 nodes, bestScore=45, value="Yes"` | Dropdown open but no good match found |
| `[AutoApply:locateForm] Context ping FAILED` | Webview context destroyed; waiting for reload |

### Inject Custom Debug Script

```typescript
// In browser console:
await webviewRef.current?.executeJavaScript(`
  console.log("Form inputs:", document.querySelectorAll("input").length);
  console.log("Dropdowns:", document.querySelectorAll("[role='combobox']").length);
  console.log("iframes:", document.querySelectorAll("iframe").length);
`);
```

### Check Field Selectors

Each filled field logs its selector. Compare to page:
```typescript
// If "Email" fill fails, check:
document.querySelector("input[type='email']") // exists?
document.querySelector("input[name='email']") // exists?
```

---

## Performance Characteristics

| Operation | Typical Time | Notes |
|-----------|-----------|-------|
| Locate form | 200-500ms | Quick visual scan |
| Fill 10 text fields | 800-1200ms | Includes DOM updates & event dispatch |
| Open dropdown | 700ms | Includes wait for React render |
| Read dropdown options (10 opts) | 300-500ms | Mostly whitespace trim & dedup |
| Select dropdown option | 400-600ms | Score matching + click |
| Advance (click Next) | 200ms | Quick click + setTimeout |
| **Full loop (one form page)** | **3-5 seconds** | 3-4 fields + 1-2 dropdowns |

---

## Future Improvements

1. **Viewport detection:** Skip offscreen fields
2. **Shadow DOM:** Use `:host` / `::slotted()` for Web Components
3. **API inspection:** Detect network calls, pre-fetch dropdown options
4. **ML field matching:** Use semantic similarity for field label matching
5. **Video proof:** Record screen to show user exactly what was filled
6. **Field validation:** Client-side validation before advancing

---

## Summary

The automation system is a **loop-based form-filling engine** that:

1. **Detects** forms by looking for apply buttons & fields
2. **Fills** known fields from the user's saved profile
3. **Handles dropdowns** with snapshot + scoring to find the right option
4. **Tracks failures** and surfaces them in a user input panel
5. **Navigates** multi-page forms by clicking Next/Submit buttons
6. **Recovers** gracefully from page reloads and context destruction

Core strengths:
- Works across diverse job board patterns (Greenhouse, Workday, Lever, etc.)
- Handles React/Vue/Angular synthetic events correctly
- Resilient to Electron context races
- User-friendly: shows unfilled fields with pre-populated suggestions

Core constraints:
- Synchronous webview scripts only (no async/await)
- Relies on Electron `dom-ready` event for context signal
- Can't access cross-origin iframes
- Timeout on very slow pages (>15s)
