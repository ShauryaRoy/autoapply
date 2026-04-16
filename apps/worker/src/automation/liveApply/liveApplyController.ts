import { BrowserSessionManager } from "../browser/browserSessionManager.js";
import { type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { detectFields } from "../form/formDetector.js";
import { mapFieldsToAnswers } from "../form/formMapper.js";
import { fillFormFields } from "../form/formFiller.js";
import { type FormField, type AnswerMap, type MappedField } from "../form/types.js";
import { pause as enginePause, resume as engineResume, validatePage } from "../engine/interactionEngine.js";
import { logger } from "../browser/logger.js";
import { GeminiService } from "../../lib/ai/geminiService.js";
import { shouldAutoApply, type ApplyConfig, type ApplyMode } from "./decisionEngine.js";
import { analyzeJob } from "../tailor/jobAnalyzer.js";
import { tailorResume, generatePDF } from "../tailor/resumeTailor.js";
import { enhanceAnswers } from "../tailor/answerEnhancer.js";
import { type JobProfile, type TailoredResume } from "../tailor/types.js";
import { scoreJob } from "../scoring/jobScorer.js";
import { type JobScore } from "../scoring/types.js";

export type ApplyState =
  | "idle"
  | "detecting"
  | "review"
  | "filling"
  | "paused"
  | "captcha"
  | "error";

export type ReviewPayload = {
  fields: FormField[];
  answers: Record<string, string>;
  requiredUnmapped: FormField[];
};

type ControllerContext = {
  targetRole?: string;
  profile?: Record<string, string>;
  resumeText?: string;
  externalAnswers?: Record<string, string>;
  jobDescription?: string;
};

type ControllerState = {
  status: ApplyState;
  fields: FormField[];
  answers: Record<string, string>;
  editedAnswers: Record<string, string>;
  tailoredResume: TailoredResume | null;
  enhancedAnswers: Record<string, string>;
  diffSummary: string[];
  jobScore: JobScore | null;
};

export type { ApplyConfig, ApplyMode };

export class LiveApplyController {
  private static readonly tailoringCache = new Map<string, {
    jobProfile: JobProfile;
    tailoredResume: TailoredResume;
    diffSummary: string[];
  }>();

  private readonly manager: BrowserSessionManager;
  private readonly gemini: GeminiService;
  private targetDomain = "";
  private mappedFields: MappedField[] = [];
  private context: ControllerContext = {};
  private reviewResolver: (() => void) | null = null;
  private lastStateBeforePause: ApplyState = "idle";
  private readonly reviewTimeoutMs = 10 * 60 * 1000;
  private currentFieldIndex = 0;
  private requiredUnmappedFields: FormField[] = [];
  private skipCurrentJob = false;

  public filledFields: Array<{ label: string; selector: string }> = [];
  public dryRun = false;
  public errorCount = 0;
  public firstRun = true;
  public config: ApplyConfig = {
    mode: "assist",
    autoSubmit: false,
    pauseOnLowConfidence: true,
    pauseOnLongAnswers: true
  };

  public page?: Page;

  public state: ControllerState = {
    status: "idle",
    fields: [],
    answers: {},
    editedAnswers: {},
    tailoredResume: null,
    enhancedAnswers: {},
    diffSummary: [],
    jobScore: null
  };

  // UI Contract Hooks
  public onReviewRequested?: (data: ReviewPayload) => void;
  public onCaptchaDetected?: () => void;
  public onReviewTimeout?: () => void;
  public onApplyStateChange?: (state: ApplyState) => void;

  constructor() {
    this.manager = new BrowserSessionManager();
    this.gemini = new GeminiService();
  }

  public setContext(context: ControllerContext): void {
    this.context = {
      targetRole: context.targetRole,
      profile: context.profile,
      resumeText: context.resumeText,
      externalAnswers: context.externalAnswers,
      jobDescription: context.jobDescription
    };
  }

  public setConfig(config: Partial<ApplyConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info("mode.selected", { mode: this.config.mode });
  }

  private setStatus(status: ApplyState): void {
    this.state.status = status;
    logger.info("apply.state_changed", { status });
    if (this.onApplyStateChange) {
      this.onApplyStateChange(status);
    }
  }

  public async start(url?: string): Promise<void> {
    logger.info("apply.start", { targetUrl: url });
    logger.info("mode.selected", { mode: this.config.mode });

    this.filledFields = [];
    this.state.editedAnswers = {};
    this.currentFieldIndex = 0;
    this.mappedFields = [];
    this.requiredUnmappedFields = [];
    this.errorCount = 0;
    this.state.tailoredResume = null;
    this.state.enhancedAnswers = {};
    this.state.diffSummary = [];
    this.state.jobScore = null;
    this.skipCurrentJob = false;

    try {
      await this.initialize(url);
    } catch (e: any) {
      this.errorCount += 1;
      logger.error("apply.fatal", { error: e.message });
      this.setStatus("error");
      return;
    }

    if (this.state.status === "captcha" || this.state.status === "paused") {
      return;
    }

    try {
      await this.detectForm();
    } catch {
      this.errorCount += 1;
      return;
    }

    try {
      await this.generateAnswers();
    } catch {
      this.errorCount += 1;
      return;
    }

    if (this.skipCurrentJob) {
      logger.info("apply.skipped_by_scoring");
      return;
    }

    try {
      await this.prepareMappedFields();

      const decision = await this.handleMode(this.mappedFields, this.requiredUnmappedFields);
      logger.info("auto.decision", { decision, mode: this.config.mode });

      if (decision === "review") {
        await this.requestReview();
        return;
      }

      await this.fillForm();
    } catch {
      this.errorCount += 1;
      if (this.config.mode !== "assist") {
        await this.fallbackToReview("mapping_failure");
      }
      return;
    }
  }

  public async initialize(url?: string): Promise<void> {
    await this.manager.connect();
    this.page = await this.manager.getPage(url);

    if (!this.page) {
      throw new Error("No browser page available");
    }

    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    }

    this.targetDomain = new URL(this.page.url()).hostname;

    const hasCaptcha = await this.checkForCaptcha();
    if (hasCaptcha) {
      this.pause();
    }
  }

  public async detectForm(): Promise<void> {
    if (!this.page) {
      throw new Error("start() must be called before detectForm()");
    }

    this.setStatus("detecting");

    try {
      this.state.fields = await detectFields(this.page);

      if (this.state.fields.length === 0) {
        logger.error("apply.no_form_found");
        this.setStatus("error");
        throw new Error("No fillable form fields were detected");
      }

      logger.info("apply.detected", { count: this.state.fields.length });
      logger.info("apply.labels_extracted", {
        labels: this.state.fields.map((field) => field.label).slice(0, 20)
      });
    } catch (e: any) {
      logger.error("apply.detect_failed", { message: e.message });
      this.setStatus("error");
      throw e;
    }
  }

  public async generateAnswers(): Promise<void> {
    if (this.state.fields.length === 0) {
      throw new Error("detectForm() must run before generateAnswers()");
    }

    logger.info("apply.generate_started", { fieldCount: this.state.fields.length });
    logger.info("tailor.started");

    try {
      const questions = this.state.fields.map((field) => field.label);
      const jobDescription =
        this.context.jobDescription ??
        [this.context.targetRole ?? "", ...questions].join(" ").trim();

      let tailoringSkipped = false;
      let jobProfile: JobProfile | null = null;
      let tailoredResume: TailoredResume | null = null;
      let diffSummary: string[] = [];

      if (!jobDescription || jobDescription.length < 50) {
        logger.warn("job.invalid_description");
        tailoringSkipped = true;
      } else {
        const jobHash = createHash("sha256").update(jobDescription).digest("hex").slice(0, 16);
        const cached = LiveApplyController.tailoringCache.get(jobHash);
        if (cached) {
          logger.info("tailor.cache_hit", { jobHash });
          jobProfile = cached.jobProfile;
          tailoredResume = cached.tailoredResume;
          diffSummary = [...cached.diffSummary];
        } else {
          jobProfile = await analyzeJob({
            jobDescription
          });
          logger.info("job.analyzed", { role: jobProfile.role });

          tailoredResume = await tailorResume({
            originalResume: this.context.resumeText ?? "",
            jobDescription,
            requiredSkills: jobProfile.skills,
            preferredSkills: jobProfile.keywords
          });
          logger.info("resume.tailored");

          const topSkills = jobProfile.skills.slice(0, 5);
          if (topSkills.length > 0) {
            diffSummary.push(`Reordered skills to prioritize ${topSkills.slice(0, 3).join(", ")}`);
          }
          if (tailoredResume.summary && tailoredResume.summary !== (this.context.resumeText ?? "").split(/\r?\n/)[0]) {
            diffSummary.push(`Updated summary for ${jobProfile.role.toLowerCase()} role`);
          }

          LiveApplyController.tailoringCache.set(jobHash, {
            jobProfile,
            tailoredResume,
            diffSummary
          });
        }

        if (jobProfile) {
          const profileText = [
            this.context.resumeText ?? "",
            ...Object.values(this.context.profile ?? {})
          ].join(" ");
          const inferredSkills = jobProfile.skills.filter((skill) =>
            profileText.toLowerCase().includes(skill.toLowerCase())
          );

          const scored = scoreJob({
            jobProfile,
            userProfile: {
              skills: inferredSkills,
              resumeText: this.context.resumeText,
              yearsExperience: Number(this.context.profile?.yearsExperience ?? 0) || undefined
            },
            jobDescription
          });

          this.state.jobScore = scored;
          logger.info("job.score", { score: scored.score });
          logger.info("job.decision", { decision: scored.decision });
          logger.info("job.reasons", { reasons: scored.reasons });

          if (scored.decision === "skip") {
            this.skipCurrentJob = true;
            this.state.answers = {};
            this.state.enhancedAnswers = {};
            this.state.tailoredResume = null;
            this.state.diffSummary = ["Skipped by job scoring decision"];
            this.setStatus("idle");
            return;
          }

          if (scored.decision === "review" && this.config.mode !== "assist") {
            // Downgrade to assist only when the user has NOT already chosen assist.
            this.config = { ...this.config, mode: "assist" };
            logger.info("mode.selected", { mode: this.config.mode });
          }

          // Never upgrade the user's explicit assist (auto-off) choice based on job scoring.
          // If the user chose assist mode, keep it regardless of decision.
        }
      }

      this.state.tailoredResume = tailoredResume;
      this.state.diffSummary = diffSummary;

      const fieldKeywords = this.state.fields
        .map((field) => field.label)
        .join(" ")
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length >= 4)
        .slice(0, 40);

      const mergedKeywords = Array.from(
        new Set([
          ...fieldKeywords,
          ...(jobProfile?.skills ?? []),
          ...(jobProfile?.keywords ?? [])
        ])
      ).slice(0, 50);

      const tailoredResumeText = [
        tailoredResume?.summary,
        `Skills: ${(tailoredResume?.skills ?? []).join(", ")}`,
        ...(tailoredResume?.experience ?? [])
      ]
        .filter(Boolean)
        .join("\n");

      const aiResult = await this.gemini.generateFormAnswers({
        targetRole: this.context.targetRole,
        keywords: mergedKeywords,
        profile: this.context.profile,
        resumeText: tailoredResumeText || this.context.resumeText
      });

      const baseline: AnswerMap = {
        ...(aiResult.answers ?? {}),
        ...(this.context.externalAnswers ?? {})
      };

      if (tailoringSkipped || !jobProfile) {
        this.state.enhancedAnswers = {};
        this.state.answers = baseline;
      } else {
        const enhancedAnswers = await enhanceAnswers({
          questions,
          baseAnswers: baseline,
          jobProfile
        });

        this.state.enhancedAnswers = enhancedAnswers;
        if (Object.keys(enhancedAnswers).length > 0) {
          this.state.diffSummary = [
            ...this.state.diffSummary,
            `Enhanced answers with ${jobProfile.keywords.slice(0, 2).join(" and ")} context`
          ];
        }
        logger.info("answers.enhanced");

        this.state.answers = { ...baseline, ...enhancedAnswers };
      }

      logger.info("tailor.completed", {
        skipped: tailoringSkipped,
        diffCount: this.state.diffSummary.length
      });
      logger.info("apply.answers_generated", { answerCount: Object.keys(this.state.answers).length });
    } catch (e: any) {
      logger.error("apply.generate_failed", { message: e.message });
      this.setStatus("error");
      throw e;
    }
  }

  public prepareTailoredResumePdf(): void {
    if (!this.state.tailoredResume) {
      return;
    }
    generatePDF(this.state.tailoredResume);
  }

  public async requestReview(): Promise<void> {
    this.setStatus("review");
    logger.info("apply.review_requested");

    const requiredUnmapped =
      this.requiredUnmappedFields.length > 0
        ? this.requiredUnmappedFields
        : this.state.fields.filter((field) => {
            const answer = this.state.answers[field.label];
            return field.required && (!answer || answer.trim().length === 0);
          });

    const reviewNotifyPromise = Promise.resolve().then(() => {
      if (this.onReviewRequested) {
        this.onReviewRequested({
          fields: this.state.fields,
          answers: this.state.answers,
          requiredUnmapped
        });
      }
    });

    const gatePromise = new Promise<void>((resolve) => {
      this.reviewResolver = resolve;
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.state.status === "review") {
          logger.warn("apply.review_timeout");
          this.pause();
          if (this.onReviewTimeout) {
            this.onReviewTimeout();
            logger.info("apply.review_timeout_ui_triggered");
          }
        }
        resolve();
      }, this.reviewTimeoutMs);
    });

    await reviewNotifyPromise;
    await Promise.race([
      gatePromise,
      timeoutPromise
    ]);

    if (this.state.status !== "review") {
      if (this.reviewResolver) {
        this.reviewResolver = null;
      }
      return;
    }

    if (this.reviewResolver) {
      this.reviewResolver = null;
    }
  }

  private sanitizeAnswers(answers: Record<string, string>): Record<string, string> {
    const cleanedEntries = Object.entries(answers)
      .map(([key, value]) => {
        const normalized = typeof value === "string" ? value.trim() : "";
        if (!normalized || normalized.length < 3) {
          return [key, null] as const;
        }
        return [key, normalized] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry[1] !== null);

    return Object.fromEntries(cleanedEntries);
  }

  private async prepareMappedFields(): Promise<void> {
    const finalAnswers = { ...this.state.answers, ...this.state.editedAnswers };
    const cleanedAnswers = this.sanitizeAnswers(finalAnswers);
    this.mappedFields = mapFieldsToAnswers(this.state.fields, cleanedAnswers);
    this.requiredUnmappedFields = this.mappedFields
      .filter((item) => item.field.required && item.value === null)
      .map((item) => item.field);

    if (this.mappedFields.length === 0) {
      throw new Error("Mapping failed: no fields available to fill");
    }
  }

  public async handleMode(
    mappedFields: MappedField[],
    requiredUnmapped: FormField[]
  ): Promise<"auto" | "review"> {
    if (this.config.mode === "assist") {
      return "review";
    }

    if (this.config.mode === "full_auto") {
      if (requiredUnmapped.length > 0) {
        logger.warn("full_auto_blocked_required_unmapped", {
          count: requiredUnmapped.length
        });
        return "review";
      }
      logger.info("mode.full_auto");
      return "auto";
    }

    if (this.firstRun) {
      logger.info("auto.first_run_review");
      return "review";
    }

    return shouldAutoApply({
      mappedFields,
      requiredUnmapped,
      config: this.config
    });
  }

  private async fallbackToReview(reason: string): Promise<void> {
    logger.warn("auto.fallback_to_review", { reason });
    if (this.config.mode === "assist") {
      return;
    }
    await this.requestReview();
  }

  private async verifyDomainBeforeAction(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    if (!this.page.url().includes(this.targetDomain)) {
      logger.warn("apply.domain_mismatch", {
        currentUrl: this.page.url(),
        targetDomain: this.targetDomain
      });
      this.pause();
      return false;
    }

    return true;
  }

  public async applyEdits(edits: Record<string, string>): Promise<void> {
    this.state.editedAnswers = { ...this.state.editedAnswers, ...edits };
    logger.info("apply.edits_applied", { editedCount: Object.keys(this.state.editedAnswers).length });
  }

  public async fillForm(resumingFromPause = false): Promise<void> {
    if (!this.page) {
      logger.warn("apply.fill_blocked", { reason: "No active page" });
      return;
    }

    if (this.state.status === "filling") {
      logger.warn("apply.fill_blocked", { reason: "Already filling" });
      return;
    }

    const canAutoStart = this.config.mode !== "assist";
    if (!resumingFromPause && this.state.status !== "review" && !canAutoStart) {
      logger.warn("apply.fill_blocked", { reason: "Must be in review state" });
      return;
    }

    if (!resumingFromPause && this.state.status === "review" && this.reviewResolver) {
      this.reviewResolver();
      this.reviewResolver = null;
    }

    if (!resumingFromPause) {
      this.setStatus("filling");
      logger.info("apply.fill_started");
    } else {
      logger.info("apply.resume_from_index", { currentFieldIndex: this.currentFieldIndex });
    }

    engineResume();

    const hasCaptcha = await this.detectCaptchaSignal();
    if (hasCaptcha) {
      this.setStatus("captcha");
      this.pause("filling");
      if (this.onCaptchaDetected) this.onCaptchaDetected();
      return;
    }

    if (!this.page.url().includes(this.targetDomain)) {
      logger.warn("apply.domain_mismatch", {
        currentUrl: this.page.url(),
        targetDomain: this.targetDomain
      });
      this.pause("filling");
      return;
    }

    try {
      if (!resumingFromPause) {
        const valid = await validatePage(this.page, this.targetDomain);
        if (!valid) throw new Error("Domain validation failed");

        await this.prepareMappedFields();
        this.currentFieldIndex = 0;
      }

      const requiredUnmapped = this.mappedFields.filter((item) => item.field.required && item.value === null);
      if (requiredUnmapped.length > 0) {
        logger.warn("apply.required_unmapped", {
          labels: requiredUnmapped.map((item) => item.field.label)
        });
        if (this.config.mode !== "assist") {
          await this.fallbackToReview("required_unmapped_detected_late");
          return;
        }
      }

      let fillErrorCount = 0;

      for (let i = this.currentFieldIndex; i < this.mappedFields.length; i++) {
        this.currentFieldIndex = i;
        const mappedField = this.mappedFields[i];

        const hasStepCaptcha = await this.detectCaptchaSignal();
        if (hasStepCaptcha) {
          this.setStatus("captcha");
          this.pause("filling");
          if (this.onCaptchaDetected) this.onCaptchaDetected();
          return;
        }

        const domainOk = await this.verifyDomainBeforeAction();
        if (!domainOk) {
          return;
        }

        if (this.dryRun) {
          logger.info("apply.dry_run", { label: mappedField.field.label, index: i });
          await this.simulateDelay(300, 800);
          this.currentFieldIndex = i + 1;
          continue;
        }

        try {
          await fillFormFields(this.page, [mappedField], this.targetDomain);
        } catch {
          this.errorCount += 1;
          fillErrorCount += 1;
          logger.warn("apply.field_retry", { label: mappedField.field.label });
          await this.simulateDelay(300, 800);
          try {
            await fillFormFields(this.page, [mappedField], this.targetDomain);
          } catch {
            this.errorCount += 1;
            fillErrorCount += 1;
            logger.error("apply.field_failed", { label: mappedField.field.label });
            if (this.config.mode !== "assist" && fillErrorCount >= 2) {
              await this.fallbackToReview("fill_errors_spike");
              return;
            }
            this.currentFieldIndex = i + 1;
            continue;
          }
        }

        if (mappedField.value) {
          this.filledFields.push({
            label: mappedField.field.label,
            selector: mappedField.field.selector
          });
          logger.info("apply.progress", { filledCount: this.filledFields.length });
        }

        this.currentFieldIndex = i + 1;
      }

      this.currentFieldIndex = 0;
      this.setStatus("idle");
      // Never auto-submit in Phase 4.1. User remains in control.
      logger.info("apply.completed", { autoSubmit: false });

      this.firstRun = false;

      if (this.config.mode !== "assist" && this.config.autoSubmit) {
        if (this.requiredUnmappedFields.length > 0) {
          logger.warn("auto.submit_blocked_required_unmapped", {
            count: this.requiredUnmappedFields.length
          });
          return;
        }

        if (this.errorCount > 0) {
          logger.warn("auto.submit_blocked_errors", { errorCount: this.errorCount });
          return;
        }

        await this.clickSubmitButton();
      }

    } catch (e: any) {
      this.errorCount += 1;
      logger.error("apply.fill_failed", { message: e.message });
      this.setStatus("error");
      if (this.config.mode !== "assist") {
        await this.fallbackToReview("fill_failed");
      }
    }
  }

  public pause(previousState?: ApplyState): void {
    this.lastStateBeforePause = previousState ?? this.state.status;
    this.setStatus("paused");
    enginePause();
    logger.warn("apply.paused", { previousState: this.lastStateBeforePause });
  }

  public resume(): void {
    if (this.state.status !== "paused" && this.state.status !== "captcha") {
      return;
    }

    engineResume();
    const nextStatus: ApplyState = this.lastStateBeforePause || "idle";
    this.setStatus(nextStatus);
    logger.info("apply.resumed", { status: nextStatus });

    if (this.lastStateBeforePause === "filling") {
      void this.fillForm(true);
    }
  }

  private async clickSubmitButton(): Promise<void> {
    if (!this.page) return;

    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "button:has-text('Submit')",
      "button:has-text('Apply')"
    ];

    for (const selector of submitSelectors) {
      const locator = this.page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;

      await locator.click().catch(() => {});
      logger.info("auto.submit_triggered", { selector });
      return;
    }

    logger.warn("auto.submit_triggered", { selector: "not_found" });
  }

  private async simulateDelay(minMs: number, maxMs: number): Promise<void> {
    const duration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await new Promise<void>((resolve) => setTimeout(resolve, duration));
  }

  private async detectCaptchaSignal(): Promise<boolean> {
    if (!this.page) return false;

    try {
      return await this.page.evaluate(() => {
        const iframeSignals = Array.from(document.querySelectorAll("iframe")).some((frame) => {
          const src = (frame.getAttribute("src") ?? "").toLowerCase();
          return src.includes("captcha") || src.includes("turnstile") || src.includes("challenge");
        });

        const domSignals = [
          "[data-sitekey]",
          "#captcha",
          ".g-recaptcha",
          "iframe[title*='captcha' i]",
          "iframe[src*='recaptcha' i]",
          "iframe[src*='hcaptcha' i]"
        ].some((selector) => !!document.querySelector(selector));

        return iframeSignals || domSignals;
      });
    } catch {
      return false;
    }
  }

  private async checkForCaptcha(): Promise<boolean> {
    const hasCaptcha = await this.detectCaptchaSignal();

    if (hasCaptcha) {
      logger.warn("apply.captcha_detected");
      enginePause();
      this.setStatus("captcha");
      if (this.onCaptchaDetected) this.onCaptchaDetected();
      return true;
    }

    return false;
  }
}
