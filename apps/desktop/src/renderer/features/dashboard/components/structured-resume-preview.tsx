import { Fragment, type ReactNode } from "react";

type ResumeCanonicalEntry = {
  title?: string;
  role?: string;
  company?: string;
  organization?: string;
  bullets?: string[];
};

type ResumeCanonicalEducationEntry = {
  title?: string;
  school?: string;
  institution?: string;
  details?: string[];
};

export type StructuredResumeCanonical = {
  summary?: string;
  skills?: string[];
  experience?: ResumeCanonicalEntry[];
  projects?: ResumeCanonicalEntry[];
  activities?: ResumeCanonicalEntry[];
  education?: ResumeCanonicalEducationEntry[];
  keywordsInjected?: string[];
};

type StructuredResumePreviewProps = {
  canonical?: StructuredResumeCanonical;
  tailoringError?: string;
  fallbackUsed?: boolean;
  plainTextFallback?: string;
  missingSkills: string[];
  matchedSkills: string[];
  jdKeywords: string[];
  userName: string;
  email: string;
  phone: string;
  links: string;
};

function normalizeList(values: string[] | undefined): string[] {
  if (!values?.length) return [];

  const seen = new Set<string>();
  const output: string[] = [];

  values.forEach((value) => {
    const cleaned = value.trim();
    if (!cleaned) return;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    output.push(cleaned);
  });

  return output;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildContactLine(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" | ");
}

function isValidCanonical(canonical: StructuredResumeCanonical | undefined): canonical is StructuredResumeCanonical {
  if (!canonical) return false;

  const hasSummary = Boolean(canonical.summary?.trim());
  const hasSkills = (canonical.skills?.length ?? 0) > 0;
  const hasExperience = (canonical.experience?.length ?? 0) > 0;
  const hasProjects = (canonical.projects?.length ?? 0) > 0;
  const hasActivities = (canonical.activities?.length ?? 0) > 0;

  return hasSummary && hasSkills && (hasExperience || hasProjects || hasActivities);
}

function resolveEntryTitle(entry: ResumeCanonicalEntry, fallback: string): string {
  return (
    entry.title?.trim() ||
    [entry.role?.trim(), entry.company?.trim() || entry.organization?.trim()].filter(Boolean).join(" | ") ||
    fallback
  );
}

