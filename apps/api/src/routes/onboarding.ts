import { Router, type Request, type Response, type NextFunction } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";

type ExtractedProfile = {
  personal: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: string;
  };
  education: Array<{
    school: string;
    major: string;
    degree: string;
    gpa: number | null;
    startMonth: number | null;
    startYear: number | null;
    endMonth: number | null;
    endYear: number | null;
  }>;
  experience: Array<{
    title: string;
    company: string;
    location: string;
    type: string;
    startMonth: number | null;
    startYear: number | null;
    endMonth: number | null;
    endYear: number | null;
    current: boolean;
    description: string;
  }>;
  skills: string[];
  links: {
    linkedin: string;
    github: string;
    portfolio: string;
  };
};

function extractEmail(text: string): string {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? "";
}

function extractPhone(text: string): string {
  const match = text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match?.[0] ?? "";
}

function extractLinksFromText(text: string): { linkedin: string; github: string; portfolio: string } {
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s)]+/gi)).map((m) => m[0]);
  return {
    linkedin: urls.find((url) => /linkedin\.com/i.test(url)) ?? "",
    github: urls.find((url) => /github\.com/i.test(url)) ?? "",
    portfolio: urls.find((url) => !/linkedin\.com|github\.com/i.test(url)) ?? ""
  };
}

function extractSkillsFromText(text: string): string[] {
  const keywords = [
    "JavaScript", "TypeScript", "React", "Node.js", "Python", "Java", "C++", "SQL",
    "PostgreSQL", "MongoDB", "AWS", "Docker", "Kubernetes", "Git", "Next.js", "Express"
  ];
  const lowerText = text.toLowerCase();
  return keywords.filter((skill) => lowerText.includes(skill.toLowerCase()));
}

function extractNameFromResume(text: string): { firstName: string; lastName: string } {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !!line && !line.includes("@") && line.split(/\s+/).length <= 4);

  if (!firstLine) {
    return { firstName: "", lastName: "" };
  }

  const parts = firstLine.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts[parts.length - 1] : ""
  };
}

function buildLocalExtractedProfile(resumeText: string): ExtractedProfile {
  const email = extractEmail(resumeText);
  const phone = extractPhone(resumeText);
  const links = extractLinksFromText(resumeText);
  const name = extractNameFromResume(resumeText);

  return {
    personal: {
      firstName: name.firstName,
      lastName: name.lastName,
      email,
      phone,
      location: ""
    },
    education: [
      {
        school: "",
        major: "",
        degree: "",
        gpa: null,
        startMonth: null,
        startYear: null,
        endMonth: null,
        endYear: null
      }
    ],
    experience: [
      {
        title: "",
        company: "",
        location: "",
        type: "",
        startMonth: null,
        startYear: null,
        endMonth: null,
        endYear: null,
        current: false,
        description: ""
      }
    ],
    skills: extractSkillsFromText(resumeText),
    links
  };
}

function buildLocalChatFallback(messages: Array<{ role: "user" | "assistant"; content: string }>, resumeText?: string) {
  if (messages.length <= 1) {
    if (resumeText) {
      const extracted = buildLocalExtractedProfile(resumeText);
      return {
        message: "I imported your resume using local parsing. Let's confirm your education first: what is your most recent school name?",
        field: "school",
        section: "education",
        action: "ask",
        progress: 10,
        data: extracted
      };
    }
    return {
      message: "Let's start building your profile. What is your school name?",
      field: "school",
      section: "education",
      action: "ask",
      progress: 0,
      data: {}
    };
  }

  return {
    message: "I am in local fallback mode right now. Please continue with one detail at a time, starting with your latest education.",
    field: "education",
    section: "education",
    action: "ask",
    progress: 15,
    data: {}
  };
}

// ──────────────────────────────────────────────
// System prompt for the onboarding AI
// ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI onboarding assistant for a job automation platform.

Your job is to build a complete, structured user profile by:
1. Extracting data from the user's resume (if provided)
2. Pre-filling fields using that data
3. Asking the user to confirm or correct extracted information
4. Asking ONLY for missing or low-confidence fields
5. Storing all data in a structured format

-------------------------
CORE BEHAVIOR RULES
-------------------------

