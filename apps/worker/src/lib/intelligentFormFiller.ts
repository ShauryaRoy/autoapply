import type { Page } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs/promises";
import path from "node:path";
import { buildResumeCanonical } from "../automation/tailor/resumeTailor.js";
import { type ResumeCanonical } from "../automation/tailor/types.js";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

interface FormField {
  index: number;
  tag: string;           // input | textarea | select
  type: string;          // text, email, tel, file, etc.
  name: string;
  id: string;
  placeholder: string;
  label: string;         // resolved label text
  required: boolean;
  options?: string[];     // for <select>
  currentValue: string;
  ariaLabel: string;
  dataTestId: string;
  selector: string;       // unique CSS selector we can use to target it
  isVisible: boolean;
}

interface FillInstruction {
  index: number;
  selector: string;
  action: "type" | "select" | "upload" | "check" | "click" | "skip";
  value: string;
}

interface ApplicantData {
  personal: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
  };
  education: Array<{
    institution: string | null;
    field_of_study: string | null;
    degree: string | null;
    start_year: number | null;
    end_year: number | null;
  }>;
  experience: Array<{
    job_title: string | null;
    company: string | null;
    location: string | null;
    description: string | null;
    start_year: number | null;
    end_year: number | null;
    current: boolean;
  }>;
  skills: string[];
  links: {
    linkedin?: string | null;
    portfolio?: string | null;
    github?: string | null;
  };
  resumeText: string;
  resumeCanonical?: ResumeCanonical;
  yearsExperience?: string;
  coverLetter?: string;
  answers?: Record<string, string>;
  // Extended profile fields for comprehensive form filling
  workAuth?: {
    usAuthorized?: string;
    canadaAuthorized?: string;
    ukAuthorized?: string;
    needsVisaSponsorship?: string;
  };
  salary?: {
    expected?: string;
    currency?: string;
    openToNegotiation?: string;
  };
  availability?: {
    noticePeriod?: string;
    earliestStartDate?: string;
    currentlyEmployed?: string;
  };
  workPreferences?: {
    mode?: string;
    willingToRelocate?: string;
    travelPercent?: string;
    inPersonPercent?: string;
  };
  roles?: {
    desiredRoles?: string[];
    preferredLocations?: string[];
    employmentTypes?: string[];
  };
  eeo?: {
    gender?: string;
    veteran?: string;
    disability?: string;
    lgbtq?: string;
    ethnicities?: string[];
    declineEthnicity?: boolean;
  };
}

function getResumeTextForContext(applicant: ApplicantData): string {
  if (applicant.resumeCanonical) {
    return buildResumeCanonical(applicant.resumeCanonical);
  }
  return applicant.resumeText;
}

// ─────────────────────────────────────────────────────
// Extract all form fields from the page via page.evaluate
// ─────────────────────────────────────────────────────

