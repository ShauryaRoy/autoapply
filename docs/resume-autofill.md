# Resume Autofill Flow

This document explains how a resume PDF is processed and how extracted data gets filled into profile fields, then used during job application autofill.

## 1) Entry Point: Resume Upload in Desktop App

File:
- apps/desktop/src/renderer/App.tsx

Main handler:
- handleResumePdfUpload

What happens:
1. User selects a file in the Resume Upload section.
2. File is validated as PDF by MIME type or .pdf filename.
3. PDF text is extracted with pdfjs via extractResumePdfText.
4. Desktop requests API extraction using extractFullProfile(resumeText).
5. Desktop also runs local extraction with extractLocalOnboardingProfile(resumeText).
6. API result and local result are merged by mergeExtractedProfiles.
7. Merged output is applied to the profile using applyExtractedOnboardingData.
8. Profile is saved locally with saveProfile.

## 2) Extraction Sources

### Source A: High-Precision API extraction (Gemini 2.0)

Files:
- apps/desktop/src/renderer/api.ts
- apps/api/src/routes/onboarding.ts

Flow:
- Desktop calls POST /api/onboarding/extract-full with resumeText.
- API uses a high-precision prompt that enforces:
  - **Strict Field Separation**: Separates Company from Role and Degree from Institution.
  - **Normalization**: Standardizes dates to numeric years and employment types.
  - **Dumping Prevention**: Forbids returning raw text blocks; requires atomic data extraction.
- If Gemini key is missing, model fails, or JSON parse fails, API returns local fallback extraction.

### Source B: Desktop local extraction fallback

File:
- apps/desktop/src/renderer/App.tsx

Functions used:
- extractLocalOnboardingProfile
- extractFirstEducationBlock
- extractFirstExperienceBlock
- extractEmail
- extractPhone
- extractLinksFromText
- extractSkillsFromText

Purpose:
- Guarantees a minimum extraction baseline, especially for education and experience fields.

## 3) Sanitization & Validation Layer

File:
- apps/desktop/src/renderer/App.tsx

Function:
- `sanitizeExtractedData(data)`

Before extracted data is merged or applied, it passes through a validation suite:
- **`isValidDegree`**: Checks against common degree patterns (B.Tech, MS, PhD).
- **`isValidInstitution`**: Ensures the school name isn't just a degree title or an empty string.
- **`isValidJobTitle`**: Validates role names and prevents company names from bleeding into titles.
- **`isValidYear`**: Ensures dates fall within a realistic human range (1950-2050).
- **`isValidEmploymentType`**: Restricts roles to authorized types (internship, full-time, etc.).

*Result: Any field failing validation is set to `null`, preventing garbage text from polluting the profile.*

## 4) Merge Strategy (Validated Priority)

File:
- apps/desktop/src/renderer/App.tsx

Function:
- `mergeExtractedProfiles(primary, fallback)`

Rules:
1. Both `primary` (API) and `fallback` (Local) are sanitized independently.
2. **Field-Level Priority**: If the API returns a valid `institution`, it is used. If the API version is `null` (failed validation) but the Local version is valid, the Local version is used.
3. This prevents a "hallucination" from the LLM from overwriting a cleaner regex-based local match.

## 5) How Profile Fields Are Populated

File:
- apps/desktop/src/renderer/App.tsx

Function:
- `applyExtractedOnboardingData(current, extracted, resumeText)`

### Education & Experience Populated (Atomic)

Target profile fields use atomic identifiers:
- `education[0].institution`, `education[0].field_of_study`, `education[0].degree`
- `experience[0].job_title`, `experience[0].company`, `experience[0].employment_type`

Details:
- **Null Safety**: Uses nullish coalescing (`??`) to ensure that if an extracted field is `null`, it does **not** overwrite the user's existing valid profile data.
- **Title Cleaning**: Experience titles are stripped of "at [Company]" suffixes to keep fields atomic.

## 6) Answers Map Used by Form Filler

File:
- apps/desktop/src/renderer/App.tsx

Function:
- `buildProfileAnswers(profile)`

Relevant keys for the form filler:
- `institution-name`, `field-of-study`, `degree-type`
- `job-title`, `company`, `employment-type`, `experience-description`

## 7) How Autofill Uses This During Job Application

Files:
- apps/worker/src/workers/automationWorker.ts
- apps/worker/src/lib/intelligentFormFiller.ts

Flow:
1. Worker constructs **ApplicantData** using the atomic fields.
2. **Strict Logic Applied**:
   - **80-Char Limit**: Prevents the AI from entering sentences into short text inputs (School/Major).
   - **Anti-Dump Rule**: Form filler is explicitly forbidden from pasting `resumeText` into structured blocks.
   - **Priority-Lookup**: Structured blocks are prioritized over the raw resume context.

## 8) Why This System Is Now More Reliable

Reliability improvements:
- **Sanitization**: Intercepts LLM "spillover" (where one field contains data from another).
- **Atomic Regex**: Local extraction now looks for role anchors (e.g., "Engineer") rather than just line positions.
- **Fallback safety**: Local regex acts as a "sanity check" for the API extraction.

## 9) Quick Verification Checklist

1. **Upload**: Upload a text-based PDF resume in Resume Upload.
2. **Review**: Open Education/Experience sections and verify items are atomic (e.g., School Name contains ONLY the school).
3. **Save**: Save the profile to rebuild the answers map.
4. **Apply**: Run an application and verify worker logs show concise inputs (e.g., "VIT Chennai") instead of resume chunks.
5. **Validation**: Intentionally upload a "garbage" text block and verify fields remain `null` or preserve previous valid data rather than accepting the garbage.
