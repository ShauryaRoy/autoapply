import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";

const RolePreferencesSchema = z.object({
  desiredRoles: z.array(z.string()).default([]),
  preferredLocations: z.array(z.string()).default([]),
  employmentTypes: z.array(z.string()).default([])
});

const EducationEntrySchema = z.object({
  school: z.string().default(""),
  major: z.string().default(""),
  degree: z.string().default(""),
  gpa: z.string().default(""),
  startMonth: z.string().default(""),
  startYear: z.string().default(""),
  endMonth: z.string().default(""),
  endYear: z.string().default("")
});

const ExperienceEntrySchema = z.object({
  title: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default(""),
  type: z.string().default(""),
  startMonth: z.string().default(""),
  startYear: z.string().default(""),
  endMonth: z.string().default(""),
  endYear: z.string().default(""),
  current: z.boolean().default(false),
  description: z.string().default("")
});

const WorkAuthorizationSchema = z.object({
  usAuthorized: z.union([z.literal("yes"), z.literal("no"), z.literal("")]).default(""),
  canadaAuthorized: z.union([z.literal("yes"), z.literal("no"), z.literal("")]).default(""),
  ukAuthorized: z.union([z.literal("yes"), z.literal("no"), z.literal("")]).default(""),
  needsVisaSponsorship: z.union([z.literal("yes"), z.literal("no"), z.literal("")]).default("")
});

const EeoProfileSchema = z.object({
  ethnicities: z.array(z.string()).default([]),
  declineEthnicity: z.boolean().default(false),
  disability: z.union([z.literal("yes"), z.literal("no"), z.literal("decline"), z.literal("")]).default(""),
  veteran: z.union([z.literal("yes"), z.literal("no"), z.literal("decline"), z.literal("")]).default(""),
  lgbtq: z.union([z.literal("yes"), z.literal("no"), z.literal("decline"), z.literal("")]).default(""),
  gender: z.union([z.literal("male"), z.literal("female"), z.literal("non-binary"), z.literal("decline"), z.literal("")]).default("")
});

const SkillEntrySchema = z.object({
  name: z.string().default(""),
  preferred: z.boolean().optional()
});

const PersonalProfileSchema = z.object({
  dateOfBirth: z.string().optional()
});

const LinkProfileSchema = z.object({
  linkedin: z.string().default(""),
  github: z.string().default(""),
  portfolio: z.string().default(""),
  other: z.string().default("")
});

const UserProfileSchema = z.object({
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  resumeText: z.string().default(""),
  linkedIn: z.string().optional(),
  portfolio: z.string().optional(),
  yearsExperience: z.string().optional(),
  whyCompany: z.string().optional(),
  roles: RolePreferencesSchema.optional(),
  education: z.array(EducationEntrySchema).optional(),
  experience: z.array(ExperienceEntrySchema).optional(),
  workAuth: WorkAuthorizationSchema.optional(),
  eeo: EeoProfileSchema.optional(),
  skills: z.array(SkillEntrySchema).optional(),
  personal: PersonalProfileSchema.optional(),
  links: LinkProfileSchema.optional(),
  answers: z.record(z.string()).optional(),
  projects: z.array(z.record(z.unknown())).optional()
});

export type UserProfilePayload = z.infer<typeof UserProfileSchema>;

const EMPTY_PROFILE: UserProfilePayload = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  resumeText: "",
  linkedIn: "",
  portfolio: "",
  yearsExperience: "",
  whyCompany: "",
  roles: {
    desiredRoles: [],
    preferredLocations: [],
    employmentTypes: []
  },
  education: [
    {
      school: "",
      major: "",
      degree: "",
      gpa: "",
      startMonth: "",
      startYear: "",
      endMonth: "",
      endYear: ""
    }
  ],
  experience: [
    {
      title: "",
      company: "",
      location: "",
      type: "",
      startMonth: "",
      startYear: "",
      endMonth: "",
      endYear: "",
      current: false,
      description: ""
    }
  ],
  workAuth: {
    usAuthorized: "",
    canadaAuthorized: "",
    ukAuthorized: "",
    needsVisaSponsorship: ""
  },
  eeo: {
    ethnicities: [],
    declineEthnicity: false,
    disability: "",
    veteran: "",
    lgbtq: "",
    gender: ""
  },
  skills: [],
  personal: {
    dateOfBirth: ""
  },
  links: {
    linkedin: "",
    github: "",
    portfolio: "",
    other: ""
  },
  answers: {},
  projects: []
};

type ProjectsEnvelope = {
  roles?: UserProfilePayload["roles"];
  workAuth?: UserProfilePayload["workAuth"];
  eeo?: UserProfilePayload["eeo"];
  personal?: UserProfilePayload["personal"];
  links?: UserProfilePayload["links"];
  answers?: UserProfilePayload["answers"];
  projects?: Array<Record<string, unknown>>;
  identity?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedIn?: string;
    portfolio?: string;
    yearsExperience?: string;
    whyCompany?: string;
  };
};

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        output[k] = removeUndefinedDeep(v);
      }
    }
    return output;
  }
  return value;
}

function parseProjectsEnvelope(value: unknown): ProjectsEnvelope {
  if (!value || typeof value !== "object") return {};
  return value as ProjectsEnvelope;
}

