import { LiveApplyController } from "./liveApplyController.js";
import { logger } from "../browser/logger.js";
import { type MappedField } from "../form/types.js";

type ScenarioResult = {
  name: string;
  status: "pass" | "fail";
  details: string;
};

function createController(): LiveApplyController {
  const controller = new LiveApplyController();
  controller.setContext({
    targetRole: "Frontend Engineer",
    profile: {
      firstName: "Test",
      lastName: "User",
      email: "test.user@example.com",
      phone: "555-0199",
      location: "Remote"
    },
    resumeText: "Built and shipped production web apps with React, TypeScript, and automation tooling."
  });

  controller.onApplyStateChange = (status) => {
    console.log(`[STATUS] ${status.toUpperCase()}`);
  };

  controller.onCaptchaDetected = () => {
    console.log("[ALERT] CAPTCHA detected");
  };

  return controller;
}

function stubPipeline(controller: LiveApplyController, mappedFields: MappedField[], requiredUnmapped: any[] = []): void {
  (controller as any).initialize = async () => {
    (controller as any).page = {};
    (controller as any).targetDomain = "example.com";
  };
  (controller as any).detectForm = async () => {
    controller.state.fields = mappedFields.map((item) => item.field);
  };
  (controller as any).generateAnswers = async () => {
    controller.state.answers = { name: "Test User" };
  };
  (controller as any).prepareMappedFields = async () => {
    (controller as any).mappedFields = mappedFields;
    (controller as any).requiredUnmappedFields = requiredUnmapped;
  };
}

async function assistAlwaysReviewsFlow(): Promise<ScenarioResult> {
  const controller = createController();
  controller.setConfig({ mode: "assist" });
  const mappedFields: MappedField[] = [
    {
      field: { label: "name", selector: "#name", type: "text", required: true },
      value: "Test User",
      confidence: "high"
    }
  ];
  stubPipeline(controller, mappedFields, []);

  let reviewCount = 0;
  let fillCount = 0;

  (controller as any).requestReview = async () => {
    reviewCount += 1;
  };
  (controller as any).fillForm = async () => {
    fillCount += 1;
  };

  await controller.start("https://example.com");
  const status = reviewCount > 0 && fillCount === 0 ? "pass" : "fail";
  return {
    name: "assist always review",
    status,
    details: `reviewCount=${reviewCount} fillCount=${fillCount}`
  };
}

async function smartAutoSafeFlow(): Promise<ScenarioResult> {
  const controller = createController();
  controller.setConfig({
    mode: "smart_auto",
    pauseOnLowConfidence: true,
    pauseOnLongAnswers: true
  });

  const mappedFields: MappedField[] = [
    {
      field: { label: "name", selector: "#name", type: "text", required: true },
      value: "Test User",
      confidence: "high"
    }
  ];
  stubPipeline(controller, mappedFields, []);

  let reviewCount = 0;
  let fillCount = 0;

  (controller as any).requestReview = async () => {
    reviewCount += 1;
  };
  (controller as any).fillForm = async () => {
    fillCount += 1;
  };

  await controller.start("https://example.com");
  const status = fillCount > 0 && reviewCount === 0 ? "pass" : "fail";
  return {
    name: "smart_auto safe form",
    status,
    details: `reviewCount=${reviewCount} fillCount=${fillCount}`
  };
}

async function smartAutoRiskyFlow(): Promise<ScenarioResult> {
  const controller = createController();
  controller.setConfig({
    mode: "smart_auto",
    pauseOnLowConfidence: true,
    pauseOnLongAnswers: true
  });

  const mappedFields: MappedField[] = [
    {
      field: { label: "name", selector: "#name", type: "text", required: true },
      value: "T",
      confidence: "low"
    }
  ];
  stubPipeline(controller, mappedFields, []);

  let reviewCount = 0;
  let fillCount = 0;

  (controller as any).requestReview = async () => {
    reviewCount += 1;
  };
  (controller as any).fillForm = async () => {
    fillCount += 1;
  };

  await controller.start("https://example.com");
  const status = reviewCount > 0 && fillCount === 0 ? "pass" : "fail";
  return {
    name: "smart_auto risky form",
    status,
    details: `reviewCount=${reviewCount} fillCount=${fillCount}`
  };
}

async function fullAutoAlwaysFillsFlow(): Promise<ScenarioResult> {
  const controller = createController();
  controller.setConfig({ mode: "full_auto" });

  const mappedFields: MappedField[] = [
    {
      field: { label: "name", selector: "#name", type: "text", required: true },
      value: "Test User",
      confidence: "low"
    }
  ];
  stubPipeline(controller, mappedFields, [{ label: "email", selector: "#email", type: "text", required: true }]);

  let fillCount = 0;
  (controller as any).fillForm = async () => {
    fillCount += 1;
  };

  await controller.start("https://example.com");
  const status = fillCount > 0 ? "pass" : "fail";
  return {
    name: "full_auto always fills",
    status,
    details: `fillCount=${fillCount}`
  };
}

async function fullAutoCaptchaStopsFlow(): Promise<ScenarioResult> {
  const controller = createController();
  controller.setConfig({ mode: "full_auto" });

  const mappedFields: MappedField[] = [
    {
      field: { label: "name", selector: "#name", type: "text", required: true },
      value: "Test User",
      confidence: "high"
    }
  ];

  (controller as any).initialize = async () => {
    (controller as any).page = {};
    (controller as any).targetDomain = "example.com";
  };
  (controller as any).detectForm = async () => {
    controller.state.fields = mappedFields.map((item) => item.field);
  };
  (controller as any).generateAnswers = async () => {
    controller.state.answers = { name: "Test User" };
  };
  (controller as any).prepareMappedFields = async () => {
    (controller as any).mappedFields = mappedFields;
    (controller as any).requiredUnmappedFields = [];
  };
  (controller as any).detectCaptchaSignal = async () => true;

  await controller.start("https://example.com");
  const status = controller.state.status === "paused" ? "pass" : "fail";
  return {
    name: "full_auto stops on captcha",
    status,
    details: `final status=${controller.state.status}`
  };
}

async function runTest() {
  logger.info("testLiveApply.started");

  const results: ScenarioResult[] = [];
  for (const scenario of [
    assistAlwaysReviewsFlow,
    smartAutoSafeFlow,
    smartAutoRiskyFlow,
    fullAutoAlwaysFillsFlow,
    fullAutoCaptchaStopsFlow
  ]) {
    results.push(await scenario());
  }

  for (const result of results) {
    const line = `[${result.status.toUpperCase()}] ${result.name}: ${result.details}`;
    if (result.status === "pass") {
      logger.info("testLiveApply.case_pass", { line });
    } else {
      logger.error("testLiveApply.case_fail", { line });
    }
    console.log(line);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTest();
}
