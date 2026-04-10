import type { Page } from "playwright";

export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedIn?: string;
  github?: string;
  portfolio?: string;
}

export interface FormAnswerSet {
  [key: string]: string;
}

export interface ATSAdapter {
  name: string;
  canHandle(url: string): boolean;
  login(page: Page): Promise<"ok" | "needs-user-action">;
  fillApplicationForm(page: Page, profile: ApplicantProfile, answers: FormAnswerSet): Promise<void>;
  submit(page: Page): Promise<void>;
}
