# Automation Engine

> **Date:** 2026-04-12
> **Architecture:** Playwright-based Modular Form Filler

---

## What Was Learned from Career-Ops

### Link Liveness & SPA Hydration
Career-Ops (`check-liveness.mjs`, `liveness-core.mjs`) handles modern Applicant Tracking Systems (ATS) by explicitly injecting forced hydration waits:
> `// Give SPAs (Ashby, Lever, Workday) time to hydrate`
> `await page.waitForTimeout(2000);`

This is critical because Single Page Applications (SPAs) return a structural HTML shell with a 200 OK status immediately, while the form fields populate asynchronously via JS execution.

### Apply Control Targeting
Career-Ops uses a very broad selector to find the application controls:
> `document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')`

It then filters these based on visibility and innerText against an array of multi-lingual Regex patterns (`APPLY_PATTERNS`).

---

## How It Was Adapted

Instead of a monolithic script, the system is separated into a pipeline approach:

```
Platform Discovery → Form Scanning → Data Mapping → Fill Engine → Submit Execution
```

1. **Modular Scope:** Career-Ops logic was decomposed into individual functional utils `platformDetector.ts`, `formDetector.ts`, `fieldMapper.ts`, and `fillEngine.ts`.
2. **Dynamic Form Finding:** Instead of hardcoded DOM paths, we rely on semantic HTML matching (labels, placeholders, names, aria-labels) from inside the `<form>` context.
3. **Payload Mapping:** Implemented a fuzzy-matcher mapping the AutoApply payload structure (`user_profile` + `answers`) onto the dynamically found browser input nodes.

---

## Platform Detection Logic

Detection revolves around matching URL structures via Regex masks (`PLATFORM_PATTERNS`). 

**Supported Known ATS Engines:**
- **Greenhouse:** `/boards\.greenhouse\.io/` or `/greenhouse\.io\/.*\/jobs/`
- **Lever:** `/jobs\.lever\.co/`
- **Ashby:** `/jobs\.ashbyhq\.com/`
- **Workday:** `/myworkdayjobs\.com/`

If recognized, this flag lets future iteration apply platform-specific parsing quirks (e.g., handling Greenhouse's native dropdown overlays).

---

## Field Mapping Strategy

The `fieldMapper.ts` engine normalizes all detected target labels (removes spaces, special characters, converts to lowercase) and runs cascade filtering against them:

1. **Files:** Search for tags matching `<input type="file">` alongside labels matching `resume` or `cv` → Attach `resume_path`.
2. **Identities:** Target `email`, `phone`, `fullname`, `firstandlast` to exact paths in `user_profile`.
3. **Application Intel:** Matches broad concepts:
    - `"Why this role"`, `"why us"` → `answers.why_role`
    - `"Experience"`, `"Background"` → `answers.experience`
    - `"Strength"`, `"Skill"` → `answers.strengths`
4. **Dynamic Custom:** Exhausts keys inside `answers.custom`. If the form label mentions a custom key, it binds the pre-generated custom prompt response. 

---

## Failure Cases & Handling

| Scenario | Handling Strategy |
|---|---|
| **SPA Hydration Delay** | Pipeline forcibly stalls for 2 seconds upon HTTP 200 to allow Lever/Ashby JS stacks to render. |
| **Missing Mapped Value** | The system logs `"SKIPPED [...] No mapped data"` and gracefully continues filling the rest of the form. |
| **Hidden Form Elements** | `formDetector.ts` ignores `<input type="hidden">` alongside image tags to prevent attempting to force fill CSRF tokens. |
| **Submit Confirmation** | The engine awaits `**/confirm**` navigation post-click. If navigation fails, the error bubbles up safely instead of silently hanging. |

## Limitations

1. **Complex Custom Selects:** Modern frameworks (React/Vue) often replace native `<select>` tags with elaborate `<ul>/<li>` rendered arrays hidden behind click listeners. The engine currently primarily supports native `<select>` mapping.
2. **Multi-page Applications (Workday):** Platforms requiring 4-5 clicking paginations map poorly to single synchronous DOM passes. Workday forms typically necessitate account creation boundaries.

---

## Refactor Improvements (v2)

### 1. Robust Hydration & Initialization
Replaced archaic fixed-time API waits with dynamic layout constraints. `automationService.ts` natively awaits the explicit rendering of `"form, input, textarea"` with a failover to `networkidle` states.

### 2. Apply Trigger Extraction
Built an extraction layer running *before* Form Detection. It discovers nested "Apply" buttons hidden behind modals or generic Job description wrappers automatically using multiple roles (button, link) and regular expressions.

### 3. Heuristic Scoring-Based Field Mapper
Replaced exact string `.includes` matches with a calculated DOM intersection utilizing Levenshtein Distance normalization (`fieldMapper.ts`). Highest scoring fuzzy matches bind payload entries algorithmically instead of explicitly.

### 4. Complete Action Validation & Retry Execution
- **Fill Retry Strategy**: Type actions natively retry elements up to 2 times upon layout shifts, clearing out un-interactable artifacts.
- **Completeness check**: Checks mandatory fields bounding mapped entries, warning explicitly upon missing `<input required>` metadata prior to `submit`.
- **Submission Validation**: Post click submit checks explicitly wait concurrently (`Promise.race`) for a URL domain shift or DOM injection of positive strings ("Thank you", "Application Submitted"). Retry clicks natively up to 1 time.

### 5. Bot Shield Evasion
Replaced instantaneous `page.fill` with localized string iterator `page.type({ delay: 20 })`. Integrated pseudo-random `waitForTimeout` variations between steps masking headless automation cadence. 

### 6. Archiving & Telemetry
Injected full-page `.png` snapshot archiving locally whenever an automation event bubbles an exception boundary. Expanded structured logging formatting to output explicit states directly (`[ACTION: type] [FIELD: First Name] [RESULT: success]`).
