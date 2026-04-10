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

export function logout(): void {
  clearStoredToken();
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
// User Profile (stored locally for now)
// ──────────────────────────────────────────────

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
};

const PROFILE_KEY = "autoapply_profile";

export function getStoredProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserProfile): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
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
