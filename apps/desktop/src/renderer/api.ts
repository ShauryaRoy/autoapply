import axios from "axios";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

const apiBaseUrl = window.desktopApi?.apiBaseUrl ?? "http://localhost:4000";

const api = axios.create({
  baseURL: apiBaseUrl
});

// ──────────────────────────────────────────────
// Token management (persisted in localStorage)
// ──────────────────────────────────────────────

export function getStoredToken(): string | null {
  return localStorage.getItem("autoapply_token");
}

export function setStoredToken(token: string): void {
  localStorage.setItem("autoapply_token", token);
}

export function clearStoredToken(): void {
  localStorage.removeItem("autoapply_token");
}

api.interceptors.request.use((config) => {
  const t = getStoredToken();
  if (t) {
    config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});

// ──────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────

export async function register(payload: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<{ token: string; userId: string }> {
  const res = await api.post("/api/auth/register", payload);
  const { token, userId } = res.data as { token: string; userId: string };
  setStoredToken(token);
  return { token, userId };
}

export async function login(payload: {
  email: string;
  password: string;
}): Promise<{ token: string; userId: string }> {
  const res = await api.post("/api/auth/login", payload);
  const { token, userId } = res.data as { token: string; userId: string };
  setStoredToken(token);
  return { token, userId };
}

export function clearStoredProfile(userId: string): void {
  requireUserId(userId, "clearStoredProfile");
  localStorage.removeItem(getProfileCacheKey(userId));
  localStorage.removeItem(getOnboardingCacheKey(userId));
}

export function clearAllProfileCaches(): void {
  // Nuclear option — wipes every known scoped key for all users
  Object.keys(localStorage)
    .filter(k => k.startsWith(PROFILE_KEY) || k.startsWith(ONBOARDING_PROFILE_KEY))
    .forEach(k => localStorage.removeItem(k));
}

// All localStorage keys that are NOT scoped to a userId.
// These must be wiped on every logout AND every login so that
// account 1's data never bleeds into account 2's session.
const UNSCOPED_SESSION_KEYS = [
  "autoapply_resume_pdf_data_url",
  "autoapply_resume_pdf_name",
  "autoapply_resume_optimization_snapshot",
  "autoapply_dashboard_job_history",
  "autoapply_onboarding_success_message",
] as const;

export function clearUnscopedSessionData(): void {
  UNSCOPED_SESSION_KEYS.forEach(k => localStorage.removeItem(k));
}

export function logout(): void {
  clearStoredToken();
  clearAllProfileCaches();
  clearUnscopedSessionData();
}

export async function getMe(): Promise<{
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profile?: UserProfile;
}> {
  const res = await api.get("/api/auth/me");
  return res.data;
}

// ──────────────────────────────────────────────
// User Profile (backend authoritative, local cache)
// ──────────────────────────────────────────────

export type EducationEntry = {
  school: string;
  major: string;
  degree: string;
  gpa: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
};

export type ExperienceEntry = {
  title: string;
  company: string;
  location: string;
  type: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  current: boolean;
  description: string;
};

export type RolePreferences = {
  desiredRoles: string[];
  preferredLocations: string[];
  employmentTypes: string[];
};

export type WorkAuthorization = {
  usAuthorized: "yes" | "no" | "";
  canadaAuthorized: "yes" | "no" | "";
  ukAuthorized: "yes" | "no" | "";
  needsVisaSponsorship: "yes" | "no" | "";
};

export type EeoProfile = {
  ethnicities: string[];
  declineEthnicity: boolean;
  disability: "yes" | "no" | "decline" | "";
  veteran: "yes" | "no" | "decline" | "";
  lgbtq: "yes" | "no" | "decline" | "";
  gender: "male" | "female" | "non-binary" | "decline" | "";
};

export type SkillEntry = {
  name: string;
  preferred?: boolean;
};

export type PersonalProfile = {
  dateOfBirth?: string;
};

export type LinkProfile = {
  linkedin: string;
  github: string;
  portfolio: string;
  other: string;
};

export type SalaryPreferences = {
  expected?: string;
  currency?: string;
  openToNegotiation?: "yes" | "no" | "";
};

export type Availability = {
  noticePeriod?: string;
  earliestStartDate?: string;
  currentlyEmployed?: "yes" | "no" | "";
};

export type WorkPreferences = {
  mode?: string;
  willingToRelocate?: "yes" | "no" | "";
  travelPercent?: string;
  inPersonPercent?: string;
};

export type UserProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  resumeText: string;
  linkedIn?: string;
  portfolio?: string;
  yearsExperience?: string;
  whyCompany?: string;
  roles?: RolePreferences;
  education?: EducationEntry[];
  experience?: ExperienceEntry[];
  workAuth?: WorkAuthorization;
  eeo?: EeoProfile;
  skills?: SkillEntry[];
  personal?: PersonalProfile;
  links?: LinkProfile;
  salary?: SalaryPreferences;
  availability?: Availability;
  workPreferences?: WorkPreferences;
  answers?: Record<string, string>;
};

const PROFILE_KEY = "autoapply_profile";
const ONBOARDING_PROFILE_KEY = "autoapply_onboarding_profile";

// ── Purge any legacy un-scoped keys left from previous builds ──────────
;(function purgeLegacyKeys() {
  [PROFILE_KEY, ONBOARDING_PROFILE_KEY].forEach(k => localStorage.removeItem(k));
})();

function requireUserId(userId: string | undefined, caller: string): asserts userId is string {
  if (!userId || userId.trim() === "") {
    throw new Error(`[auth-cache] ${caller} called without a userId — refusing to read/write shared cache key`);
  }
}

function getProfileCacheKey(userId: string): string {
  return `${PROFILE_KEY}_${userId}`;
}

export function getStoredProfile(userId: string): UserProfile | null {
  requireUserId(userId, "getStoredProfile");
  try {
    const raw = localStorage.getItem(getProfileCacheKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserProfile, userId: string): void {
  requireUserId(userId, "saveProfile");
  localStorage.setItem(getProfileCacheKey(userId), JSON.stringify(profile));
}

export async function getProfile(): Promise<UserProfile> {
  const res = await api.get("/api/profile");
  return res.data as UserProfile;
}

export async function putProfile(profile: UserProfile): Promise<UserProfile> {
  const res = await api.put("/api/profile", profile);
  return res.data as UserProfile;
}

export async function uploadProfileResume(payload: { resumeText?: string; file?: File }): Promise<{ resumeText: string }> {
  if (payload.file) {
    const form = new FormData();
    form.append("file", payload.file);
    const res = await api.post("/api/profile/resume", form, {
      headers: {
        "Content-Type": "multipart/form-data"
      }
    });
    return res.data as { resumeText: string };
  }

  const res = await api.post("/api/profile/resume", { resumeText: payload.resumeText ?? "" });
  return res.data as { resumeText: string };
}

// ──────────────────────────────────────────────
// Applications
// ──────────────────────────────────────────────

export async function createApplication(payload: {
  jobUrl: string;
  targetRole: string;
  metadata?: Record<string, unknown>;
}) {
  const response = await api.post("/api/applications", payload);
  return response.data as { applicationId: string };
}

export async function getApplication(applicationId: string) {
  const response = await api.get(`/api/applications/${applicationId}`);
  return response.data;
}

export async function listApplications(limit = 30) {
  const response = await api.get("/api/applications", {
    params: { limit }
  });
  return response.data as Array<{
    id: string;
    jobUrl: string;
    targetRole: string;
    status: string;
    currentStep: string;
    updatedAt: string;
  }>;
}

export async function getLatestPreview(applicationId: string): Promise<string | null> {
  try {
    const res = await api.get(`/api/previews/${applicationId}/latest`);
    return (res.data as { url: string | null }).url;
  } catch {
    return null;
  }
}

export async function pauseApplication(applicationId: string) {
  await api.post(`/api/applications/${applicationId}/pause`);
}

export async function resumeApplication(applicationId: string) {
  await api.post(`/api/applications/${applicationId}/resume`);
}

// ──────────────────────────────────────────────
// Real-time socket
// ──────────────────────────────────────────────

export const socket: Socket = io(apiBaseUrl, {
  autoConnect: false
});

export function subscribeToApplication(
  applicationId: string,
  onUpdate: () => void
): () => void {
  if (!socket.connected) {
    socket.connect();
  }

  socket.emit("subscribe-application", applicationId);
  const listener = () => onUpdate();
  socket.on("application:update", listener);

  return () => {
    socket.off("application:update", listener);
  };
}

// ──────────────────────────────────────────────
// Onboarding Chat
// ──────────────────────────────────────────────

export type OnboardingMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OnboardingResponse = {
  message: string;
  field: string;
  section: string;
  action: "confirm" | "ask" | "update" | "skip" | "complete";
  progress: number;
  data: Record<string, unknown>;
};

export type OnboardingProfile = {
  education: Array<{
    institution: string | null;
    field_of_study: string | null;
    degree: string | null;
    gpa: number | null;
    startMonth: number | null;
    startYear: number | null;
    endMonth: number | null;
    endYear: number | null;
  }>;
  experience: Array<{
    job_title: string | null;
    company: string | null;
    location: string | null;
    employment_type: string | null;
    startMonth: number | null;
    startYear: number | null;
    endMonth: number | null;
    endYear: number | null;
    current: boolean;
    description: string | null;
  }>;
  workAuth: Record<string, string>;
  eeo: Record<string, string>;
  skills: string[];
  personal: {
    phone: string;
    location: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  links: {
    linkedin: string;
    github: string;
    portfolio: string;
  };
};

function getOnboardingCacheKey(userId: string): string {
  return `${ONBOARDING_PROFILE_KEY}_${userId}`;
}

export function getStoredOnboardingProfile(userId: string): OnboardingProfile | null {
  requireUserId(userId, "getStoredOnboardingProfile");
  try {
    const raw = localStorage.getItem(getOnboardingCacheKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingProfile;
  } catch {
    return null;
  }
}

export function saveOnboardingProfile(profile: OnboardingProfile, userId: string): void {
  requireUserId(userId, "saveOnboardingProfile");
  localStorage.setItem(getOnboardingCacheKey(userId), JSON.stringify(profile));
}

export async function extractFullProfile(resumeText: string): Promise<OnboardingProfile> {
  const res = await api.post("/api/onboarding/extract-full", { resumeText });
  return res.data as OnboardingProfile;
}

export async function sendOnboardingMessage(
  messages: OnboardingMessage[],
  resumeText?: string
): Promise<OnboardingResponse> {
  const res = await api.post("/api/onboarding/chat", { messages, resumeText });
  return res.data as OnboardingResponse;
}
