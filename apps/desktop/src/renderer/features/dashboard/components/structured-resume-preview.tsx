import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  parseResumeWithAI,
  parsedResumeCache,
  type ParsedResume
} from "../../../utils/resumeParser.js";

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
  education?: ResumeCanonicalEducationEntry[];
  keywordsInjected?: string[];
};

type StructuredResumePreviewProps = {
  jobId: string;
  canonical?: StructuredResumeCanonical;
  originalResume: string;
  missingSkills: string[];
  userName: string;
  email: string;
  phone: string;
  links: string;
};

type ResumeEntry = {
  title: string;
  subtitle?: string;
  bullets: string[];
};

type ResumeModel = {
  name: string;
  contact: string;
  education: ResumeEntry[];
  skills: string[];
  experience: ResumeEntry[];
};

export type DiffToken = {
  text: string;
  type: "added" | "unchanged";
};

export type DiffMap = {
  [path: string]: DiffToken[];
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

function tokenizeWords(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function buildWordDiff(originalValue: string, optimizedValue: string): DiffToken[] {
  const originalWords = tokenizeWords(originalValue);
  const optimizedWords = tokenizeWords(optimizedValue);

  if (optimizedWords.length === 0) return [];

  const n = originalWords.length;
  const m = optimizedWords.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (originalWords[i] === optimizedWords[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;

  while (j < m) {
    if (i < n && originalWords[i] === optimizedWords[j]) {
      tokens.push({ text: optimizedWords[j], type: "unchanged" });
      i += 1;
      j += 1;
      continue;
    }

    if (i < n && dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
      continue;
    }

    tokens.push({ text: optimizedWords[j], type: "added" });
    j += 1;
  }

  return tokens;
}

function setDiffPath(diffMap: DiffMap, path: string, originalValue: string, optimizedValue: string): void {
  diffMap[path] = buildWordDiff(originalValue, optimizedValue);
}

function buildDiffMap(originalResume: ResumeModel, optimizedResume: ResumeModel): DiffMap {
  const diffMap: DiffMap = {};

  setDiffPath(diffMap, "name", originalResume.name, optimizedResume.name);
  setDiffPath(diffMap, "contact", originalResume.contact, optimizedResume.contact);
  setDiffPath(diffMap, "skills", originalResume.skills.join(", "), optimizedResume.skills.join(", "));

  const educationLength = Math.max(originalResume.education.length, optimizedResume.education.length);
  for (let educationIndex = 0; educationIndex < educationLength; educationIndex += 1) {
    const originalEntry = originalResume.education[educationIndex];
    const optimizedEntry = optimizedResume.education[educationIndex];
    if (!optimizedEntry) continue;

    setDiffPath(diffMap, `education.${educationIndex}.title`, originalEntry?.title ?? "", optimizedEntry.title);
    setDiffPath(diffMap, `education.${educationIndex}.subtitle`, originalEntry?.subtitle ?? "", optimizedEntry.subtitle ?? "");

    const bulletCount = Math.max(originalEntry?.bullets.length ?? 0, optimizedEntry.bullets.length);
    for (let bulletIndex = 0; bulletIndex < bulletCount; bulletIndex += 1) {
      setDiffPath(
        diffMap,
        `education.${educationIndex}.bullets.${bulletIndex}`,
        originalEntry?.bullets[bulletIndex] ?? "",
        optimizedEntry.bullets[bulletIndex] ?? ""
      );
    }
  }

  const experienceLength = Math.max(originalResume.experience.length, optimizedResume.experience.length);
  for (let experienceIndex = 0; experienceIndex < experienceLength; experienceIndex += 1) {
    const originalEntry = originalResume.experience[experienceIndex];
    const optimizedEntry = optimizedResume.experience[experienceIndex];
    if (!optimizedEntry) continue;

    setDiffPath(diffMap, `experience.${experienceIndex}.title`, originalEntry?.title ?? "", optimizedEntry.title);
    setDiffPath(diffMap, `experience.${experienceIndex}.subtitle`, originalEntry?.subtitle ?? "", optimizedEntry.subtitle ?? "");

    const bulletCount = Math.max(originalEntry?.bullets.length ?? 0, optimizedEntry.bullets.length);
    for (let bulletIndex = 0; bulletIndex < bulletCount; bulletIndex += 1) {
      setDiffPath(
        diffMap,
        `experience.${experienceIndex}.bullets.${bulletIndex}`,
        originalEntry?.bullets[bulletIndex] ?? "",
        optimizedEntry.bullets[bulletIndex] ?? ""
      );
    }
  }

  return diffMap;
}

function canonicalEntryToEntry(entry: ResumeCanonicalEntry, fallbackTitle: string): ResumeEntry {
  const title =
    entry.title?.trim() ||
    [entry.role?.trim(), entry.company?.trim() || entry.organization?.trim()].filter(Boolean).join(" | ") ||
    fallbackTitle;

  return {
    title,
    bullets: normalizeList(entry.bullets)
  };
}

function canonicalEducationToEntry(entry: ResumeCanonicalEducationEntry): ResumeEntry {
  return {
    title: entry.title?.trim() || entry.school?.trim() || entry.institution?.trim() || "Education",
    bullets: normalizeList(entry.details)
  };
}

function hasCanonicalContent(canonical: StructuredResumeCanonical | undefined): boolean {
  if (!canonical) return false;

  return Boolean(
    canonical.skills?.length ||
      canonical.education?.length ||
      canonical.experience?.length ||
      canonical.projects?.length ||
      canonical.summary?.trim()
  );
}

function isValidParsedResume(data: ParsedResume | null): data is ParsedResume {
  return Boolean(
    data &&
    Array.isArray(data.experience) &&
    Array.isArray(data.projects) &&
    (data.experience.length > 0 || data.projects.length > 0)
  );
}

function buildContactLine(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" | ");
}

function toResumeFromCanonical(canonical: StructuredResumeCanonical, fallbackName: string, fallbackContact: string): ResumeModel {
  const experience = [
    ...(canonical.experience ?? []).map((entry) => canonicalEntryToEntry(entry, "Unknown Role")),
    ...(canonical.projects ?? []).map((entry) => ({
      ...canonicalEntryToEntry(entry, "Project"),
      subtitle: "Project"
    }))
  ];

  return {
    name: fallbackName || "Resume",
    contact: fallbackContact,
    education: (canonical.education ?? []).map(canonicalEducationToEntry),
    skills: normalizeList(canonical.skills),
    experience
  };
}

function toResumeFromParsed(parsedResume: ParsedResume, fallbackName: string, fallbackContact: string): ResumeModel {
  const contactParts = [
    parsedResume.header.email,
    parsedResume.header.phone,
    ...(parsedResume.header.links ?? [])
  ].filter((value): value is string => Boolean(value && value.trim()));

  const parsedContact = contactParts.length > 0 ? contactParts.join(" | ") : fallbackContact;

  const education = parsedResume.education.map((entry) => {
    const title = [entry.degree, entry.institution, entry.duration].filter(Boolean).join(" | ") || "Education";
    return {
      title,
      bullets: normalizeList(entry.details)
    };
  });

  const normalizedSkills = normalizeList(parsedResume.skills.flatMap((entry) => entry.items));

  const experience: ResumeEntry[] = [
    ...parsedResume.experience.map((entry) => ({
      title: entry.role,
      subtitle: [entry.company, entry.duration].filter(Boolean).join(" | ") || undefined,
      bullets: normalizeList(entry.bullets)
    })),
    ...parsedResume.projects.map((entry) => ({
      title: entry.title,
      subtitle: "Project",
      bullets: normalizeList(entry.bullets)
    }))
  ];

  return {
    name: parsedResume.header.name || fallbackName || "Resume",
    contact: parsedContact,
    education,
    skills: normalizedSkills,
    experience
  };
}

export function InlineText({ tokens }: { tokens: DiffToken[] }) {
  if (tokens.length === 0) return null;

  return (
    <>
      {tokens.map((token, index) => (
        <Fragment key={`${token.text}-${index}`}>
          <span className={token.type === "added" ? "bg-green-100 text-green-800" : ""}>{token.text}</span>
          {index < tokens.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="border-b border-slate-300 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

export function EntryBlock(props: {
  entry: ResumeEntry;
  pathPrefix: string;
  diffMap: DiffMap;
}) {
  const { entry, pathPrefix, diffMap } = props;

  return (
    <article className="mb-2.5">
      <p className="text-[12px] font-semibold text-slate-900">
        <InlineText tokens={diffMap[`${pathPrefix}.title`] ?? buildWordDiff("", entry.title)} />
      </p>
      {entry.subtitle ? (
        <p className="text-[11px] text-slate-500">
          <InlineText tokens={diffMap[`${pathPrefix}.subtitle`] ?? buildWordDiff("", entry.subtitle)} />
        </p>
      ) : null}
      {entry.bullets.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
          {entry.bullets.map((bullet, bulletIndex) => (
            <li key={`${pathPrefix}-bullet-${bulletIndex}`} className="mb-0.5">
              <InlineText tokens={diffMap[`${pathPrefix}.bullets.${bulletIndex}`] ?? buildWordDiff("", bullet)} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function ViewerShell({ children }: { children: ReactNode }) {
  return (
    <div className="w-full bg-slate-100 px-4 py-4">
      <div className="ml-auto w-full max-w-[880px]">
        <Toolbar />
        <div className="mt-3 flex justify-end overflow-auto">
          <div className="w-[840px] bg-white p-10 shadow-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ParsedExperienceEntry({
  title,
  company,
  duration,
  bullets,
  tech
}: {
  title: string;
  company?: string;
  duration?: string;
  bullets: string[];
  tech?: string[];
}) {
  return (
    <article className="mb-2.5">
      <p className="text-[12px] font-semibold text-slate-900">{title}</p>
      {(company || duration) ? (
        <p className="text-[11px] text-slate-500">{[company, duration].filter(Boolean).join(" | ")}</p>
      ) : null}
      {bullets.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
          {bullets.map((bullet, index) => (
            <li key={`${title}-bullet-${index}`} className="mb-0.5">{bullet}</li>
          ))}
        </ul>
      ) : null}
      {tech && tech.length > 0 ? (
        <p className="mt-1 text-[11px] text-slate-600">
          <span className="font-semibold text-slate-700">Tech:</span> {tech.join(", ")}
        </p>
      ) : null}
    </article>
  );
}

function CanonicalResumeDocument({ optimizedResume, diffMap }: { optimizedResume: ResumeModel; diffMap: DiffMap }) {
  const hasStructuredSections =
    optimizedResume.education.length > 0 ||
    optimizedResume.skills.length > 0 ||
    optimizedResume.experience.length > 0;

  return (
    <article className="text-[11px] leading-[1.4] text-slate-800">
      <header className="mb-4 text-center">
        <h2 className="text-[22px] font-semibold text-slate-900">
          <InlineText tokens={diffMap.name ?? buildWordDiff("", optimizedResume.name)} />
        </h2>
        {optimizedResume.contact ? (
          <p className="mt-0.5 text-[11px] text-slate-500">
            <InlineText tokens={diffMap.contact ?? buildWordDiff("", optimizedResume.contact)} />
          </p>
        ) : null}
      </header>

      {optimizedResume.education.length > 0 ? (
        <Section title="Education">
          {optimizedResume.education.map((entry, index) => (
            <EntryBlock key={`education-${index}`} entry={entry} pathPrefix={`education.${index}`} diffMap={diffMap} />
          ))}
        </Section>
      ) : null}

      {optimizedResume.skills.length > 0 ? (
        <Section title="Skills">
          <p className="text-[11px] text-slate-700">
            <InlineText tokens={diffMap.skills ?? buildWordDiff("", optimizedResume.skills.join(", "))} />
          </p>
        </Section>
      ) : null}

      {optimizedResume.experience.length > 0 ? (
        <Section title="Experience">
          {optimizedResume.experience.map((entry, index) => (
            <EntryBlock key={`experience-${index}`} entry={entry} pathPrefix={`experience.${index}`} diffMap={diffMap} />
          ))}
        </Section>
      ) : null}

      {!hasStructuredSections ? (
        <Section title="Resume">
          <p className="text-[11px] text-slate-600">No structured sections are available yet.</p>
        </Section>
      ) : null}
    </article>
  );
}

function ParsedResumeDocument({
  parsedResume
}: {
  parsedResume: ParsedResume;
}) {
  const displayName = parsedResume.header.name || "Resume";
  const displayContact = [
    parsedResume.header.email,
    parsedResume.header.phone,
    ...(parsedResume.header.links ?? [])
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" | ");

  return (
    <article className="text-[11px] leading-[1.4] text-slate-800">
      <header className="mb-4 text-center">
        <h2 className="text-[22px] font-semibold text-slate-900">{displayName}</h2>
        {displayContact ? <p className="mt-0.5 text-[11px] text-slate-500">{displayContact}</p> : null}
      </header>

      {parsedResume.education.length > 0 ? (
        <Section title="Education">
          <div className="space-y-2">
            {parsedResume.education.map((entry, index) => (
              <article key={`education-entry-${index}`}>
                <p className="text-[12px] font-semibold text-slate-900">
                  {[entry.degree, entry.institution].filter(Boolean).join(" | ") || "Education"}
                </p>
                {entry.duration ? <p className="text-[11px] text-slate-500">{entry.duration}</p> : null}
                {entry.details?.length ? (
                  <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
                    {entry.details.map((detail, detailIndex) => (
                      <li key={`education-detail-${index}-${detailIndex}`} className="mb-0.5">{detail}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </Section>
      ) : null}

      {parsedResume.skills.length > 0 ? (
        <Section title="Skills">
          <div className="space-y-1.5">
            {parsedResume.skills.map((entry, index) => (
              <p key={`skills-entry-${index}`} className="text-[11px] text-slate-700">
                {entry.category ? <span className="font-semibold text-slate-800">{entry.category}: </span> : null}
                {entry.items.join(", ")}
              </p>
            ))}
          </div>
        </Section>
      ) : null}

      {parsedResume.experience.length > 0 ? (
        <Section title="Experience">
          {parsedResume.experience.map((entry, index) => (
            <ParsedExperienceEntry
              key={`parsed-experience-${index}`}
              title={entry.role}
              company={entry.company}
              duration={entry.duration}
              bullets={entry.bullets}
              tech={entry.tech}
            />
          ))}
        </Section>
      ) : null}

      {parsedResume.projects.length > 0 ? (
        <Section title="Projects">
          {parsedResume.projects.map((entry, index) => (
            <ParsedExperienceEntry
              key={`parsed-project-${index}`}
              title={entry.title}
              bullets={entry.bullets}
              tech={entry.tech}
            />
          ))}
        </Section>
      ) : null}

      {parsedResume.activities.length > 0 ? (
        <Section title="Activities">
          <div className="space-y-2">
            {parsedResume.activities.map((entry, index) => (
              <article key={`activity-entry-${index}`}>
                <p className="text-[12px] font-semibold text-slate-900">{entry.title || "Activity"}</p>
                {entry.bullets.length > 0 ? (
                  <ul className="mt-1 list-disc pl-4 text-[11px] leading-[1.4] text-slate-700">
                    {entry.bullets.map((bullet, bulletIndex) => (
                      <li key={`activity-bullet-${index}-${bulletIndex}`} className="mb-0.5">{bullet}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </Section>
      ) : null}
    </article>
  );
}

export function Toolbar() {
  return (
    <div className="flex items-center justify-end gap-2">
      <button type="button" className="h-7 w-7 border border-slate-300 bg-white text-[11px] text-slate-700" aria-label="Zoom in">
        A+
      </button>
      <button type="button" className="h-7 w-7 border border-slate-300 bg-white text-[11px] text-slate-700" aria-label="Zoom out">
        A-
      </button>
      <span className="px-1 text-[11px] text-slate-600">1 pg</span>
      <button type="button" className="h-7 w-7 border border-slate-300 bg-white text-[11px] text-slate-700" aria-label="Edit">
        ✎
      </button>
    </div>
  );
}

function CanonicalResumeView({ optimizedResume, diffMap }: { optimizedResume: ResumeModel; diffMap: DiffMap }) {
  return (
    <ViewerShell>
      <CanonicalResumeDocument optimizedResume={optimizedResume} diffMap={diffMap} />
    </ViewerShell>
  );
}

function ParsedResumeView({ data }: { data: ParsedResume }) {
  return (
    <ViewerShell>
      <ParsedResumeDocument parsedResume={data} />
    </ViewerShell>
  );
}

function ParseStatusViewer({
  status
}: {
  status: "parsing" | "retrying" | "failed";
}) {
  const message =
    status === "parsing"
      ? "Parsing resume..."
      : status === "retrying"
        ? "Failed to parse resume. Retrying parsing..."
        : "Failed to parse resume";

  const textClass = status === "parsing" ? "text-slate-600" : "text-red-500";

  return (
    <ViewerShell>
      <section className={`rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm ${textClass}`}>
        {message}
      </section>
    </ViewerShell>
  );
}

export function StructuredResumePreview(props: StructuredResumePreviewProps) {
  const { jobId, canonical, originalResume, userName, email, phone, links } = props;
  void props.missingSkills;

  const contactLine = buildContactLine([email, phone, links]);
  const canonicalAvailable = hasCanonicalContent(canonical);
  const resumeText = originalResume.trim();
  const cacheKey = jobId.trim() || "default";

  const [parsedResume, setParsedResume] = useState<ParsedResume | null>(null);
  const [parseStatus, setParseStatus] = useState<"parsing" | "retrying" | "failed">("parsing");

  useEffect(() => {
    setParsedResume(null);
    setParseStatus("parsing");
  }, [cacheKey, resumeText]);

  useEffect(() => {
    if (canonicalAvailable) {
      return;
    }

    if (!resumeText) {
      setParsedResume(null);
      setParseStatus("parsing");
      return;
    }

    if (parsedResume && isValidParsedResume(parsedResume)) {
      return;
    }

    const cached = parsedResumeCache[cacheKey];
    if (cached && isValidParsedResume(cached)) {
      setParsedResume(cached);
      return;
    }

    if (cached && !isValidParsedResume(cached)) {
      delete parsedResumeCache[cacheKey];
    }

    let cancelled = false;

    const parseResume = async () => {
      setParseStatus("parsing");
      let parsed = await parseResumeWithAI(originalResume, cacheKey);
      if (cancelled) return;

      console.log("AI PARSED RESULT:", parsed);

      if (!isValidParsedResume(parsed)) {
        console.warn("Invalid parsed resume, retrying...");
        delete parsedResumeCache[cacheKey];
        setParseStatus("retrying");

        parsed = await parseResumeWithAI(originalResume);
        if (cancelled) return;

        console.log("AI PARSED RESULT:", parsed);
      }

      if (!isValidParsedResume(parsed)) {
        delete parsedResumeCache[cacheKey];
        setParsedResume(null);
        setParseStatus("failed");
        return;
      }

      parsedResumeCache[cacheKey] = parsed;
      setParsedResume(parsed);
      setParseStatus("parsing");
    };

    void parseResume().catch((error) => {
      if (cancelled) return;

      console.error("AI PARSE FAILED:", error);
      setParsedResume(null);
      setParseStatus("failed");
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalAvailable, cacheKey, originalResume, parsedResume, resumeText]);

  useEffect(() => {
    const validParsed = isValidParsedResume(parsedResume);
    console.log({
      hasCanonical: !!canonicalAvailable,
      hasParsed: !!parsedResume,
      validParsed
    });
  }, [canonicalAvailable, parsedResume]);

  const originalStructuredResume = useMemo(() => {
    if (isValidParsedResume(parsedResume)) {
      return toResumeFromParsed(parsedResume, userName || "Resume", contactLine);
    }

    return {
      name: userName || "Resume",
      contact: contactLine,
      education: [],
      skills: [],
      experience: []
    } satisfies ResumeModel;
  }, [parsedResume, userName, contactLine]);

  const optimizedResume = useMemo(() => {
    if (!canonicalAvailable) {
      return originalStructuredResume;
    }

    return toResumeFromCanonical(
      canonical as StructuredResumeCanonical,
      userName || originalStructuredResume.name,
      contactLine || originalStructuredResume.contact
    );
  }, [canonical, canonicalAvailable, contactLine, originalStructuredResume, userName]);

  const diffMap = useMemo(() => buildDiffMap(originalStructuredResume, optimizedResume), [optimizedResume, originalStructuredResume]);

  if (canonicalAvailable) {
    return <CanonicalResumeView optimizedResume={optimizedResume} diffMap={diffMap} />;
  }

  if (parsedResume && isValidParsedResume(parsedResume)) {
    return <ParsedResumeView data={parsedResume} />;
  }

  if (parseStatus === "retrying") {
    return <ParseStatusViewer status="retrying" />;
  }

  if (parseStatus === "failed") {
    return <ParseStatusViewer status="failed" />;
  }

  return <ParseStatusViewer status="parsing" />;
}
