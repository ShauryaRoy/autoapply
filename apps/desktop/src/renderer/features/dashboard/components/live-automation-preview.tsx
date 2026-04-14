import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Button } from "../../../components/ui/button.js";
import type { UserProfile } from "../../../api.js";

type LiveAutomationPreviewProps = {
  jobUrl?: string;
  profile: UserProfile;
  generatedAnswers: Array<{ prompt: string; answer: string }>;
};

export function LiveAutomationPreview({ jobUrl, profile, generatedAnswers }: LiveAutomationPreviewProps) {
  const [address, setAddress] = useState("");
  const [currentSrc, setCurrentSrc] = useState("");
  const [embeddedMessage, setEmbeddedMessage] = useState("Ready");
  const [autoModeEnabled, setAutoModeEnabled] = useState(true);
  const [autoModeRunning, setAutoModeRunning] = useState(false);
  const webviewRef = useRef<any>(null);
  const autoHandledUrlRef = useRef<string>("");
  const autoLoopTokenRef = useRef(0);

  const normalizedJobUrl = useMemo(() => (jobUrl ?? "").trim(), [jobUrl]);

  useEffect(() => {
    if (!normalizedJobUrl) return;
    setAddress(normalizedJobUrl);
    setCurrentSrc(normalizedJobUrl);
  }, [normalizedJobUrl]);

  useEffect(() => {
    const node = webviewRef.current;
    if (!node) return;

    const onNav = (event: any) => {
      if (event?.url) {
        setAddress(String(event.url));
      }
    };

    node.addEventListener("did-navigate", onNav);
    node.addEventListener("did-navigate-in-page", onNav);

    return () => {
      node.removeEventListener("did-navigate", onNav);
      node.removeEventListener("did-navigate-in-page", onNav);
    };
  }, [currentSrc]);

  const loadAddress = () => {
    if (!address.trim()) return;
    const candidate = address.trim();
    const next = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    setCurrentSrc(next);
  };

  const runInWebview = async (script: string) => {
    const node = webviewRef.current;
    if (!node) {
      setEmbeddedMessage("Webview not ready yet.");
      return null;
    }

    try {
      const result = await node.executeJavaScript(script, true);
      return result as { message?: string; filled?: number; clicked?: boolean } | null;
    } catch (error) {
      setEmbeddedMessage(error instanceof Error ? error.message : "Failed to run in-app automation action.");
      return null;
    }
  };

  const locateApplicationFormInEmbeddedTab = async () => {
    setEmbeddedMessage("Searching for application form...");

    const script = `(() => {
      const normalize = (value) => String(value || "").toLowerCase().trim();

      const collectDocs = () => {
        const docs = [document];
        const frames = Array.from(document.querySelectorAll("iframe"));
        for (const frame of frames) {
          try {
            const doc = frame.contentDocument;
            if (doc?.body) docs.push(doc);
          } catch {
            // Cross-origin frame, skip.
          }
        }
        return docs;
      };

      const visible = (element, view) => {
        const style = view.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const docs = collectDocs();
      let fillable = 0;
      for (const doc of docs) {
        const view = doc.defaultView || window;
        const candidates = Array.from(doc.querySelectorAll("input, textarea, select"));
        fillable += candidates.filter((node) => {
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return false;
          if (node.disabled || node.readOnly) return false;
          if (node instanceof HTMLInputElement && ["hidden", "submit", "button"].includes(node.type)) return false;
          return visible(node, view);
        }).length;
      }

      if (fillable >= 6) {
        return { clicked: false, message: "Application form already visible" };
      }

      const score = (text) => {
        const t = normalize(text);
        if (!t) return 0;
        if (t.includes("start application")) return 120;
        if (t.includes("apply for this job")) return 115;
        if (t.includes("apply now")) return 110;
        if (t === "apply") return 100;
        if (t.includes("continue application")) return 95;
        if (t.includes("continue")) return 80;
        return 0;
      };

      let best = null;
      for (const doc of docs) {
        const view = doc.defaultView || window;
        const nodes = Array.from(doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true") continue;
          if (!visible(node, view)) continue;
          const text = String(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "");
          const nodeScore = score(text);
          if (nodeScore <= 0) continue;
          if (!best || nodeScore > best.score) {
            best = { node, score: nodeScore };
          }
        }
      }

      if (!best) {
        return { clicked: false, message: "Could not find Apply/Start button on this page" };
      }

      best.node.scrollIntoView({ block: "center" });
      best.node.click();

      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ clicked: true, message: "Opened application form" });
        }, 900);
      });
    })();`;

    const result = await runInWebview(script);
    if (!result) return null;
    setEmbeddedMessage(result.message ?? "Form discovery step completed.");
    return result;
  };

  const automateFillInEmbeddedTab = async () => {
    const payload = {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedIn: profile.linkedIn ?? profile.links?.linkedin ?? "",
      github: profile.links?.github ?? "",
      portfolio: profile.portfolio ?? profile.links?.portfolio ?? "",
      whyCompany: profile.whyCompany ?? generatedAnswers.find((item) => item.prompt.toLowerCase().includes("why"))?.answer ?? "",
      yearsExperience: profile.yearsExperience ?? "",
      resumeText: profile.resumeText ?? "",
      answers: generatedAnswers
    };

    setEmbeddedMessage("Filling visible fields...");

    const script = `(async () => {
      const data = ${JSON.stringify(payload)};

      const normalize = (value) => String(value || "").toLowerCase();
      const trim = (value) => String(value || "").trim();
      const nextFallbackAnswer = (() => {
        let index = 0;
        const pool = (data.answers || []).map((item) => trim(item.answer)).filter(Boolean);
        return () => {
          if (pool.length === 0) return "";
          const value = pool[index % pool.length];
          index += 1;
          return value;
        };
      })();

      const byPrompt = (label) => {
        const key = normalize(label);
        const found = (data.answers || []).find((item) => key.includes(normalize(item.prompt)) || normalize(item.prompt).includes(key));
        return found ? trim(found.answer) : "";
      };

      const fieldValue = (label) => {
        const key = normalize(label);
        if (!key) return "";

        if (key.includes("first name")) return trim(data.firstName);
        if (key.includes("last name")) return trim(data.lastName);
        if (key.includes("email")) return trim(data.email);
        if (key.includes("phone")) return trim(data.phone);
        if (key.includes("linkedin")) return trim(data.linkedIn);
        if (key.includes("github")) return trim(data.github);
        if (key.includes("portfolio") || key.includes("website")) return trim(data.portfolio || data.github || data.linkedIn);
        if (key.includes("city") || key.includes("location") || key.includes("where are you based") || key.includes("current location")) return trim(data.location);
        if (key.includes("years") && key.includes("experience")) return trim(data.yearsExperience || "3");
        if (key.includes("why") && key.includes("company")) return trim(data.whyCompany || byPrompt(label));
        if (key.includes("cover letter")) return trim(data.resumeText || data.whyCompany || byPrompt(label));
        if (key.includes("authorized") || key.includes("sponsorship") || key.includes("visa")) return "Yes";

        const fromPrompt = byPrompt(label);
        if (fromPrompt) return fromPrompt;
        return nextFallbackAnswer();
      };

      const collectDocs = () => {
        const docs = [document];
        const frames = Array.from(document.querySelectorAll("iframe"));
        for (const frame of frames) {
          try {
            const doc = frame.contentDocument;
            if (doc?.body) docs.push(doc);
          } catch {
            // Cross-origin frame, skip.
          }
        }
        return docs;
      };

      const getLabel = (field, doc) => {
        const id = field.id;
        const htmlFor = id ? doc.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
        const wrapped = field.closest("label");
        const group = field.closest("fieldset")?.querySelector("legend");
        const aria = field.getAttribute("aria-label");
        const placeholder = field.getAttribute("placeholder");
        const name = field.getAttribute("name");
        return trim((htmlFor && htmlFor.textContent) || (wrapped && wrapped.textContent) || (group && group.textContent) || aria || placeholder || name || id || "");
      };

      const visible = (field, view) => {
        const style = view.getComputedStyle(field);
        const rect = field.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const setNativeValue = (element, value) => {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(element, value);
        } else {
          element.value = value;
        }
      };

      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const typeHumanLike = async (field, value) => {
        const text = String(value || "");
        if (!text) return false;

        field.focus();
        setNativeValue(field, "");
        field.dispatchEvent(new Event("input", { bubbles: true }));

        if (field instanceof HTMLTextAreaElement && text.length > 260) {
          // Long answers: type by chunks to remain visible while avoiding excessive delay.
          const chunks = text.match(/.{1,24}/g) || [text];
          let current = "";
          for (const chunk of chunks) {
            current += chunk;
            setNativeValue(field, current);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            await pause(35 + Math.floor(Math.random() * 30));
          }
        } else {
          let current = "";
          for (const ch of text) {
            current += ch;
            field.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
            setNativeValue(field, current);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
            await pause(12 + Math.floor(Math.random() * 26));
          }
        }

        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
        return true;
      };

      const fillElement = async (field, value) => {
        if (!value) return false;

        if (field instanceof HTMLSelectElement) {
          const options = Array.from(field.options);
          const target = options.find((option) => normalize(option.textContent).includes(normalize(value)) || normalize(value).includes(normalize(option.textContent)));
          if (target) {
            field.value = target.value;
          } else {
            const fallback = options.find((option) => trim(option.value) && !normalize(option.textContent).includes("select"));
            if (!fallback) return false;
            field.value = fallback.value;
          }
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        const existing = trim((field).value);
        if (existing && existing.length > 1) return false;

        return typeHumanLike(field, value);
      };

      const tryDirectSelectors = async (doc) => {
        const directMap = [
          { selector: "#first_name, input[name='first_name'], input[id*='first_name']", value: trim(data.firstName) },
          { selector: "#last_name, input[name='last_name'], input[id*='last_name']", value: trim(data.lastName) },
          { selector: "#email, input[type='email'], input[name='email']", value: trim(data.email) },
          { selector: "#phone, input[type='tel'], input[name*='phone']", value: trim(data.phone) },
          { selector: "#website, input[name*='website'], input[name*='portfolio']", value: trim(data.portfolio || data.github || data.linkedIn) },
          { selector: "input[name*='linkedin'], #linkedin", value: trim(data.linkedIn) },
          { selector: "input[name*='github'], #github", value: trim(data.github) },
          { selector: "textarea[name*='cover'], textarea[id*='cover'], textarea[name*='letter']", value: trim(data.resumeText || data.whyCompany) },
          { selector: "input[name*='location'], #location, input[id*='location'], input[id*='city']", value: trim(data.location) }
        ];

        let directFilled = 0;
        for (const item of directMap) {
          if (!item.value) continue;
          const field = doc.querySelector(item.selector);
          if (!field) continue;
          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
          if (await fillElement(field, item.value)) {
            directFilled += 1;
          }
        }

        const greenhouseQuestions = Array.from(doc.querySelectorAll("input[id^='question_'], textarea[id^='question_'], select[id^='question_']"));
        for (const field of greenhouseQuestions) {
          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
          const label = getLabel(field, doc);
          const value = fieldValue(label);
          if (await fillElement(field, value)) {
            directFilled += 1;
          }
        }

        return directFilled;
      };

      let filled = 0;
      const docs = collectDocs();
      let scanned = 0;

      for (const doc of docs) {
        scanned += 1;
        filled += await tryDirectSelectors(doc);
      }

      for (const doc of docs) {
        const view = doc.defaultView || window;
        const candidates = Array.from(doc.querySelectorAll("input, textarea, select"))
          .filter((field) => {
            if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return false;
            if (field.disabled || field.readOnly) return false;
            if (!visible(field, view)) return false;
            if (field instanceof HTMLInputElement && ["hidden", "file", "checkbox", "radio", "submit", "button"].includes(field.type)) return false;
            return true;
          });

        for (const field of candidates) {
          const label = getLabel(field, doc);
          const value = fieldValue(label);
          if (!value) continue;
          if (await fillElement(field, value)) {
            filled += 1;
          }
        }
      }

      return { filled, message: 'Filled ' + filled + ' fields across ' + scanned + ' document scopes' };
    })();`;

    const result = await runInWebview(script);
    if (!result) return null;
    setEmbeddedMessage(result.message ?? "Fill step completed.");
    return result;
  };

  const advanceEmbeddedTab = async () => {
    setEmbeddedMessage("Trying Next/Submit...");

    const script = `(() => {
      const collectDocs = () => {
        const docs = [document];
        const frames = Array.from(document.querySelectorAll("iframe"));
        for (const frame of frames) {
          try {
            const doc = frame.contentDocument;
            if (doc?.body) docs.push(doc);
          } catch {
            // Cross-origin frame, skip.
          }
        }
        return docs;
      };

      const score = (element) => {
        const text = String(element.textContent || element.getAttribute("value") || "").toLowerCase();
        if (!text) return 0;
        if (text.includes("submit application")) return 100;
        if (text.includes("submit")) return 90;
        if (text.includes("complete application")) return 85;
        if (text.includes("apply")) return 80;
        if (text.includes("next")) return 70;
        if (text.includes("continue")) return 60;
        return 0;
      };

      const visible = (element, view) => {
        const style = view.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const ranked = [];
      for (const doc of collectDocs()) {
        const view = doc.defaultView || window;
        const selectors = [
          "button[type='submit']",
          "input[type='submit']",
          "button",
          "a",
          "[role='button']"
        ];
        const candidates = selectors.flatMap((selector) => Array.from(doc.querySelectorAll(selector)));

        for (const el of candidates) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
          if (!visible(el, view)) continue;
          const value = score(el);
          if (value <= 0) continue;
          ranked.push({ el, score: value });
        }
      }

      ranked.sort((a, b) => b.score - a.score);

      const best = ranked[0];
      if (!best) {
        return { clicked: false, message: "No visible Next/Submit button found" };
      }

      best.el.scrollIntoView({ block: "center" });
      best.el.click();
      return { clicked: true, message: "Clicked " + String(best.el.textContent || best.el.getAttribute("value") || "action") };
    })();`;

    const result = await runInWebview(script);
    if (!result) return null;
    setEmbeddedMessage(result.message ?? "Advance step completed.");
    return result;
  };

  const runSingleAutomationStep = async () => {
    await locateApplicationFormInEmbeddedTab();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await automateFillInEmbeddedTab();
    await advanceEmbeddedTab();
  };

  const runAutoModeSequence = async () => {
    if (!autoModeEnabled || autoModeRunning) return;

    const token = Date.now();
    autoLoopTokenRef.current = token;
    setAutoModeRunning(true);
    setEmbeddedMessage("Auto mode running...");

    try {
      for (let i = 0; i < 8; i++) {
        if (autoLoopTokenRef.current !== token) break;

        const locate = await locateApplicationFormInEmbeddedTab();
        await new Promise((resolve) => setTimeout(resolve, 450));

        if (autoLoopTokenRef.current !== token) break;
        const fill = await automateFillInEmbeddedTab();
        await new Promise((resolve) => setTimeout(resolve, 450));

        if (autoLoopTokenRef.current !== token) break;
        const advance = await advanceEmbeddedTab();

        const locateProgress = !!locate?.clicked;
        const fillProgress = (fill?.filled ?? 0) > 0;
        const advanceProgress = !!advance?.clicked;
        const progressed = locateProgress || fillProgress || advanceProgress;

        const advanceMessage = (advance?.message ?? "").toLowerCase();
        if (advanceMessage.includes("submit")) {
          setEmbeddedMessage("Auto mode completed: submit action triggered.");
          break;
        }

        if (!progressed) {
          setEmbeddedMessage("Auto mode stopped: no further actionable form steps.");
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } finally {
      if (autoLoopTokenRef.current === token) {
        setAutoModeRunning(false);
      }
    }
  };

  const stopAutoMode = () => {
    autoLoopTokenRef.current = 0;
    setAutoModeRunning(false);
    setEmbeddedMessage("Auto mode stopped.");
  };

  useEffect(() => {
    if (!currentSrc) return;
    if (autoHandledUrlRef.current === currentSrc) return;

    autoHandledUrlRef.current = currentSrc;

    const timer = window.setTimeout(() => {
      void runAutoModeSequence();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [autoModeEnabled, currentSrc]);

  const WebviewTag = "webview" as any;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">In-App Browser Automation</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-rose-400/80" />
            <span className="h-2 w-2 rounded-full bg-amber-400/80" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
            <p className="ml-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">Browser Session</p>
          </div>

          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.goBack?.()}>
              Back
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.goForward?.()}>
              Forward
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.reload?.()}>
              Reload
            </Button>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  loadAddress();
                }
              }}
              placeholder="https://job-boards.greenhouse.io/..."
              className="h-8 flex-1 rounded border border-slate-300 px-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            />
            <Button type="button" size="sm" variant="default" onClick={loadAddress}>Go</Button>
            <Button
              type="button"
              size="sm"
              variant={autoModeEnabled ? "default" : "ghost"}
              onClick={() => {
                setAutoModeEnabled((value) => !value);
              }}
            >
              Auto Mode {autoModeEnabled ? "On" : "Off"}
            </Button>
            {autoModeRunning ? (
              <Button type="button" size="sm" variant="danger" onClick={stopAutoMode}>
                Stop Auto
              </Button>
            ) : null}
          </div>

          <div className="border-b border-slate-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            In-App automation enabled for this exact tab. Status: {embeddedMessage}
          </div>

          <div className="relative h-[460px] bg-slate-50">
            {currentSrc ? (
              <WebviewTag
                ref={webviewRef}
                src={currentSrc}
                style={{ width: "100%", height: "100%", display: "inline-flex" }}
                allowpopups="true"
                partition="persist:autoapply-embedded"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                Select a job URL and press Go to browse inside AutoApply.
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