async function extractFormFields(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: Array<{
      index: number;
      tag: string;
      type: string;
      name: string;
      id: string;
      placeholder: string;
      label: string;
      required: boolean;
      options?: string[];
      currentValue: string;
      ariaLabel: string;
      dataTestId: string;
      selector: string;
      isVisible: boolean;
    }> = [];

    const utils = {
      getLabel(el: HTMLElement): string {
        // Check for aria-label
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label")!;

        // Check for associated <label>
        const id = el.id;
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) return label.textContent?.trim() ?? "";
        }

        // Check parent label
        const parentLabel = el.closest("label");
        if (parentLabel) return parentLabel.textContent?.trim() ?? "";

        // Check preceding sibling or parent text
        const parent = el.parentElement;
        if (parent) {
          const prevSibling = el.previousElementSibling;
          if (prevSibling && prevSibling.tagName === "LABEL") {
            return prevSibling.textContent?.trim() ?? "";
          }
          // Look for any label-like element nearby
          const nearbyLabel = parent.querySelector("label, .label, .field-label, [class*='label']");
          if (nearbyLabel && nearbyLabel !== el) {
            return nearbyLabel.textContent?.trim() ?? "";
          }
        }

        return "";
      },

      isElementVisible(el: HTMLElement): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },

      buildSelector(el: HTMLElement, idx: number): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.getAttribute("name")) {
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute("name")!;
          return `${tag}[name="${CSS.escape(name)}"]`;
        }
        if (el.getAttribute("data-testid")) {
          return `[data-testid="${CSS.escape(el.getAttribute("data-testid")!)}"]`;
        }
        // Fallback: nth-of-type
        return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
      },

      // Find all inputs, textareas, selects, deeply piercing Shadow DOMs
      querySelectorAllDeep(selector: string, root: ParentNode = document): Element[] {
        const results = Array.from(root.querySelectorAll(selector));
        const allElements = root.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.shadowRoot) {
            results.push(...utils.querySelectorAllDeep(selector, el.shadowRoot));
          }
        }
        return results;
      }
    };

    const elements = utils.querySelectorAllDeep("input, textarea, select") as HTMLElement[];

    let fieldIndex = 0;
    elements.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";

      // Skip hidden type inputs (except file inputs) and buttons
      if ((type === "hidden" && tag === "input") || type === "button" || type === "reset" || type === "image") return;

      const field = {
        index: fieldIndex,
        tag,
        type: tag === "textarea" ? "textarea" : tag === "select" ? "select" : type,
        name: el.getAttribute("name") ?? "",
        id: el.id ?? "",
        placeholder: (el as HTMLInputElement).placeholder ?? "",
        label: utils.getLabel(el),
        required: (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true",
        currentValue: (el as HTMLInputElement).value ?? "",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        dataTestId: el.getAttribute("data-testid") ?? "",
        selector: utils.buildSelector(el, fieldIndex),
        // Always mark file inputs as visible so the AI can upload resumes
        isVisible: type === "file" ? true : utils.isElementVisible(el),
        ...(tag === "select" ? {
          options: Array.from((el as HTMLSelectElement).options).map(o => o.text)
        } : {})
      };

      fields.push(field);
      fieldIndex++;
    });

    // Special pass: ATS file dropzones that use custom tags or divs/buttons instead of input[type=file]
    const dropzones = utils.querySelectorAllDeep("button, [role='button'], [class*='upload'], [class*='drop']");
    dropzones.forEach((el) => {
       const text = el.textContent?.toLowerCase() || el.getAttribute('aria-label')?.toLowerCase() || '';
       if (text.includes("upload") || text.includes("select file") || text.includes("drop file") || text.includes("resume") || text.includes("cv")) {
          // If it's visible or likely to be the file button
          if (utils.isElementVisible(el as HTMLElement)) {
             fields.push({
               index: fieldIndex++,
               tag: "dropzone-button",
               type: "file",
               name: el.getAttribute("data-automation-id") || el.id || "",
               id: el.id || "",
               placeholder: "",
               label: text.trim(),
               required: true, // we assume resume is required
               currentValue: "",
               ariaLabel: el.getAttribute("aria-label") || "",
               dataTestId: el.getAttribute("data-testid") || "",
               selector: utils.buildSelector(el as HTMLElement, fieldIndex),
               isVisible: true
             });
          }
       }
    });

    // Special pass: ARIA-based custom dropdowns (React-Select, Workday, Greenhouse, etc.)
    // These are NOT <select> elements — they use div/button with role="combobox"
    const ariaComboboxes = utils.querySelectorAllDeep("[role='combobox'], [aria-haspopup='listbox']") as HTMLElement[];
    ariaComboboxes.forEach((el) => {
      // Skip if this is an <input> inside a native <select> wrapper, or already in our list
      if (el.tagName.toLowerCase() === "select") return;
      if (el.closest("select")) return;
      if (!utils.isElementVisible(el)) return;
      // Avoid duplicates from sibling inputs already captured
      if (el.tagName.toLowerCase() === "input" && el.closest("[role='combobox']") && el.closest("[role='combobox']") !== el) return;

      const labelText = utils.getLabel(el) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      const currentVal = el.getAttribute("aria-activedescendant") ? el.textContent?.trim() || "" : (el as HTMLInputElement).value || "";

      // Collect visible options already in DOM (some ATS pre-render them)
      let options: string[] = [];
      try {
        const ariaControls = el.getAttribute("aria-controls");
        const optionEls = ariaControls
          ? document.querySelectorAll(`#${CSS.escape(ariaControls)} [role='option']`)
          : el.querySelectorAll("[role='option']");
        options = Array.from(optionEls).map(o => o.textContent?.trim() || "").filter(Boolean);
      } catch { /* ignore — options will just be empty */ }

      fields.push({
        index: fieldIndex++,
        tag: "custom-select",
        type: "select",
        name: el.getAttribute("name") || el.getAttribute("data-name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        label: labelText,
        required: el.getAttribute("aria-required") === "true",
        currentValue: currentVal,
        ariaLabel: el.getAttribute("aria-label") || "",
        dataTestId: el.getAttribute("data-testid") || "",
        selector: utils.buildSelector(el, fieldIndex),
        isVisible: true,
        options: options.length ? options : undefined,
      });
    });

    return fields;
  });
}

// ─────────────────────────────────────────────────────
// Also look for checkboxes and radio buttons
// ─────────────────────────────────────────────────────

async function extractCheckboxesAndRadios(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: Array<{
      index: number;
      tag: string;
      type: string;
      name: string;
      id: string;
      placeholder: string;
      label: string;
      required: boolean;
      currentValue: string;
      ariaLabel: string;
      dataTestId: string;
      selector: string;
      isVisible: boolean;
    }> = [];

    const dom = {
      querySelectorAllDeep(selector: string, root: ParentNode = document): Element[] {
        const results = Array.from(root.querySelectorAll(selector));
        const allElements = root.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.shadowRoot) {
            results.push(...dom.querySelectorAllDeep(selector, el.shadowRoot));
          }
        }
        return results;
      }
    };

    const elements = dom.querySelectorAllDeep("input[type='checkbox'], input[type='radio']") as HTMLInputElement[];

    elements.forEach((el, idx) => {
      // Walk up the DOM tree looking for a label: direct wrapping label, nearby sibling label, or aria-label
      const wrappingLabel = el.closest("label");
      let labelText = el.getAttribute("aria-label") ?? "";
      if (!labelText && wrappingLabel) {
        // Clone and remove the input itself so we only get the text portion of the label
        const clone = wrappingLabel.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("input").forEach(i => i.remove());
        labelText = clone.textContent?.trim() ?? "";
      }
      if (!labelText && el.id) {
        const associated = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (associated) labelText = associated.textContent?.trim() ?? "";
      }

      // Build a unique selector — for radio groups, include the value so each radio is distinct
      let selector: string;
      if (el.id) {
        selector = `#${CSS.escape(el.id)}`;
      } else if (el.name && el.value) {
        selector = `input[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`;
      } else {
        selector = `input[name="${CSS.escape(el.name)}"]`;
      }

      fields.push({
        index: 1000 + idx,
        tag: "input",
        type: el.type,
        name: el.name ?? "",
        id: el.id ?? "",
        placeholder: "",
        label: labelText || el.value || "",
        required: el.required,
        currentValue: el.checked ? el.value || "checked" : "unchecked",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        dataTestId: el.getAttribute("data-testid") ?? "",
        selector,
        isVisible: el.getBoundingClientRect().width > 0
      });
    });

    return fields;
  });
}

// ─────────────────────────────────────────────────────
// Use Gemini to decide what to fill
// ─────────────────────────────────────────────────────

