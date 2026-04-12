/**
 * platformDetector.ts
 *
 * Detects the ATS platform from a job URL based on patterns observed
 * in Career-Ops and common ATS URL structures.
 */

export type Platform = "greenhouse" | "lever" | "ashby" | "workday" | "generic";

const PLATFORM_PATTERNS: Record<Platform, RegExp[]> = {
  greenhouse: [
    /boards\.greenhouse\.io/,
    /greenhouse\.io\/.*\/jobs/
  ],
  lever: [
    /jobs\.lever\.co/,
    /lever\.co/
  ],
  ashby: [
    /jobs\.ashbyhq\.com/,
    /ashbyhq\.com/
  ],
  workday: [
    /myworkdayjobs\.com/
  ],
  generic: [] // Fallback
};

export function detectPlatform(url: string): Platform {
  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    if (platform === "generic") continue;
    if (patterns.some(pattern => pattern.test(url))) {
      return platform as Platform;
    }
  }
  return "generic";
}