- Ask ONLY ONE question at a time
- NEVER ask for multiple fields in one message
- ALWAYS prioritize using resume data first
- ALWAYS confirm extracted data before modifying it
- NEVER ask for data that is already confirmed
- If user says "yes" or "correct", move forward
- If user edits, update only that specific field
- If user says "skip", skip optional fields
- Be concise, direct, and clear
- Do NOT explain internal logic
- Do NOT hallucinate missing data

-------------------------
FLOW ORDER
-------------------------

1. Resume Extraction (if resume is provided)
2. Education
3. Experience
4. Work Authorization
5. EEO (optional, allow skip)
6. Skills
7. Personal Information
8. Links

-------------------------
RESUME EXTRACTION INSTRUCTIONS
-------------------------

If resume text is provided, extract structured data in this format:

{
  "education": [
    {
      "school": "",
      "major": "",
      "degree": "",
      "gpa": null,
      "startMonth": null,
      "startYear": null,
      "endMonth": null,
      "endYear": null
    }
  ],
  "experience": [
    {
      "title": "",
      "company": "",
      "location": "",
      "type": "",
      "startMonth": null,
      "startYear": null,
      "endMonth": null,
      "endYear": null,
      "current": false,
      "description": ""
    }
  ],
  "skills": [],
  "links": {
    "linkedin": "",
    "github": "",
    "portfolio": ""
  },
  "personal": {
    "phone": "",
    "location": ""
  }
}