async function askGeminiWhatToFill(
  fields: FormField[],
  applicant: ApplicantData,
  pageTitle: string,
  pageUrl: string
): Promise<FillInstruction[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("   ⚠ No GEMINI_API_KEY — using rule-based fill");
    return ruleFill(fields, applicant);
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });

  // Only send visible fields to reduce token usage
  const visibleFields = fields.filter(f => f.isVisible);

  const fieldDescriptions = visibleFields.map(f => {
    let desc = `[${f.index}] ${f.tag}`;
    if (f.type !== "text" && f.type !== "textarea") desc += ` type="${f.type}"`;
    if (f.label) desc += ` label="${f.label}"`;
    if (f.name) desc += ` name="${f.name}"`;
    if (f.placeholder) desc += ` placeholder="${f.placeholder}"`;
    if (f.required) desc += ` REQUIRED`;
    if (f.options) desc += ` options=[${f.options.join(", ")}]`;
    if (f.currentValue) desc += ` value="${f.currentValue}"`;
    return desc;
  }).join("\n");

  let answersBlock = "";
  if (applicant.answers && Object.keys(applicant.answers).length > 0) {
    answersBlock = "SPECIFIC FORM ANSWERS PREPARED FOR THIS JOB:\n";
    for (const [q, a] of Object.entries(applicant.answers)) {
      answersBlock += `- ${q}: ${a}\n`;
    }
  }

  const educationBlock = applicant.education.map(e => `- ${e.degree} in ${e.field_of_study} from ${e.institution} (${e.start_year}-${e.end_year ?? "Present"})`).join("\n");
  const experienceBlock = applicant.experience.map(e => `- ${e.job_title} at ${e.company} (${e.start_year}-${e.end_year ?? "Present"}): ${e.description?.slice(0, 200)}...`).join("\n");

  // Build work authorization block
  const workAuth = applicant.workAuth ?? {};
  const workAuthBlock = [
    `- Authorized to work in the US: ${workAuth.usAuthorized === "yes" ? "YES" : workAuth.usAuthorized === "no" ? "NO" : "not specified"}`,
    `- Authorized to work in Canada: ${workAuth.canadaAuthorized === "yes" ? "YES" : workAuth.canadaAuthorized === "no" ? "NO" : "not specified"}`,
    `- Authorized to work in the UK: ${workAuth.ukAuthorized === "yes" ? "YES" : workAuth.ukAuthorized === "no" ? "NO" : "not specified"}`,
    `- Requires visa sponsorship: ${workAuth.needsVisaSponsorship === "yes" ? "YES" : workAuth.needsVisaSponsorship === "no" ? "NO" : "not specified"}`
  ].join("\n");

  // Build availability block
  const avail = applicant.availability ?? {};
  const noticePeriod = avail.noticePeriod || "2 weeks";
  const startDate = avail.earliestStartDate || "Within 2 weeks";
  const availBlock = [
    `- Notice period: ${noticePeriod}`,
    `- Earliest start date: ${startDate}`,
    `- Currently employed: ${avail.currentlyEmployed === "yes" ? "YES" : avail.currentlyEmployed === "no" ? "NO" : "not specified"}`
  ].join("\n");

  // Build salary block
  const sal = applicant.salary ?? {};
  const expectedSalary = sal.expected ? `${sal.expected} ${sal.currency ?? "USD"}` : "Open to discussion";
  const salaryBlock = [
    `- Expected salary: ${expectedSalary}`,
    `- Open to negotiation: ${sal.openToNegotiation === "no" ? "NO" : "YES"}`
  ].join("\n");

  // Build work preferences block
  const prefs = applicant.workPreferences ?? {};
  const inPersonPct = prefs.inPersonPercent || "25";
  const travelPct = prefs.travelPercent || "25";
  const workMode = prefs.mode || "flexible";
  const relocate = prefs.willingToRelocate === "no" ? "NO" : "YES";
  const prefsBlock = [
    `- Preferred work mode: ${workMode} (remote/hybrid/onsite)`,
    `- Willing to relocate: ${relocate}`,
    `- Willing to travel up to: ${travelPct}% of the time`,
    `- Comfortable with in-person: ${inPersonPct}% of the time`,
    `- Preferred employment types: ${(applicant.roles?.employmentTypes ?? ["Full-time"]).join(", ")}`
  ].join("\n");

  // Build EEO block
  const eeo = applicant.eeo ?? {};
  const eeoBlock = [
    eeo.gender ? `- Gender: ${eeo.gender}` : "",
    eeo.veteran ? `- Veteran: ${eeo.veteran}` : "",
    eeo.disability ? `- Disability: ${eeo.disability}` : "",
    eeo.lgbtq ? `- LGBTQ+: ${eeo.lgbtq}` : "",
    eeo.declineEthnicity ? `- Ethnicity: Decline to state` : (eeo.ethnicities?.length ? `- Ethnicity: ${eeo.ethnicities.join(", ")}` : "")
  ].filter(Boolean).join("\n");

  // Pre-compute resume context safely — a crash here must not block the fill
  let resumeContext = applicant.resumeText.slice(0, 2500);
  try {
    resumeContext = getResumeTextForContext(applicant).slice(0, 2500);
  } catch (err) {
    console.warn("   ⚠ getResumeTextForContext failed, falling back to raw resumeText:", err instanceof Error ? err.message : err);
  }

  const prompt = `You are an AI job application assistant filling out a job application form on behalf of the applicant.

PAGE: "${pageTitle}" (${pageUrl})

═══ APPLICANT PROFILE ═══
Name: ${applicant.personal.firstName} ${applicant.personal.lastName}
Email: ${applicant.personal.email}
Phone: ${applicant.personal.phone}
Location: ${applicant.personal.location}
Years of Experience: ${applicant.yearsExperience ?? applicant.experience.length ?? "3"}
Skills: ${applicant.skills.join(", ")}
${applicant.links.linkedin ? `LinkedIn: ${applicant.links.linkedin}` : ""}
${applicant.links.github ? `GitHub: ${applicant.links.github}` : ""}
${applicant.links.portfolio ? `Portfolio: ${applicant.links.portfolio}` : ""}

═══ WORK AUTHORIZATION ═══
${workAuthBlock}

═══ AVAILABILITY ═══
${availBlock}

═══ SALARY / COMPENSATION ═══
${salaryBlock}

═══ WORK PREFERENCES ═══
${prefsBlock}

${eeoBlock ? `═══ EEO / DEMOGRAPHICS ═══\n${eeoBlock}\n` : ""}

═══ EDUCATION ═══
${educationBlock}

═══ WORK EXPERIENCE ═══
${experienceBlock}

${answersBlock}

═══ RESUME TEXT (context only) ═══
${resumeContext}

═══ FORM FIELDS ON THIS PAGE ═══
${fieldDescriptions}

═══ INSTRUCTIONS ═══
Return a JSON array of fill instructions. Each entry has: index, selector, action, value.

⚠ RULE ZERO — NO GUESSING: If you cannot determine the correct answer from the applicant data provided above with HIGH confidence, set action="skip". NEVER guess, invent, or hallucinate an answer. A blank field is always better than a wrong one. When in doubt, skip.

FILL RULES:

1. IDENTITY FIELDS
   - First name → "${applicant.personal.firstName}"
   - Last name → "${applicant.personal.lastName}"
   - Full name → "${applicant.personal.firstName} ${applicant.personal.lastName}"
   - Email → "${applicant.personal.email}"
   - Phone/mobile → "${applicant.personal.phone}"
   - City/location → "${applicant.personal.location}"

2. WORK AUTHORIZATION QUESTIONS (yes/no/select patterns)
   - "authorized to work in US / United States?" → "${workAuth.usAuthorized === "yes" ? "Yes" : workAuth.usAuthorized === "no" ? "No" : "SKIP"}" (SKIP if not set in profile)
   - "authorized to work in Canada?" → "${workAuth.canadaAuthorized === "yes" ? "Yes" : workAuth.canadaAuthorized === "no" ? "No" : "SKIP"}" (SKIP if not set)
   - "authorized to work in UK / United Kingdom?" → "${workAuth.ukAuthorized === "yes" ? "Yes" : workAuth.ukAuthorized === "no" ? "No" : "SKIP"}" (SKIP if not set)
   - "require visa sponsorship?" / "need sponsorship now or future?" → "${workAuth.needsVisaSponsorship === "yes" ? "Yes" : "No"}"
   - "work permit" / "right to work" → use country-specific authorization above
   - For select dropdowns: match the closest option to Yes/No answer

3. IN-PERSON / HYBRID / REMOTE QUESTIONS
   - "open to working in-person X% of time?" → If X <= ${inPersonPct}, answer "Yes". If X > ${inPersonPct}, answer "No".
   - "comfortable working hybrid?" → answer "Yes" if mode is hybrid or flexible
   - "open to onsite/in-office?" → answer "Yes" if mode is onsite or flexible or hybrid
   - "prefer remote?" → answer "${workMode === "remote" || workMode === "flexible" ? "Yes" : "No"}"
   - For radio/select: choose the option that best matches the preference

4. TRAVEL QUESTIONS
   - "willing to travel X%?" or "travel requirement X%?" → If X <= ${travelPct}, answer "Yes". If X > ${travelPct}, answer "No".
   - "open to business travel?" → "Yes" if travelPercent > 0

5. RELOCATION QUESTIONS
   - "willing to relocate?" → "${relocate}"
   - "open to relocation?" → "${relocate}"

6. SALARY / COMPENSATION
   - "expected salary" / "desired compensation" → "${expectedSalary}"
   - "current salary" / "current CTC" → use "Open to discussion" if not known
   - "open to negotiation?" → "${sal.openToNegotiation === "no" ? "No" : "Yes"}"
   - For numeric fields: use the numeric value from expected salary if available

7. AVAILABILITY / NOTICE PERIOD
   - "notice period?" / "how much notice do you need?" → "${noticePeriod}"
   - "when can you start?" / "earliest start date?" → "${startDate}"
   - "available immediately?" → "${startDate.toLowerCase().includes("immediately") ? "Yes" : "No"}"
   - "currently employed?" → "${avail.currentlyEmployed === "yes" ? "Yes" : avail.currentlyEmployed === "no" ? "No" : "Yes"}"

8. YEARS OF EXPERIENCE
   - "years of experience in [technology/field]?" → Estimate based on resume experience
   - "total years of experience?" → "${applicant.yearsExperience ?? applicant.experience.length ?? "3"}"
   - For specific tech stack questions, check if it appears in experience/skills

9. EDUCATION FIELDS
   - University/school → "${applicant.education[0]?.institution ?? ""}"
   - Degree → "${applicant.education[0]?.degree ?? ""}"
   - Major/field of study → "${applicant.education[0]?.field_of_study ?? ""}"
   - Graduation year → "${applicant.education[0]?.end_year ?? ""}"

10. EEO / DEMOGRAPHIC QUESTIONS (all optional — use decline if not set)
    - Gender → "${eeo.gender || "Decline to state"}"
    - Veteran status → "${eeo.veteran || "Decline to state"}"
    - Disability → "${eeo.disability || "Decline to state"}"
    - Ethnicity → "${eeo.declineEthnicity ? "Decline to state" : (eeo.ethnicities?.join(", ") || "Decline to state")}"
    - For dropdowns: select the matching option or "Prefer not to answer"

11. LINKS
    - LinkedIn URL → "${applicant.links.linkedin ?? ""}"
    - Portfolio/website → "${applicant.links.portfolio ?? ""}"
    - GitHub → "${applicant.links.github ?? ""}"

12. COVER LETTER AND OPEN-ENDED QUESTIONS
    - "cover letter" → Write 2-3 paragraphs. DO NOT dump the entire resume.
    - "why this company?" / "why are you interested?" → Write 2-3 sentences referencing the applicant's skills and the role
    - "tell us about yourself" → 2-3 sentence professional summary from experience
    - "describe a project" / "describe experience with X" → Pick the most relevant experience entry

13. YES/NO SCREENING QUESTIONS (for checkboxes, radios, or selects)
    - "agree to terms / background check / drug test?" → check/Yes
    - "are you 18 or older?" → Yes
    - "do you have experience with [X]?" → Yes if X appears in skills or experience description
    - "do you have a degree in [X]?" → check education

14. GENERAL RULES
    - NEVER dump the full resume text into a single field
    - For text fields: max 200 characters unless it is clearly a large text area
    - For "how did you hear about us?" or source/referral fields → action="skip" unless the applicant's profile explicitly has this info
    - Skip fields already filled (currentValue is non-empty)
    - Use action "skip" for password, hidden, captcha, and clearly irrelevant fields
    - Use action "upload" for file inputs that ask for resume/CV
    - If a field asks for something not in the applicant profile (hobby, favorite food, etc.) → action="skip"
    - For select/dropdown/radio fields, use action="select" with the matching option text, or action="check" for radio/checkbox

Actions available: "type" | "select" | "upload" | "check" | "click" | "skip"

Return ONLY a valid JSON array. No explanation, no markdown fences.`;

  try {
    console.log("   🧠 Calling Gemini to analyze form fields...");
    const response = await model.generateContent([prompt]);
    const text = response.response.text();
    console.log(`   🧠 Gemini responded (${text.length} chars)`);

    // Parse the response
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced?.[1] ?? trimmed;
    const parsed = JSON.parse(candidate) as FillInstruction[];

    console.log(`   🧠 Parsed ${parsed.length} fill instructions from Gemini`);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("   ✖ Gemini failed:", err instanceof Error ? err.message : err);
    console.log("   → Falling back to rule-based fill");
    return ruleFill(fields, applicant);
  }
}

