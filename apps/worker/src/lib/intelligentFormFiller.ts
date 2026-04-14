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
}

function getResumeTextForContext(applicant: ApplicantData): string {
  if (applicant.resumeCanonical) {
    return applicant.resumeCanonical.rawText;
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
      const parent = el.closest("label");
      const labelText = parent?.textContent?.trim() ?? el.getAttribute("aria-label") ?? "";

      fields.push({
        index: 1000 + idx,
        tag: "input",
        type: el.type,
        name: el.name ?? "",
        id: el.id ?? "",
        placeholder: "",
        label: labelText,
        required: el.required,
        currentValue: el.checked ? "checked" : "unchecked",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        dataTestId: el.getAttribute("data-testid") ?? "",
        selector: el.id ? `#${CSS.escape(el.id)}` : `input[name="${CSS.escape(el.name)}"]`,
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

  const prompt = `You are an AI job application assistant. You are filling out a job application form.

PAGE: "${pageTitle}" (${pageUrl})

APPLICANT PROFILE:
- Name: ${applicant.personal.firstName} ${applicant.personal.lastName}
- Email: ${applicant.personal.email}
- Phone: ${applicant.personal.phone}
- Location: ${applicant.personal.location}
- Skills: ${applicant.skills.join(", ")}
${applicant.links.linkedin ? `- LinkedIn: ${applicant.links.linkedin}` : ""}
${applicant.links.portfolio ? `- Portfolio: ${applicant.links.portfolio}` : ""}

EDUCATION:
${educationBlock}

EXPERIENCE:
${experienceBlock}

${answersBlock}

RESUME TEXT (FOR CONTEXT ONLY):
${getResumeTextForContext(applicant).slice(0, 3000)}

FORM FIELDS FOUND ON PAGE:
${fieldDescriptions}

INSTRUCTIONS:
For each field, decide what to fill. Return a JSON array of objects.

CRITICAL RULES:
1. NEVER, EVER paste the entire resume text into a single field unless it's a specific "Paste your resume here" area.
2. For Experience/Education fields: Use the structured data above. Provide concise summaries or specific titles/companies/dates as requested by the field label.
3. If a field asks for "Experience" or "Work History" as a single textarea, summarize the top 3 roles concisely. DO NOT dump the whole resume.
4. For text fields (School, Major, Title): Use MAXIMUM 80 characters.
5. Fill ALL visible required fields.
6. For name: use "${applicant.personal.firstName}" and "${applicant.personal.lastName}".
7. For phone: use "${applicant.personal.phone}". Match country codes exactly in selects.
8. For address/postal: Check SPECIFIC FORM ANSWERS first. If missing, use "${applicant.personal.location}" or realistic defaults for that city.
9. For "cover letter": Write a compelling 2-3 paragraph letter if required.
10. For salary: "Open to discussion".
11. Return ONLY a JSON array.`;

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
      }
    } else if (f.type === "select") {
      // Skip selects in rule mode (too risky to guess)
      action = "skip";
    } else if (f.tag === "textarea" || f.type === "textarea") {
      if (hint.match(/cover|letter|why|about|yourself|message|interest/i)) {
        action = "type";
        value = applicant.coverLetter ?? `Dear Hiring Manager,\n\nI am excited to apply for this position. I am confident I can make a meaningful contribution to your team.\n\nI bring a strong background in building reliable systems and collaborating across teams. I am eager to learn about this opportunity and discuss how my skills align with your needs.\n\nBest regards,\n${applicant.personal.firstName} ${applicant.personal.lastName}`;
      }
    } else {
      // Text-like inputs
      if (hint.match(/first.?name/i)) { action = "type"; value = applicant.personal.firstName ?? ""; }
      else if (hint.match(/last.?name|surname|family.?name/i)) { action = "type"; value = applicant.personal.lastName ?? ""; }
      else if (hint.match(/full.?name/i)) { action = "type"; value = `${applicant.personal.firstName} ${applicant.personal.lastName}`; }
      else if (hint.match(/email/i) || f.type === "email") { action = "type"; value = applicant.personal.email ?? ""; }
      else if (hint.match(/phone|mobile|cell/i) || f.type === "tel") { action = "type"; value = applicant.personal.phone ?? ""; }
      else if (hint.match(/city|location|address/i)) { action = "type"; value = applicant.personal.location ?? ""; }
      else if (hint.match(/linkedin/i)) { action = "type"; value = applicant.links.linkedin ?? ""; }
      else if (hint.match(/portfolio|website|github|url/i)) { action = "type"; value = applicant.links.portfolio ?? applicant.links.linkedin ?? ""; }
      else if (hint.match(/year.*experience/i)) { action = "type"; value = applicant.yearsExperience ?? "5"; }
      else if (hint.match(/salary|compensation|pay/i)) { action = "type"; value = "Open to discussion based on total compensation"; }
      else if (hint.match(/start.?date|available|earliest/i)) { action = "type"; value = "Within 2 weeks"; }
      else if (hint.match(/source|how.*hear|referr/i)) { action = "type"; value = "Company website"; }
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
          try {
            // Try exact match first
            await el.selectOption({ label: instr.value });
          } catch {
            // Try partial match
            try {
              const options = await el.locator("option").allTextContents();
              const match = options.find(o => o.toLowerCase().includes(instr.value.toLowerCase()));
              if (match) {
                await el.selectOption({ label: match });
              }
            } catch { /* skip */ }
          }
          filled++;
          await log?.(`Selected: "${instr.value}"`);
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
    throw new Error("Missing canonical resume — aborting application");
  }

  const computed = buildResumeCanonical(resumeCanonical);

  if (computed !== resumeCanonical.rawText) {
    throw new Error("Canonical mismatch — blocking submission");
  }

  try {
    const filePath = await prepareResumeFile(resumeCanonical.rawText, applicationId);
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
  resumePath = await prepareCanonicalResumeFile(applicant, Date.now().toString(), log);

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