Rules:
- Do NOT hallucinate
- If missing, return null or empty
- Normalize values (e.g., B.Tech -> Bachelor's)
- Keep skills clean and deduplicated

-------------------------
CONFIRMATION LOGIC
-------------------------

If data is extracted:

- Show it clearly
- Ask user: "Is this correct?"

Example:
"I found your education:
Vellore Institute of Technology, Electrical Engineering, Bachelor's.
Is this correct?"

If user confirms -> mark as confirmed and move on
If user edits -> update only that field
If partial data missing -> ask only missing parts

-------------------------
DYNAMIC BEHAVIOR
-------------------------

- If user has no experience -> skip experience section
- If GPA missing -> ask optionally
- If current job -> do NOT ask end date
- If user says "fresher" -> skip experience

-------------------------
VALIDATION RULES
-------------------------

- Phone must be valid format
- GPA must be within valid range (0-10 or 0-4)
- Dates must be logical (start < end)
- URLs must be valid links

If invalid -> ask again clearly

-------------------------
OUTPUT FORMAT (MANDATORY)
-------------------------

After EVERY response, return ONLY valid JSON (no markdown, no backticks):

{
  "message": "question or confirmation shown to user",
  "field": "current field name",
  "section": "education | experience | workAuth | eeo | skills | personal | links",
  "action": "confirm | ask | update | skip | complete",
  "progress": number (0-100),
  "data": {
    // only include collected or updated data so far
  }
}

When ALL sections are complete, set action to "complete" and progress to 100, and include the full collected data in the "data" field.

-------------------------
IMPORTANT CONSTRAINTS
-------------------------

- NEVER ask multiple questions
- NEVER dump full data unnecessarily
- ALWAYS move step-by-step
- ALWAYS prioritize resume autofill
- KEEP UX FAST AND MINIMAL
- Return ONLY JSON, never markdown code fences

-------------------------
START BEHAVIOR
-------------------------

If resume is provided:
-> Extract data
-> Start with Education confirmation

If no resume:
-> Start by asking:
"What is your school name?"

Begin now.`;

// ──────────────────────────────────────────────
// Route handler
// ──────────────────────────────────────────────

export function createOnboardingRouter(): Router {
  const router = Router();

  router.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { messages, resumeText } = req.body as {
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        resumeText?: string;
      };

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ message: "messages array is required" });
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.json(buildLocalChatFallback(messages, resumeText));
        return;
      }

      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({
        model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
        systemInstruction: SYSTEM_PROMPT
      });

      // Build the conversation history for Gemini
      const geminiHistory: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

      // If this is the first message and we have resume text, prepend it
      const isFirstMessage = messages.length === 1;

      for (const msg of messages) {
        let content = msg.content;

        // For the first user message, inject resume context
        if (isFirstMessage && msg.role === "user" && resumeText) {
          content = `Here is my resume:\n\n${resumeText}\n\nUser message: ${msg.content}`;
        }

        geminiHistory.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: content }]
        });
      }

      // Use chat for multi-turn
      const chat = model.startChat({
        history: geminiHistory.slice(0, -1) // all except last
      });

      const lastMessage = geminiHistory[geminiHistory.length - 1];
      const result = await chat.sendMessage(lastMessage.parts[0].text);
      const responseText = result.response.text();

      // Try to parse the JSON response
      let parsed;
      try {
        // Strip markdown code fences if present
        const cleaned = responseText
          .replace(/```json\s*/gi, "")
          .replace(/```\s*/g, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // If parsing fails, wrap the raw text
        parsed = {
          message: responseText,
          field: "unknown",
          section: "unknown",
          action: "ask",
          progress: 0,
          data: {}
        };
      }

      res.json(parsed);
    } catch (error) {
      console.error("Onboarding chat error:", error);
      const { messages, resumeText } = req.body as {
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        resumeText?: string;
      };
      res.json(buildLocalChatFallback(messages ?? [], resumeText));
    }
  });

  router.post("/extract-full", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { resumeText } = req.body as { resumeText: string };
      if (!resumeText) {
        res.status(400).json({ message: "resumeText is required" });
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.json(buildLocalExtractedProfile(resumeText));
        return;
      }

      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({
        model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
      });

      const prompt = `Your task is to extract and normalize structured data from a resume.

Return ONLY valid JSON. No explanations. No extra text.

---

SCHEMA:

{
  "personal": {
    "firstName": string | null,
    "lastName": string | null,
    "email": string | null,
    "phone": string | null,
    "location": string | null
  },
  "education": [
    {
      "degree": string | null,
      "field_of_study": string | null,
      "institution": string | null,
      "start_year": number | null,
      "end_year": number | null
    }
  ],
  "experience": [
    {
      "job_title": string | null,
      "company": string | null,
      "location": string | null,
      "employment_type": "internship" | "full-time" | "part-time" | "contract" | null,
      "start_year": number | null,
      "end_year": number | null,
      "current": boolean,
      "description": string | null
    }
  ],
  "skills": string[],
  "links": {
    "linkedin": string | null,
    "github": string | null,
    "portfolio": string | null
  }
}

---

STRICT RULES:

1. NEVER mix fields.
   - A company name must NEVER go into degree.
   - A degree must NEVER go into company.
   - Job titles must NEVER go into field_of_study.

2. SPLIT combined text into correct fields.
   Example:
   "B.Tech in Computer Science - VIT Chennai (2021-2025)"
   →
   {
     "degree": "B.Tech",
     "field_of_study": "Computer Science",
     "institution": "VIT Chennai",
     "start_year": 2021,
     "end_year": 2025
   }

3. NORMALIZE values:
   - Convert dates into numeric years (e.g., "June 2022" → 2022).
   - Standardize employment_type: internship, full-time, part-time, contract.
   - Extract clean job titles (remove company names from titles).

4. CURRENT JOB HANDLING:
   - If "Present" or "Current" appears → current = true, end_year = null.

5. MISSING DATA:
   - If unsure → return null (DO NOT guess).

6. MULTIPLE ENTRIES:
   - Return ALL education and experience entries as arrays.
   - Maintain correct order (most recent first).

7. DO NOT RETURN RAW TEXT BLOCKS.

8. DO NOT hallucinate data.

---

VALIDATION BEFORE OUTPUT:
- degree must look like: B.Tech, M.Tech, MBA, Bachelor, Master, PhD.
- company must be an organization, NOT a degree.
- job_title must be a role, NOT a company.
- start_year ≤ end_year (if both exist).

If validation fails → set field to null.

---

RESUME TEXT:
${resumeText}

Return ONLY the raw JSON object.`;

      const result = await model.generateContent([prompt]);
      const text = result.response.text();
      
      const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      try {
        res.json(JSON.parse(cleaned));
      } catch {
        res.json(buildLocalExtractedProfile(resumeText));
      }
    } catch (error) {
      console.error("Full extraction error:", error);
      const { resumeText } = req.body as { resumeText?: string };
      if (!resumeText) {
        next(error);
        return;
      }
      res.json(buildLocalExtractedProfile(resumeText));
    }
  });

  return router;
}