// ─────────────────────────────────────────────────────
// Rule-based fallback when Gemini is unavailable
// ─────────────────────────────────────────────────────

function ruleFill(fields: FormField[], applicant: ApplicantData): FillInstruction[] {
  const instructions: FillInstruction[] = [];

  const workAuth = applicant.workAuth ?? {};
  const avail = applicant.availability ?? {};
  const sal = applicant.salary ?? {};
  const prefs = applicant.workPreferences ?? {};
  const eeo = applicant.eeo ?? {};

  const noticePeriod = avail.noticePeriod || "2 weeks";
  const startDate = avail.earliestStartDate || "Within 2 weeks";
  const expectedSalary = sal.expected ? `${sal.expected} ${sal.currency ?? "USD"}` : "Open to discussion";
  const inPersonPct = parseInt(prefs.inPersonPercent || "25", 10);
  const travelPct = parseInt(prefs.travelPercent || "25", 10);

  for (const f of fields) {
    if (!f.isVisible) continue;

    const hint = `${f.label} ${f.name} ${f.placeholder} ${f.id} ${f.ariaLabel}`.toLowerCase();

    let action: FillInstruction["action"] = "skip";
    let value = "";

    if (f.type === "file") {
      action = "upload";
      value = "resume";
    } else if (f.type === "checkbox") {
      if (hint.match(/agree|terms|consent|acknowledge|certif|author/i)) {
        action = "check";
      } else if (hint.match(/currently.?work|current.?employer|still.?work/i)) {
        action = "skip"; // depends on experience
      }
    } else if (f.type === "radio" || f.type === "select" || f.tag === "custom-select") {
      // Work authorization — only fill if explicitly set in profile
      if (hint.match(/authoriz|eligible|legal.*(work|employ)|right to work/i)) {
        if (hint.match(/us|united states|america/i) && workAuth.usAuthorized) {
          action = "select"; value = workAuth.usAuthorized === "no" ? "No" : "Yes";
        } else if (hint.match(/canada|canadian/i) && workAuth.canadaAuthorized) {
          action = "select"; value = workAuth.canadaAuthorized === "no" ? "No" : "Yes";
        } else if (hint.match(/uk|united kingdom|britain/i) && workAuth.ukAuthorized) {
          action = "select"; value = workAuth.ukAuthorized === "no" ? "No" : "Yes";
        }
        // If not specified in profile, leave as skip
      } else if (hint.match(/visa|sponsor/i) && workAuth.needsVisaSponsorship) {
        action = "select"; value = workAuth.needsVisaSponsorship === "yes" ? "Yes" : "No";
      } else if (hint.match(/relocat/i) && prefs.willingToRelocate) {
        action = "select"; value = prefs.willingToRelocate === "no" ? "No" : "Yes";
      } else if (hint.match(/remote|hybrid|onsite|in.?person|work.*mode|work.*type/i) && prefs.mode) {
        action = "select"; value = prefs.mode;
      } else if (hint.match(/gender/i) && eeo.gender) {
        action = "select"; value = eeo.gender;
      } else if (hint.match(/veteran|military/i) && eeo.veteran) {
        action = "select"; value = eeo.veteran;
      } else if (hint.match(/disabilit/i) && eeo.disability) {
        action = "select"; value = eeo.disability || "Decline to state";
      } else if (hint.match(/race|ethnic/i)) {
        action = "select"; value = eeo.declineEthnicity ? "Decline to state" : (eeo.ethnicities?.[0] || "Decline to state");
      } else if (hint.match(/employment.?type|job.?type/i) && applicant.roles?.employmentTypes?.length) {
        action = "select"; value = applicant.roles.employmentTypes[0];
      }
      // "how did you hear" / source / referral → skip (no guessing)
    } else if (f.tag === "textarea" || f.type === "textarea") {
      if (hint.match(/cover|letter|why|about|yourself|message|interest/i)) {
        action = "type";
        value = applicant.coverLetter ?? `Dear Hiring Manager,\n\nI am writing to apply for this position. With ${applicant.yearsExperience ?? applicant.experience.length ?? "several"} years of experience in ${applicant.skills.slice(0, 3).join(", ")}, I am confident I can make a strong contribution.\n\nI look forward to discussing how my background aligns with your team's needs.\n\nBest regards,\n${applicant.personal.firstName} ${applicant.personal.lastName}`;
      } else if (hint.match(/experience|background|descri/i)) {
        action = "type";
        value = applicant.experience.slice(0, 2).map(e => `${e.job_title} at ${e.company}: ${(e.description ?? "").slice(0, 150)}`).join("\n\n");
      }
    } else {
      // Text-like inputs — only fill if we have the data (empty string = stay as skip)
      if (hint.match(/first.?name/i) && applicant.personal.firstName) { action = "type"; value = applicant.personal.firstName; }
      else if (hint.match(/last.?name|surname|family.?name/i) && applicant.personal.lastName) { action = "type"; value = applicant.personal.lastName; }
      else if (hint.match(/full.?name/i) && applicant.personal.firstName) { action = "type"; value = `${applicant.personal.firstName} ${applicant.personal.lastName}`; }
      else if ((hint.match(/email/i) || f.type === "email") && applicant.personal.email) { action = "type"; value = applicant.personal.email; }
      else if ((hint.match(/phone|mobile|cell/i) || f.type === "tel") && applicant.personal.phone) { action = "type"; value = applicant.personal.phone; }
      else if (hint.match(/city|location|address/i) && applicant.personal.location) { action = "type"; value = applicant.personal.location; }
      else if (hint.match(/linkedin/i) && applicant.links.linkedin) { action = "type"; value = applicant.links.linkedin; }
      else if (hint.match(/github/i) && applicant.links.github) { action = "type"; value = applicant.links.github; }
      else if (hint.match(/portfolio|website/i) && (applicant.links.portfolio || applicant.links.linkedin)) { action = "type"; value = applicant.links.portfolio ?? applicant.links.linkedin ?? ""; }
      else if (hint.match(/year.*experience|experience.*year/i) && (applicant.yearsExperience || applicant.experience.length)) { action = "type"; value = applicant.yearsExperience ?? String(applicant.experience.length); }
      else if (hint.match(/notice.?period/i) && avail.noticePeriod) { action = "type"; value = noticePeriod; }
      else if (hint.match(/start.?date|earliest|when.*start/i) && avail.earliestStartDate) { action = "type"; value = startDate; }
      else if (hint.match(/salary|compensation|pay|ctc|expected/i) && sal.expected) { action = "type"; value = expectedSalary; }
      else if (hint.match(/school|university|college|institution/i) && applicant.education[0]?.institution) { action = "type"; value = applicant.education[0].institution!; }
      else if (hint.match(/degree|qualification/i) && applicant.education[0]?.degree) { action = "type"; value = applicant.education[0].degree!; }
      else if (hint.match(/major|field.?of.?study|specializ/i) && applicant.education[0]?.field_of_study) { action = "type"; value = applicant.education[0].field_of_study!; }
      else if (hint.match(/graduation|grad.?year/i) && applicant.education[0]?.end_year) { action = "type"; value = String(applicant.education[0].end_year); }
      else if (hint.match(/current.?title|job.?title|position/i) && applicant.experience[0]?.job_title) { action = "type"; value = applicant.experience[0].job_title!; }
      else if (hint.match(/current.?company|employer/i) && applicant.experience[0]?.company) { action = "type"; value = applicant.experience[0].company!; }
      // In-person % checks
      else if (hint.match(/in.?person|onsite|office.*(\d+)%|(\d+)%.*office/i) && prefs.inPersonPercent) {
        const pctMatch = hint.match(/(\d+)%/);
        if (pctMatch) {
          const required = parseInt(pctMatch[1], 10);
          action = "type"; value = required <= inPersonPct ? "Yes" : "No";
        }
      }
      // Travel % checks
      else if (hint.match(/travel.*(\d+)%|(\d+)%.*travel/i) && prefs.travelPercent) {
        const pctMatch = hint.match(/(\d+)%/);
        if (pctMatch) {
          const required = parseInt(pctMatch[1], 10);
          action = "type"; value = required <= travelPct ? "Yes" : "No";
        }
      }
    }

    if (action !== "skip" && value) {
      instructions.push({ index: f.index, selector: f.selector, action, value });
    } else if (action === "check" || action === "upload") {
      instructions.push({ index: f.index, selector: f.selector, action, value });
    }
  }

  return instructions;
}

