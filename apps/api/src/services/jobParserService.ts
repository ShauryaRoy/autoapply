import type { ATSProvider } from "@autoapply/shared";

export class JobParserService {
  detectAtsProvider(url: string): ATSProvider {
    const lower = url.toLowerCase();
    if (lower.includes("workday")) return "workday";
    if (lower.includes("greenhouse")) return "greenhouse";
    if (lower.includes("lever")) return "lever";
    if (lower.includes("smartrecruiters")) return "smartrecruiters";
    return "unknown";
  }
}