function fromRecordToProfile(record: {
  education: unknown;
  experience: unknown;
  skills: unknown;
  projects: unknown;
  resumeText: string;
}): UserProfilePayload {
  const envelope = parseProjectsEnvelope(record.projects);

  const merged: UserProfilePayload = {
    ...EMPTY_PROFILE,
    firstName: envelope.identity?.firstName ?? "",
    lastName: envelope.identity?.lastName ?? "",
    email: envelope.identity?.email ?? "",
    phone: envelope.identity?.phone ?? "",
    location: envelope.identity?.location ?? "",
    linkedIn: envelope.identity?.linkedIn ?? "",
    portfolio: envelope.identity?.portfolio ?? "",
    yearsExperience: envelope.identity?.yearsExperience ?? "",
    whyCompany: envelope.identity?.whyCompany ?? "",
    resumeText: record.resumeText ?? "",
    education: Array.isArray(record.education) ? (record.education as UserProfilePayload["education"]) : [],
    experience: Array.isArray(record.experience) ? (record.experience as UserProfilePayload["experience"]) : [],
    skills: Array.isArray(record.skills) ? (record.skills as UserProfilePayload["skills"]) : [],
    roles: envelope.roles ?? EMPTY_PROFILE.roles,
    workAuth: envelope.workAuth ?? EMPTY_PROFILE.workAuth,
    eeo: envelope.eeo ?? EMPTY_PROFILE.eeo,
    personal: envelope.personal ?? EMPTY_PROFILE.personal,
    links: envelope.links ?? EMPTY_PROFILE.links,
    answers: envelope.answers ?? EMPTY_PROFILE.answers,
    projects: envelope.projects ?? []
  };

  return UserProfileSchema.parse(removeUndefinedDeep(merged));
}

function toStoredColumns(profile: UserProfilePayload): {
  education: Prisma.InputJsonValue;
  experience: Prisma.InputJsonValue;
  skills: Prisma.InputJsonValue;
  projects: Prisma.InputJsonValue;
  resumeText: string;
} {
  const projectsEnvelope: ProjectsEnvelope = {
    roles: profile.roles ?? EMPTY_PROFILE.roles,
    workAuth: profile.workAuth ?? EMPTY_PROFILE.workAuth,
    eeo: profile.eeo ?? EMPTY_PROFILE.eeo,
    personal: profile.personal ?? EMPTY_PROFILE.personal,
    links: profile.links ?? EMPTY_PROFILE.links,
    answers: profile.answers ?? EMPTY_PROFILE.answers,
    projects: profile.projects ?? [],
    identity: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedIn: profile.linkedIn,
      portfolio: profile.portfolio,
      yearsExperience: profile.yearsExperience,
      whyCompany: profile.whyCompany
    }
  };

  return {
    education: removeUndefinedDeep(profile.education ?? EMPTY_PROFILE.education) as Prisma.InputJsonValue,
    experience: removeUndefinedDeep(profile.experience ?? EMPTY_PROFILE.experience) as Prisma.InputJsonValue,
    skills: removeUndefinedDeep(profile.skills ?? EMPTY_PROFILE.skills) as Prisma.InputJsonValue,
    projects: removeUndefinedDeep(projectsEnvelope) as Prisma.InputJsonValue,
    resumeText: profile.resumeText ?? ""
  };
}

export function getEmptyProfile(): UserProfilePayload {
  return JSON.parse(JSON.stringify(EMPTY_PROFILE)) as UserProfilePayload;
}

export function isProfileEmpty(profile: UserProfilePayload): boolean {
  const hasEducation = (profile.education ?? []).some((entry) =>
    [entry.school, entry.major, entry.degree].some((v) => !!v?.trim())
  );
  const hasExperience = (profile.experience ?? []).some((entry) =>
    [entry.title, entry.company, entry.description].some((v) => !!v?.trim())
  );
  const hasSkills = (profile.skills ?? []).some((entry) => !!entry.name?.trim());
  const hasResume = !!profile.resumeText?.trim();

  return !(hasEducation || hasExperience || hasSkills || hasResume);
}

export async function getProfileByUserId(userId: string): Promise<UserProfilePayload> {
  const record = await prisma.userProfile.findUnique({
    where: { userId },
    select: {
      education: true,
      experience: true,
      skills: true,
      projects: true,
      resumeText: true
    }
  });

  if (!record) return getEmptyProfile();
  return fromRecordToProfile(record);
}

export async function upsertProfileByUserId(userId: string, input: unknown): Promise<UserProfilePayload> {
  const clean = removeUndefinedDeep(input);
  const parsed = UserProfileSchema.parse(clean);
  const columns = toStoredColumns(parsed);

  const record = await prisma.userProfile.upsert({
    where: { userId },
    update: columns,
    create: {
      userId,
      ...columns
    },
    select: {
      education: true,
      experience: true,
      skills: true,
      projects: true,
      resumeText: true
    }
  });

  return fromRecordToProfile(record);
}

export async function updateResumeTextByUserId(userId: string, resumeText: string): Promise<UserProfilePayload> {
  const safeText = resumeText.trim();

  const record = await prisma.userProfile.upsert({
    where: { userId },
    update: { resumeText: safeText },
    create: {
      userId,
      education: EMPTY_PROFILE.education as Prisma.InputJsonValue,
      experience: EMPTY_PROFILE.experience as Prisma.InputJsonValue,
      skills: EMPTY_PROFILE.skills as Prisma.InputJsonValue,
      projects: {
        roles: EMPTY_PROFILE.roles,
        workAuth: EMPTY_PROFILE.workAuth,
        eeo: EMPTY_PROFILE.eeo,
        personal: EMPTY_PROFILE.personal,
        links: EMPTY_PROFILE.links,
        answers: EMPTY_PROFILE.answers,
        projects: EMPTY_PROFILE.projects,
        identity: {
          firstName: "",
          lastName: "",
          email: "",
          phone: "",
          location: "",
          linkedIn: "",
          portfolio: "",
          yearsExperience: "",
          whyCompany: ""
        }
      } as Prisma.InputJsonValue,
      resumeText: safeText
    },
    select: {
      education: true,
      experience: true,
      skills: true,
      projects: true,
      resumeText: true
    }
  });

  return fromRecordToProfile(record);
}