// ─────────────────────────────────────────────────────
// Execute the fill instructions on the page
// ─────────────────────────────────────────────────────

async function executeFillInstructions(
  page: Page,
  instructions: FillInstruction[],
  resumePath?: string,
  log?: (msg: string) => Promise<void>
): Promise<{ filled: number; skipped: number; failed: number }> {
  let filled = 0;
  let skipped = 0;
  let failed = 0;

  for (const instr of instructions) {
    if (instr.action === "skip") { skipped++; continue; }
    console.log(`     → [${instr.action}] selector="${instr.selector}" value="${instr.value.slice(0, 40)}"`);
    try {
      const el = page.locator(instr.selector).first();
      const count = await el.count().catch(() => 0);
      if (count === 0) {
        // Try a broader fallback selector
        failed++;
        continue;
      }

      // Bypassing visibility checks specifically for file upload inputs since they are nearly always hidden natively by the browser/UI framework
      if (instr.action !== "upload") {
        const visible = await el.isVisible().catch(() => false);
        if (!visible) {
          try { await el.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch { failed++; continue; }
        }
      }

      switch (instr.action) {
        case "type": {
          const editable = await el.isEditable().catch(() => false);
          if (!editable) { skipped++; continue; }

          await el.click({ delay: 60 }).catch(() => {});
          await el.fill("").catch(() => {}); // clear
          // Type with human-like delays
          for (const char of instr.value) {
            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 40) + 15 });
          }
          filled++;
          await log?.(`Filled: "${instr.value.slice(0, 50)}${instr.value.length > 50 ? "…" : ""}"`);
          await page.waitForTimeout(200 + Math.random() * 300);
          break;
        }

        case "select": {
          let selectSuccess = false;

          // 1. Native <select> — exact match
          try {
            await el.selectOption({ label: instr.value }, { timeout: 2000 });
            selectSuccess = true;
          } catch { /* try partial */ }

          // 2. Native <select> — partial / case-insensitive match
          if (!selectSuccess) {
            try {
              const options = await el.locator("option").allTextContents();
              const match = options.find(o =>
                o.toLowerCase().includes(instr.value.toLowerCase()) ||
                instr.value.toLowerCase().includes(o.toLowerCase().trim())
              );
              if (match) {
                await el.selectOption({ label: match }, { timeout: 2000 });
                selectSuccess = true;
              }
            } catch { /* fall through */ }
          }

          // 3. Custom ATS dropdowns (React-Select, Workday, Greenhouse, etc.)
          //    Click the container to open, then find option by text
          if (!selectSuccess) {
            try {
              await el.click({ timeout: 3000 });
              await page.waitForTimeout(500);
              const escaped = instr.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const valueRe = new RegExp(escaped, 'i');
              const candidateLocators = [
                page.locator(`[role="option"]`).filter({ hasText: valueRe }),
                page.locator(`[role="listbox"] li`).filter({ hasText: valueRe }),
                page.locator(`li[class*="option"]`).filter({ hasText: valueRe }),
                page.locator(`[class*="menu"] [class*="option"]`).filter({ hasText: valueRe }),
                page.locator(`[class*="dropdown"] li`).filter({ hasText: valueRe }),
              ];
              for (const loc of candidateLocators) {
                if (await loc.count() > 0 && await loc.first().isVisible().catch(() => false)) {
                  await loc.first().click({ timeout: 2000 });
                  selectSuccess = true;
                  break;
                }
              }
              if (!selectSuccess) await page.keyboard.press("Escape").catch(() => {});
            } catch { /* give up */ }
          }

          if (selectSuccess) {
            filled++;
            await log?.(`Selected: "${instr.value}"`);
          } else {
            failed++;
          }
          break;
        }

        case "upload": {
          if (resumePath) {
            try {
              // Check if it's actually an input field natively
              const isNativeInput = await el.evaluate(e => e.tagName.toLowerCase() === 'input' && (e as HTMLInputElement).type === 'file').catch(() => false);
              
              if (isNativeInput) {
                await el.setInputFiles(resumePath);
              } else {
                // If it's a custom button, we must click it and catch the OS filechooser dialog
                const [fileChooser] = await Promise.all([
                   page.waitForEvent('filechooser', { timeout: 10000 }),
                   el.click({ force: true })
                ]);
                await fileChooser.setFiles(resumePath);
              }
              
              filled++;
              await log?.("Uploaded resume file");
            } catch (err) {
              failed++;
              await log?.("Failed to upload resume");
            }
          } else {
            skipped++;
          }
          break;
        }

        case "check": {
          const checked = await el.isChecked().catch(() => false);
          if (!checked) {
            await el.check({ force: true }).catch(() => {});
            filled++;
            await log?.("Checked checkbox");
          } else {
            skipped++;
          }
          break;
        }

        case "click": {
          await el.click().catch(() => {});
          filled++;
          break;
        }
      }
    } catch {
      failed++;
    }
  }

  return { filled, skipped, failed };
}