function KeywordHighlightedText({
  text,
  keywords
}: {
  text: string;
  keywords: string[];
}) {
  const cleanedKeywords = normalizeList(keywords).sort((a, b) => b.length - a.length);
  if (!text || cleanedKeywords.length === 0) {
    return <>{text}</>;
  }

  const pattern = new RegExp(`(${cleanedKeywords.map(escapeRegex).join("|")})`, "gi");
  const parts = text.split(pattern);
  const keySet = new Set(cleanedKeywords.map((keyword) => keyword.toLowerCase()));

  return (
    <>
      {parts.map((part, index) => {
        const isKeyword = keySet.has(part.toLowerCase());
        if (!isKeyword) {
          return <Fragment key={`plain-${index}`}>{part}</Fragment>;
        }

        return (
          <mark key={`hit-${index}`} className="rounded bg-amber-100 px-1 text-amber-900">
            {part}
          </mark>
        );
      })}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="border-b border-slate-300 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function ViewerShell({ children }: { children: ReactNode }) {
  return (
    <div className="w-full bg-slate-100 px-4 py-4">
      <div className="w-max min-w-full">
        <div className="mt-3 flex justify-start">
          <div className="w-[840px] bg-white p-10 shadow-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

function GeneratingView() {
  return (
    <ViewerShell>
      <section className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
        <p>Generating optimized resume...</p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-500 [animation-delay:120ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-600 [animation-delay:240ms]" />
        </div>
      </section>
    </ViewerShell>
  );
}

const PLAIN_SECTION_HEADERS = new Set([
  "summary", "professional summary", "career summary", "profile", "objective",
  "experience", "work experience", "professional experience", "employment", "employment history",
  "projects", "project experience", "personal projects",
  "skills", "technical skills", "core skills", "competencies", "technologies", "tech stack",
  "education", "academic background",
  "activities", "volunteer", "certifications", "awards", "achievements",
]);

function parsePlainTextResume(text: string): Array<{ type: "header" | "section" | "entry" | "bullet" | "blank"; text: string }> {
  const lines = text.split(/\r?\n/);
  const result: Array<{ type: "header" | "section" | "entry" | "bullet" | "blank"; text: string }> = [];
  let lineIndex = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      result.push({ type: "blank", text: "" });
      lineIndex += 1;
      continue;
    }

    const lower = line.toLowerCase().replace(/[:\-|]+$/, "").trim();
    if (PLAIN_SECTION_HEADERS.has(lower) && line.length < 60) {
      result.push({ type: "section", text: line });
    } else if (/^[-•·*▪]/.test(line)) {
      result.push({ type: "bullet", text: line.replace(/^[-•·*▪]\s*/, "") });
    } else if (lineIndex < 5) {
      result.push({ type: "header", text: line });
    } else {
      result.push({ type: "entry", text: line });
    }

    lineIndex += 1;
  }

  return result;
}

function PlainTextResumeView({ text, userName }: { text: string; userName: string }) {
  const parsed = parsePlainTextResume(text);
  const hasAnyContent = text.trim().length > 0;

  if (!hasAnyContent) {
    return <GeneratingView />;
  }

  return (
    <ViewerShell>
      <article className="text-[11px] leading-[1.5] text-slate-800">
        <header className="mb-4 border-b border-slate-200 pb-3">
          <h2 className="text-[20px] font-semibold text-slate-900">{userName || "Resume"}</h2>
          <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Original — Optimization in progress
          </p>
        </header>

        <div className="space-y-0.5">
          {parsed.map((item, idx) => {
            if (item.type === "blank") {
              return <div key={idx} className="h-2" />;
            }
            if (item.type === "section") {
              return (
                <h3 key={idx} className="mt-4 border-b border-slate-300 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">
                  {item.text}
                </h3>
              );
            }
            if (item.type === "header") {
              return (
                <p key={idx} className="text-[11px] text-slate-500">{item.text}</p>
              );
            }
            if (item.type === "bullet") {
              return (
                <p key={idx} className="ml-4 text-[11px] text-slate-700 before:mr-1.5 before:content-['•']">{item.text}</p>
              );
            }
            return (
              <p key={idx} className="text-[11px] text-slate-800">{item.text}</p>
            );
          })}
        </div>
      </article>
    </ViewerShell>
  );
}

function TailoringFailedView({ errorMessage }: { errorMessage: string }) {
  return (
    <ViewerShell>
      <section className="rounded-md border border-rose-200 bg-rose-50 px-4 py-6 text-center text-sm text-rose-700">
        <p className="font-medium">Tailoring failed</p>
        <p className="mt-1 text-xs text-rose-600">{errorMessage}</p>
      </section>
    </ViewerShell>
  );
}

function EntryList({
  entries,
  keywordHighlights,
  fallbackTitle
}: {
  entries: ResumeCanonicalEntry[];
  keywordHighlights: string[];
  fallbackTitle: string;
}) {
  return (
    <div className="space-y-3">
      {entries.map((entry, index) => {
        const title = resolveEntryTitle(entry, fallbackTitle);
        const bullets = normalizeList(entry.bullets);
        return (
          <article key={`${fallbackTitle}-${index}`}>
            <p className="text-[12px] font-semibold text-slate-900">{title}</p>
            {bullets.length > 0 ? (
              <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
                {bullets.map((bullet, bulletIndex) => (
                  <li key={`${fallbackTitle}-${index}-${bulletIndex}`} className="mb-0.5">
                    <KeywordHighlightedText text={bullet} keywords={keywordHighlights} />
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function StructuredResumePreview(props: StructuredResumePreviewProps) {
  const {
    canonical,
    tailoringError,
    plainTextFallback,
    missingSkills,
    matchedSkills,
    jdKeywords,
    userName,
    email,
    phone,
    links
  } = props;

  if (!isValidCanonical(canonical)) {
    if (tailoringError) {
      return <TailoringFailedView errorMessage={tailoringError} />;
    }

    // Show original resume text while optimization is in progress
    if (plainTextFallback && plainTextFallback.trim().length > 0) {
      return <PlainTextResumeView text={plainTextFallback} userName={userName} />;
    }

    return <GeneratingView />;
  }

  const contactLine = buildContactLine([email, phone, links]);
  const canonicalSkills = normalizeList(canonical.skills);
  const jdKeywordList = normalizeList(jdKeywords);
  const missingSkillsSet = new Set(normalizeList(missingSkills).map(normalizeKey));
  const injectedSet = new Set(normalizeList(canonical.keywordsInjected).map(normalizeKey));
  const jdSet = new Set(jdKeywordList.map(normalizeKey));

  const matchedFromCanonical = canonicalSkills.filter((skill) => jdSet.has(normalizeKey(skill)));
  const effectiveMatchedSkills = normalizeList([
    ...matchedSkills,
    ...matchedFromCanonical
  ]);

  return (
    <ViewerShell>
      <article className="text-[11px] leading-[1.4] text-slate-800">
        <header className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[22px] font-semibold text-slate-900">{userName || "Resume"}</h2>
              {contactLine ? <p className="mt-0.5 text-[11px] text-slate-500">{contactLine}</p> : null}
            </div>
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              Optimized for this job
            </span>
          </div>

          {effectiveMatchedSkills.length > 0 ? (
            <p className="mt-2 text-[11px] text-slate-700">
              <span className="font-semibold text-slate-900">Matched Skills:</span> {effectiveMatchedSkills.join(", ")}
            </p>
          ) : null}
        </header>

        {canonical.summary?.trim() ? (
          <Section title="Summary">
            <p className="text-[11px] text-slate-700">
              <KeywordHighlightedText text={canonical.summary.trim()} keywords={jdKeywordList} />
            </p>
          </Section>
        ) : null}

        {canonicalSkills.length > 0 ? (
          <Section title="Skills">
            <div className="flex flex-wrap gap-1.5">
              {canonicalSkills.map((skill) => {
                const key = normalizeKey(skill);
                const isInjected = injectedSet.has(key);
                const isMatched = jdSet.has(key);
                const isMissing = missingSkillsSet.has(key);

                const className = isInjected
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : isMatched
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : isMissing
                      ? "border-rose-300 bg-rose-50 text-rose-700"
                      : "border-slate-300 bg-slate-50 text-slate-700";

                return (
                  <span key={skill} className={`rounded-full border px-2 py-0.5 text-[10px] ${className}`}>
                    {skill}
                    {isInjected ? " (Injected)" : ""}
                  </span>
                );
              })}
            </div>
          </Section>
        ) : null}

        {(canonical.experience?.length ?? 0) > 0 ? (
          <Section title="Experience">
            <EntryList
              entries={canonical.experience ?? []}
              keywordHighlights={jdKeywordList}
              fallbackTitle="Experience"
            />
          </Section>
        ) : null}

        {(canonical.projects?.length ?? 0) > 0 ? (
          <Section title="Projects">
            <EntryList
              entries={canonical.projects ?? []}
              keywordHighlights={jdKeywordList}
              fallbackTitle="Project"
            />
          </Section>
        ) : null}

        {(canonical.activities?.length ?? 0) > 0 ? (
          <Section title="Activities">
            <EntryList
              entries={canonical.activities ?? []}
              keywordHighlights={jdKeywordList}
              fallbackTitle="Activity"
            />
          </Section>
        ) : null}

        {(canonical.education?.length ?? 0) > 0 ? (
          <Section title="Education">
            <div className="space-y-3">
              {(canonical.education ?? []).map((entry, index) => {
                const title = entry.title?.trim() || entry.school?.trim() || entry.institution?.trim() || "Education";
                const details = normalizeList(entry.details);
                return (
                  <article key={`education-${index}`}>
                    <p className="text-[12px] font-semibold text-slate-900">{title}</p>
                    {details.length > 0 ? (
                      <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
                        {details.map((detail, detailIndex) => (
                          <li key={`education-${index}-${detailIndex}`}>
                            <KeywordHighlightedText text={detail} keywords={jdKeywordList} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </Section>
        ) : null}
      </article>
    </ViewerShell>
  );
}