// ─────────────────────────────────────────────────────
// Save resume text as a PDF file for upload
// ─────────────────────────────────────────────────────

function escapePdfText(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapResumeLines(text: string, maxChars = 95): string[] {
  const rawLines = text.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const line of rawLines) {
    const normalized = line.trimEnd();
    if (!normalized) {
      wrapped.push("");
      continue;
    }

    let cursor = normalized;
    while (cursor.length > maxChars) {
      wrapped.push(cursor.slice(0, maxChars));
      cursor = cursor.slice(maxChars);
    }
    wrapped.push(cursor);
  }

  return wrapped;
}

function buildResumePdfBuffer(resumeText: string): Buffer {
  const lines = wrapResumeLines(resumeText).slice(0, 60);
  const lineCommands = lines
    .map((line, index) => {
      const y = 760 - (index * 12);
      return `1 0 0 1 50 ${y} Tm (${escapePdfText(line || " ")}) Tj`;
    })
    .join("\n");

  const stream = `BT\n/F1 10 Tf\n${lineCommands}\nET`;
  const streamLength = Buffer.byteLength(stream, "utf8");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (const objectText of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += objectText;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

async function prepareResumeFile(resumeText: string, applicationId: string): Promise<string> {
  const dir = path.resolve(process.cwd(), "runtime", "resumes", applicationId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "resume.pdf");
  const pdfBuffer = buildResumePdfBuffer(resumeText);
  await fs.writeFile(filePath, pdfBuffer);
  return filePath;
}

async function prepareCanonicalResumeFile(
  applicant: ApplicantData,
  applicationId: string,
  log: (msg: string) => Promise<void>
): Promise<string> {
  const resumeCanonical = applicant.resumeCanonical;

  if (!resumeCanonical) {
    // Fallback: use raw resumeText to build a simple PDF
    if (applicant.resumeText) {
      try {
        const filePath = await prepareResumeFile(applicant.resumeText, applicationId);
        await log("Prepared resume for upload (from resumeText fallback)");
        return filePath;
      } catch (error) {
        await log(`Resume preparation failed: ${error instanceof Error ? error.message : "unknown error"}`);
        throw error;
      }
    }
    throw new Error("Missing canonical resume and no resumeText — cannot upload resume");
  }

  const computed = buildResumeCanonical(resumeCanonical);

  if (computed !== resumeCanonical.rawText) {
    throw new Error("Canonical mismatch — blocking submission");
  }

  try {
    const filePath = await prepareResumeFile(computed, applicationId);
    await log(`Prepared resume for upload (Canonical)`);
    return filePath;
  } catch (error) {
    await log(`Resume preparation failed (${error instanceof Error ? error.message : "unknown error"})`);
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Detect and click "Apply" / "Continue" / "Next" buttons
// ─────────────────────────────────────────────────────

async function clickApplyOrNextButton(page: Page): Promise<boolean> {
  const buttonTexts = [
    "Apply Now", "Apply for this job", "Apply", "Start Application",
    "Continue", "Next", "Next Step", "Proceed",
    "Begin Application", "Submit Application"
  ];

  for (const text of buttonTexts) {
    try {
      // Create an array of locators to try for this text
      const locatorsToTry = [
        page.getByRole("button", { name: new RegExp(text, "i") }),
        page.locator(`text="${text}"`), // Exact text match
        page.locator(`text=${text}`)   // Substring text match
      ];

      for (const locators of locatorsToTry) {
        const count = await locators.count();
        for (let i = 0; i < count; i++) {
          const btn = locators.nth(i);
          try {
            if (await btn.isVisible({ timeout: 500 })) {
              // Try standard click
              try { await btn.scrollIntoViewIfNeeded(); } catch {}
              await page.waitForTimeout(500);
              // Aggressive forced click to bypass any invisible overlay or sticky footer
              await btn.click({ timeout: 2000, force: true }).catch(async () => {
                 // Fallback to evaluating javascript click natively
                 await btn.evaluate(node => (node as HTMLElement).click());
              });
              await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
              await page.waitForTimeout(2000);
              return true;
            }
          } catch { /* Ignore invisible or unclickable elements */ }
        }
      }
    } catch { /* Try next text */ }
  }

  return false;
}

// ─────────────────────────────────────────────────────
// PUBLIC: The main intelligent fill function
// ─────────────────────────────────────────────────────

export async function intelligentlyFillPage(
  page: Page,
  applicant: ApplicantData,
  log: (msg: string) => Promise<void>
): Promise<{
  totalFilled: number;
  totalSkipped: number;
  totalFailed: number;
  pagesProcessed: number;
}> {
  let totalFilled = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let pagesProcessed = 0;
  const maxPages = 8; // safety limit for multi-step forms

  // Prepare resume file in case we need to upload it
  let resumePath: string | undefined;
  try {
    resumePath = await prepareCanonicalResumeFile(applicant, Date.now().toString(), log);
  } catch (err) {
    await log(`Resume file preparation skipped: ${err instanceof Error ? err.message : "unknown"}`);
    resumePath = undefined;
  }

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    pagesProcessed++;
    await log(`\n── Analyzing form page ${pageNum + 1} ──`);

    // Wait for the page to be stable
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Extract form fields
    const formFields = await extractFormFields(page);
    const checkboxes = await extractCheckboxesAndRadios(page);
    const allFields = [...formFields, ...checkboxes];

    const visibleFields = allFields.filter(f => f.isVisible);
    console.log(`   📋 Page ${pageNum + 1}: ${allFields.length} total fields, ${visibleFields.length} visible`);
    for (const f of visibleFields.slice(0, 10)) {
      console.log(`      - [${f.index}] ${f.tag} type=${f.type} label="${f.label.slice(0, 40)}" name="${f.name}" id="${f.id}"`);
    }
    if (visibleFields.length > 10) console.log(`      ... and ${visibleFields.length - 10} more`);
    await log(`Found ${visibleFields.length} visible form fields`);

    if (visibleFields.length === 0) {
      // Maybe this page has no form, try clicking Apply
      await log("No form fields found — looking for Apply/Continue button");
      const clicked = await clickApplyOrNextButton(page);
      if (clicked) {
        await log("Clicked button — waiting for next page");
        continue;
      }
      await log("No more forms or buttons found — done");
      break;
    }

    // Ask Gemini what to put in each field
    const pageTitle = await page.title().catch(() => "");
    const pageUrl = page.url();
    await log(`Asking AI to analyze ${visibleFields.length} fields on "${pageTitle}"`);

    const instructions = await askGeminiWhatToFill(allFields, applicant, pageTitle, pageUrl);
    await log(`AI returned ${instructions.filter(i => i.action !== "skip").length} fill actions`);

    // Execute
    const result = await executeFillInstructions(page, instructions, resumePath, log);
    totalFilled += result.filled;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    await log(`Page ${pageNum + 1}: filled ${result.filled}, skipped ${result.skipped}, failed ${result.failed}`);

    // After filling, take a breath and check for a Next/Continue button
    await page.waitForTimeout(1000);

    // Look for a "Next" button to advance multi-step forms
    const hasNext = await clickApplyOrNextButton(page);
    if (hasNext) {
      await log("Advanced to next form page");
      continue;
    }

    // No more "next" button visible — we've filled the final page
    await log("No next/continue button found — form fill complete");
    break;
  }

  return { totalFilled, totalSkipped, totalFailed, pagesProcessed };
}

export { clickApplyOrNextButton };
