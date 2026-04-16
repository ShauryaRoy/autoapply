import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Button } from "../../../components/ui/button.js";
import { putProfile, saveProfile } from "../../../api.js";
import type { UserProfile } from "../../../api.js";

type UnfilledField = {
  label: string;
  selector: string;
  fieldType: "text" | "textarea" | "select" | "custom-select";
  options: string[];
  autoValue?: string;
};

type LiveAutomationPreviewProps = {
  jobUrl?: string;
  profile: UserProfile;
  generatedAnswers: Array<{ prompt: string; answer: string }>;
  onProfileUpdate?: (updated: UserProfile) => void;
};

// Injected into every webview script to polyfill CSS.escape on pages that lack it.
const CSS_ESCAPE_POLYFILL = `
try {
  if (typeof window !== "undefined" && (typeof window.CSS === "undefined" || typeof window.CSS.escape !== "function")) {
    window.CSS = window.CSS || {};
    window.CSS.escape = function(v) {
      var s = String(v); if (!s.length) return s; var r = ""; var c;
      for (var i = 0; i < s.length; i++) {
        c = s.charCodeAt(i);
        if (c >= 0x0030 && c <= 0x0039 && i === 0) { r += "\\\\3" + s[i] + " "; continue; }
        if (c === 0x002D && s.length === 1) { r += "\\\\" + s[i]; continue; }
        if (c >= 0x0080 || c === 0x002D || c === 0x005F || (c >= 0x0030 && c <= 0x0039) || (c >= 0x0041 && c <= 0x005A) || (c >= 0x0061 && c <= 0x007A)) { r += s[i]; continue; }
        r += "\\\\" + s[i];
      }
      return r;
    };
  }
} catch(e) {}
`;

const WEBVIEW_OPTION_SELECTOR = "[role='option']:not([aria-disabled='true']),[class*='__option']:not([class*='--is-disabled']),[class*='-option']:not([class*='-disabled'])";
const WEBVIEW_SNAPSHOT_ATTR = "data-autoapply-before";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function LiveAutomationPreview({ jobUrl, profile, generatedAnswers, onProfileUpdate }: LiveAutomationPreviewProps) {
  const [address, setAddress] = useState("");
  const [currentSrc, setCurrentSrc] = useState("");
  const [status, setStatus] = useState("Ready");
  const [autoModeEnabled, setAutoModeEnabled] = useState(true);
  const [autoModeRunning, setAutoModeRunning] = useState(false);
  const [unfilledFields, setUnfilledFields] = useState<UnfilledField[]>([]);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [savingAnswers, setSavingAnswers] = useState(false);

  const webviewRef = useRef<any>(null);

  // contextReadyRef is set true ONLY by dom-ready and cleared by did-navigate.
  // It is the authoritative gate before calling executeJavaScript.
  const contextReadyRef = useRef(false);
  const loopTokenRef = useRef(0);
  const restartTimerRef = useRef<number | null>(null);

  const autoModeEnabledRef = useRef(autoModeEnabled);
  useEffect(() => { autoModeEnabledRef.current = autoModeEnabled; }, [autoModeEnabled]);

  // Always-fresh refs so stale event-handler closures see the latest data.
  const profileRef = useRef(profile);
  const answersRef = useRef(generatedAnswers);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { answersRef.current = generatedAnswers; }, [generatedAnswers]);

  // Stable ref so nav-event closures always call the latest runAutoModeSequence.
  const runAutoRef = useRef<() => Promise<void>>();

  const normalizedJobUrl = useMemo(() => (jobUrl ?? "").trim(), [jobUrl]);
  useEffect(() => {
    if (!normalizedJobUrl) return;
    setAddress(normalizedJobUrl);
    setCurrentSrc(normalizedJobUrl);
  }, [normalizedJobUrl]);

  // ── Navigation / readiness event wiring ─────────────────────────────────
  useEffect(() => {
    const node = webviewRef.current;
    if (!node) return;

    const cancelRestart = () => {
      if (restartTimerRef.current !== null) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    };
    const stopLoop = () => { loopTokenRef.current = 0; setAutoModeRunning(false); };
    const scheduleRestart = (ms: number) => {
      cancelRestart();
      if (!autoModeEnabledRef.current) return;
      restartTimerRef.current = window.setTimeout(() => { restartTimerRef.current = null; void runAutoRef.current?.(); }, ms);
    };

    // Full navigation: JS context torn down — wait for dom-ready.
    const onNavigate = (e: any) => {
      if (e?.url) setAddress(String(e.url));
      contextReadyRef.current = false;
      cancelRestart();
      stopLoop();
      setStatus("Page loading...");
    };

    // dom-ready: JS context is now live. This is the ONLY reliable exec signal.
    const onDomReady = () => {
      contextReadyRef.current = true;
      setStatus("Page ready — starting automation...");
      scheduleRestart(2000);
    };

    // SPA in-page navigation: context stays alive, dom-ready won't re-fire.
    const onInPageNav = (e: any) => {
      if (e?.url) setAddress(String(e.url));
      cancelRestart();
      stopLoop();
      scheduleRestart(2200);
    };

    node.addEventListener("did-navigate", onNavigate);
    node.addEventListener("did-navigate-in-page", onInPageNav);
    node.addEventListener("dom-ready", onDomReady);
    return () => {
      node.removeEventListener("did-navigate", onNavigate);
      node.removeEventListener("did-navigate-in-page", onInPageNav);
      node.removeEventListener("dom-ready", onDomReady);
      cancelRestart();
    };
  }, [currentSrc]);

  // ── Core executor: waits for confirmed dom-ready before injecting ────────
  const runInWebview = async (script: string, timeoutMs = 15000, _label = "unknown"): Promise<any> => {
    const node = webviewRef.current;
    if (!node) { console.warn(`[AutoApply:${_label}] runInWebview – no webview node`); return null; }
    const deadline = Date.now() + timeoutMs;

    // Poll until dom-ready has fired and page is not still loading.
    while (!contextReadyRef.current || (typeof node.isLoading === "function" && node.isLoading())) {
      if (Date.now() >= deadline) {
        console.warn(`[AutoApply:${_label}] Timed out waiting for context. contextReady=${contextReadyRef.current}`);
        setStatus("Timed out waiting for page context.");
        return null;
      }
      await sleep(300);
    }

    // Sanity-ping: verify context immediately before injecting the real script.
    try {
      await node.executeJavaScript("(function(){return '__ping__';})()", true);
    } catch (pingErr) {
      console.error(`[AutoApply:${_label}] Context ping FAILED – aborting injection`, pingErr);
      return null;
    }

    // Wrap the script in eval() so that SyntaxErrors and pre-try/catch runtime
    // errors are caught and returned as a plain object instead of crashing the IPC channel.
    // JSON.stringify(script) safely escapes all newlines/quotes → valid JS string literal.
    const wrapperScript = `(function(){
  try {
    return eval(${JSON.stringify(script)});
  } catch(__e) {
    return {
      __AUTOAPPLY_SCRIPT_ERROR__: true,
      name: (__e && __e.constructor && __e.constructor.name) ? __e.constructor.name : "Error",
      message: __e ? String(__e.message || __e) : "unknown error",
      stack: __e && __e.stack ? String(__e.stack).slice(0, 600) : ""
    };
  }
})()`;

    try {
      const raw = await node.executeJavaScript(wrapperScript, true);
      if (raw && typeof raw === "object" && raw.__AUTOAPPLY_SCRIPT_ERROR__) {
        const errMsg = `[${_label}] ${raw.name}: ${raw.message}`;
        console.error(`[AutoApply] SCRIPT THREW:`, errMsg, "\n", raw.stack);
        setStatus(`❌ JS Error ${errMsg}`);
        return null;
      }
      return raw;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[AutoApply:${_label}] executeJavaScript wrapper FAILED (context destroyed?)`, message);
      if (!/context|destroyed|navigation|load/i.test(message)) {
        setStatus(`Webview IPC error [${_label}]: ${message}`);
      }
      return null;
    }
  };
  // ── LOCATE: find & click the Apply button ───────────────────────────────
  const locateForm = async (): Promise<{ clicked: boolean; fields: number; message: string } | null> => {
    const script = `
(function() {
${CSS_ESCAPE_POLYFILL}
try {
  var norm = function(v) { return String(v || "").toLowerCase().trim(); };
  var isVis = function(el, view) {
    try { var s = (view || window).getComputedStyle(el); var r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; } catch(e) { return false; }
  };
  var getDocs = function() {
    var docs = [document];
    var frames = Array.from(document.querySelectorAll("iframe"));
    for (var i = 0; i < frames.length; i++) { try { if (frames[i].contentDocument && frames[i].contentDocument.body) docs.push(frames[i].contentDocument); } catch(e) {} }
    return docs;
  };
  var docs = getDocs(); var fillable = 0;
  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    var inputs = Array.from(doc.querySelectorAll("input, textarea, select"));
    for (var ii = 0; ii < inputs.length; ii++) {
      var inp = inputs[ii];
      if (inp.disabled || inp.readOnly) continue;
      if (inp.tagName === "INPUT" && /hidden|submit|button|file|image|reset/.test(inp.type || "")) continue;
      if (isVis(inp, view)) fillable++;
    }
  }
  if (fillable >= 2) return { clicked: false, fields: fillable, message: "Form visible (" + fillable + " fields)" };
  var scoreBtn = function(text) {
    var t = norm(text); if (!t) return 0;
    if (t === "apply" || t === "apply now") return 100;
    if (t.includes("apply for this job") || t.includes("apply for job")) return 100;
    if (t.includes("start application")) return 95;
    if (t.includes("apply")) return 80;
    if (t.includes("continue application")) return 70;
    return 0;
  };
  var best = null; var bestScore = 0;
  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    var btns = Array.from(doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
    for (var bi = 0; bi < btns.length; bi++) {
      var btn = btns[bi]; if (!(btn instanceof HTMLElement)) continue;
      if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") continue;
      if (!isVis(btn, view)) continue;
      var text = String(btn.textContent || btn.getAttribute("value") || btn.getAttribute("aria-label") || "");
      var sc = scoreBtn(text); if (sc > bestScore) { best = btn; bestScore = sc; }
    }
  }
  if (!best) return { clicked: false, fields: fillable, message: "No Apply button found (" + fillable + " fields on page)" };
  best.scrollIntoView({ block: "center" });
  var labelStr = String(best.textContent || best.getAttribute("value") || "button").trim().slice(0, 50);
  setTimeout(function() { try { best.click(); } catch(e) {} }, 10);
  return { clicked: true, fields: fillable, message: "Clicked: " + labelStr };
} catch(err) { return { clicked: false, fields: 0, message: "Locate error: " + (err && err.message ? err.message : String(err)) }; }
})()`;
    return runInWebview(script, 15000, "locateForm") as Promise<{ clicked: boolean; fields: number; message: string } | null>;
  };
  // ── FILL: fill all visible form fields with profile data ────────────────
  const fillForm = async (): Promise<{ filled: number; unfilled: UnfilledField[]; message: string } | null> => {
    const p = profileRef.current;
    const ga = answersRef.current;
    const payload = {
      firstName: p.firstName ?? "", lastName: p.lastName ?? "", email: p.email ?? "",
      phone: p.phone ?? "", location: p.location ?? "",
      linkedIn: p.linkedIn ?? p.links?.linkedin ?? "",
      github: p.links?.github ?? "",
      portfolio: p.portfolio ?? p.links?.portfolio ?? "",
      whyCompany: p.whyCompany ?? ga.find((a) => a.prompt.toLowerCase().includes("why"))?.answer ?? "",
      yearsExperience: String(p.yearsExperience ?? ""),
      answers: ga.map((a) => ({ prompt: a.prompt, answer: a.answer })),
      savedAnswers: p.answers ?? {},
    };
    let b64Json: string;
    try {
      b64Json = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      console.log('[AutoApply:fillForm] Payload encoded OK. b64 length:', b64Json.length);
    } catch (encErr) {
      console.error('[AutoApply:fillForm] btoa encoding FAILED – profile data may contain invalid chars', encErr);
      return null;
    }

    const script = `
(function() {
${CSS_ESCAPE_POLYFILL}
try {
  var b64 = "${b64Json}";
  var data = JSON.parse(decodeURIComponent(escape(atob(b64))));
  var norm = function(v) { return String(v || "").toLowerCase().trim(); };
  var tr = function(v) { return String(v || "").trim(); };
  var savedAnswers = data.savedAnswers || {};

  var byPrompt = function(label) {
    var key = norm(label); if (!key || key.length < 6) return "";
    if (savedAnswers[label]) return tr(savedAnswers[label]);
    var lower = label.toLowerCase();
    var sk = Object.keys(savedAnswers);
    for (var i = 0; i < sk.length; i++) {
      if (norm(sk[i]).includes(lower) || lower.includes(norm(sk[i]))) return tr(savedAnswers[sk[i]]);
    }
    var keyWords = key.split(/\\s+/).filter(function(w) { return w.length > 3; });
    if (keyWords.length < 2) return "";
    for (var ai = 0; ai < (data.answers || []).length; ai++) {
      var item = data.answers[ai];
      var prompt = norm(item.prompt); if (!prompt || prompt.length < 6) continue;
      var pw = prompt.split(/\\s+/).filter(function(w) { return w.length > 3; });
      var overlap = 0;
      for (var wi = 0; wi < keyWords.length; wi++) { if (pw.indexOf(keyWords[wi]) >= 0) overlap++; }
      if (overlap >= 2) return tr(item.answer);
    }
    return "";
  };

  var fieldValue = function(label) {
    var key = norm(label); if (!key) return "";
    if (key.includes("first name") || key === "first") return tr(data.firstName);
    if (key.includes("last name") || key === "last" || key.includes("surname")) return tr(data.lastName);
    if (key.includes("full name") || key === "name") return tr((data.firstName + " " + data.lastName).trim());
    if (key.includes("email")) return tr(data.email);
    if (key.includes("phone") || key.includes("mobile") || key.includes("telephone")) return tr(data.phone);
    if (key.includes("linkedin")) return tr(data.linkedIn);
    if (key.includes("github")) return tr(data.github);
    if (key.includes("portfolio") || key.includes("personal website") || key.includes("website url")) return tr(data.portfolio || data.github || data.linkedIn);
    if ((key.includes("city") || key.includes("where are you based") || (/\\blocation\\b/.test(key) && !key.includes("relocation")) || (/\\baddress\\b/.test(key) && !key.includes("ip address"))) && !key.includes("hispanic") && !key.includes("ethnic") && !key.includes("race")) return tr(data.location);
    if (key.includes("years") && key.includes("experience")) return tr(data.yearsExperience || "3");
    if (key.includes("why") && (key.includes("company") || key.includes("us") || key.includes("interest"))) return tr(data.whyCompany || byPrompt(label));
    if (key.includes("cover letter") || key.includes("covering letter")) return tr(data.whyCompany || byPrompt(label));
    if ((key.includes("sponsor") || key.includes("visa")) && (key.includes("require") || key.includes("need") || key.includes("will you"))) return "No";
    if ((key.includes("authoriz") || key.includes("eligible") || key.includes("right to work") || key.includes("legally permitted")) && !key.includes("ethnic") && !key.includes("hispanic")) return "Yes";
    if (key.includes("open to relocation") || key.includes("willing to relocate") || key.includes("relocate for")) return "Yes";
    if (key.includes("open to working in-person") || key.includes("open to working in person") || key.includes("work on-site") || key.includes("work onsite") || key.includes("hybrid")) return "Yes";
    if (key.includes("interviewed") && key.includes("before")) return "No";
    if (key.includes("hispanic") || key.includes("latino") || key.includes("ethnic") || key.includes("race") || key.includes("gender") || key.includes("veteran") || key.includes("disabilit") || key.includes("lgbtq") || key.includes("pronounc")) return "";
    if (key.includes("how did you hear") || key.includes("referral") || key.includes("referred by")) return "";
    return byPrompt(label);
  };

  var getDocs = function() {
    var docs = [document];
    var frames = Array.from(document.querySelectorAll("iframe"));
    for (var i = 0; i < frames.length; i++) { try { if (frames[i].contentDocument && frames[i].contentDocument.body) docs.push(frames[i].contentDocument); } catch(e) {} }
    return docs;
  };
  var isVis = function(el, view) {
    try { var s = (view || window).getComputedStyle(el); var r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; } catch(e) { return false; }
  };
  var getLabel = function(el, doc) {
    try {
      var al = el.getAttribute("aria-label"); if (al) return tr(al);
      var id = el.id;
      if (id) {
        var lbl = doc.querySelector("label[for=" + JSON.stringify(id) + "]");
        if (lbl) { var c = lbl.cloneNode(true); c.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); var t = tr(c.textContent); if (t) return t; }
      }
      var wrapped = el.closest("label");
      if (wrapped) { var c2 = wrapped.cloneNode(true); c2.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); var t2 = tr(c2.textContent); if (t2) return t2; }
      var fs = el.closest("fieldset"); if (fs) { var leg = fs.querySelector("legend"); if (leg) return tr(leg.textContent); }
      return tr(el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "");
    } catch(e) { return ""; }
  };
  var buildSel = function(el, idx) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      var n = el.getAttribute("name"); if (n) return el.tagName.toLowerCase() + "[name=" + JSON.stringify(n) + "]";
      var td = el.getAttribute("data-testid"); if (td) return "[data-testid=" + JSON.stringify(td) + "]";
    } catch(e) {}
    return el.tagName.toLowerCase() + ":nth-of-type(" + (idx + 1) + ")";
  };
  var setVal = function(el, v) {
    try { var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); if (d && d.set) d.set.call(el, v); else el.value = v; } catch(e) { el.value = v; }
  };
  var fillField = function(el, value) {
    if (!el || !value) return false;
    try { el.focus(); setVal(el, String(value)); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); return true; } catch(e) { return false; }
  };
  var fillSel = function(el, value) {
    try {
      var opts = Array.from(el.options); var v = norm(value); var target = null;
      for (var i = 0; i < opts.length; i++) { var t = norm(opts[i].textContent); if (t === v || t.includes(v) || v.includes(t)) { target = opts[i]; break; } }
      if (!target) return false;
      setVal(el, target.value); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    } catch(e) { return false; }
  };
  var isCustom = function(el) {
    if (!el || el.tagName !== "INPUT") return false;
    try { if (el.closest("[role='combobox']")) return true; if (el.closest("[class*='__control']")) return true; if (el.closest("[class*='react-select__']")) return true; } catch(e) {}
    return false;
  };
  var isPhonePicker = function(el) {
    var ni = ((el.getAttribute("name") || "") + " " + (el.id || "")).toLowerCase();
    if (/country.?code|dial.?code|phone.?country|calling.?code/.test(ni)) return true;
    var ac = el.getAttribute("autocomplete") || ""; if (ac === "tel-country-code" || ac === "country-calling-code") return true;
    try { if (el.closest("[class*='flag-dropdown'],[class*='iti__flag'],[class*='PhoneInputCountry'],[class*='react-phone'],[class*='phone-input'],[class*='intl-tel']")) return true; } catch(e) {}
    if (el.tagName === "SELECT") { try { var optTexts = Array.from(el.options).slice(0, 8).map(function(o) { return (o.text || "").trim(); }); var ccCount = 0; for (var pi = 0; pi < optTexts.length; pi++) { if (/\\+\\d{1,4}$/.test(optTexts[pi]) || /^\\+\\d/.test(optTexts[pi])) ccCount++; } if (ccCount >= 3) return true; } catch(e) {} }
    return false;
  };
  var getCustomOpts = function(container, inputEl) {
    if (!container) return [];
    try {
      var ns = container.querySelector("select"); if (ns && ns.options.length > 0) { var optTexts = Array.from(ns.options).map(function(o) { return (o.textContent || o.value || "").trim(); }).filter(Boolean); var ccCount = 0; for (var pj = 0; pj < Math.min(optTexts.length, 8); pj++) { if (/\\+\\d{1,4}$/.test(optTexts[pj])) ccCount++; } if (ccCount < 3) return optTexts; return []; }
      var scopeEl = null;
      if (inputEl) { var ac = inputEl.getAttribute("aria-controls") || inputEl.getAttribute("aria-owns") || ""; if (ac) try { scopeEl = document.getElementById(ac); } catch(e) {} }
      var pr = Array.from((scopeEl || container).querySelectorAll("[role='option'],[class*='__option'],[class*='-option']")); var seen2 = {};
      return pr.map(function(o) { return (o.textContent || "").trim().replace(/\\s+/g, " "); }).filter(function(s) { return s.length >= 2 && s.length <= 120 && !seen2[s] && (seen2[s] = true); });
    } catch(e) { return []; }
  };

  var directMap = [
    { sel: "#first_name, input[name='first_name'], input[name='firstName'], input[id*='first_name'], input[autocomplete='given-name']", val: tr(data.firstName) },
    { sel: "#last_name, input[name='last_name'], input[name='lastName'], input[id*='last_name'], input[autocomplete='family-name']", val: tr(data.lastName) },
    { sel: "#email, input[type='email'], input[name='email'], input[autocomplete='email']", val: tr(data.email) },
    { sel: "#phone, input[type='tel'], input[name*='phone'], input[autocomplete='tel']", val: tr(data.phone) },
    { sel: "input[name*='linkedin'], #linkedin, input[id*='linkedin']", val: tr(data.linkedIn) },
    { sel: "input[name*='github'], #github, input[id*='github']", val: tr(data.github) },
    { sel: "#website, input[name*='website'], input[name*='portfolio'], input[id*='portfolio']", val: tr(data.portfolio || data.github || data.linkedIn) },
    { sel: "textarea[name*='cover'], textarea[id*='cover'], textarea[name*='letter']", val: tr(data.whyCompany) },
    { sel: "input[name='location'], #location, input[id='location'], input[id='city']", val: tr(data.location) },
  ];

  var filled = 0; var seen = {}; var unfilled = []; var docs = getDocs();

  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    for (var mi = 0; mi < directMap.length; mi++) {
      var item = directMap[mi]; if (!item.val) continue;
      try {
        var el = doc.querySelector(item.sel); if (!el) continue;
        if (!(el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) continue;
        if (!isVis(el, view)) continue; if (isCustom(el)) continue;
        var existing = tr(el.value || ""); if (existing && existing.length > 1) continue;
        var sel = buildSel(el, 0); if (seen[sel]) continue; seen[sel] = true;
        if (el.tagName === "SELECT") { if (fillSel(el, item.val)) filled++; } else { if (fillField(el, item.val)) filled++; }
      } catch(e) {}
    }
  }

  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    var candidates = Array.from(doc.querySelectorAll("input, textarea, select"));
    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci];
      try {
        if (el.tagName === "INPUT" && /hidden|file|checkbox|radio|submit|button|reset|image/.test(el.type || "")) continue;
        if (el.disabled || el.readOnly) continue; if (!isVis(el, view)) continue; if (isPhonePicker(el)) continue;
        var sel = buildSel(el, ci); if (seen[sel]) continue; seen[sel] = true;
        var label = getLabel(el, doc); var val = fieldValue(label);
        if (isCustom(el)) {
          var con = el.closest("[class*='__control'],[class*='SelectControl'],[role='combobox']") || el.parentElement;
          if (label && label.length >= 3) unfilled.push({ label: label, selector: sel, fieldType: "custom-select", options: getCustomOpts(con, el), autoValue: val || "" });
          continue;
        }
        if (!val) { if (label && label.length >= 3) { var ft = el.tagName === "SELECT" ? "select" : (el.tagName === "TEXTAREA" ? "textarea" : "text"); var fo = el.tagName === "SELECT" ? Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean) : []; unfilled.push({ label: label, selector: sel, fieldType: ft, options: fo }); } continue; }
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && tr(el.value || "") && tr(el.value || "").length > 1) continue;
        if (el.tagName === "SELECT") { if (fillSel(el, val)) filled++; else if (label && label.length >= 3) { var fo2 = Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean); unfilled.push({ label: label, selector: sel, fieldType: "select", options: fo2 }); } } else { if (fillField(el, val)) filled++; }
      } catch(e) {}
    }
  }

  // ── Extra pass: div/button-based comboboxes (Workday-style) not containing an <input> ──
  for (var di3 = 0; di3 < docs.length; di3++) {
    var doc3 = docs[di3]; var view3 = doc3.defaultView || window;
    var combos = Array.from(doc3.querySelectorAll("[role='combobox'],[aria-haspopup='listbox']"));
    for (var ki = 0; ki < combos.length; ki++) {
      var cel = combos[ki]; if (!cel) continue;
      try {
        var ctag = cel.tagName.toLowerCase();
        if (ctag === "input" || ctag === "select") continue;
        if (cel.querySelector("input, select")) continue;
        if (!isVis(cel, view3)) continue;
        var csel = buildSel(cel, 90000 + ki); if (seen[csel]) continue; seen[csel] = true;
        var clabel = tr(cel.getAttribute("aria-label") || ""); if (!clabel) { var cfor = cel.id ? doc3.querySelector("label[for=" + JSON.stringify(cel.id) + "]") : null; if (cfor) clabel = tr(cfor.textContent); } if (!clabel || clabel.length < 3) continue;
        var cval = fieldValue(clabel);
        var ctrlId = cel.getAttribute("aria-controls") || cel.getAttribute("aria-owns") || "";
        var copts = [];
        try { if (ctrlId) copts = Array.from(doc3.querySelectorAll("#" + CSS.escape(ctrlId) + " [role='option']")).map(function(o) { return (o.textContent || "").trim(); }).filter(Boolean); } catch(ce) {}
        if (!cval) { unfilled.push({ label: clabel, selector: csel, fieldType: "custom-select", options: copts, autoValue: "" }); }
        else { unfilled.push({ label: clabel, selector: csel, fieldType: "custom-select", options: copts, autoValue: cval }); }
      } catch(ce2) {}
    }
  }

  var seenL = {}; var deduped = unfilled.filter(function(f) { var k = f.label.toLowerCase().trim(); if (!k || seenL[k]) return false; seenL[k] = true; return true; });
  return { filled: filled, unfilled: deduped, message: "Filled " + filled + " field(s). " + deduped.length + " need your input." };
} catch(topErr) {
  return { filled: 0, unfilled: [], message: "Fill error: " + (topErr && topErr.message ? topErr.message : String(topErr)) };
}
})()`;
    console.log('[AutoApply:fillForm] About to call runInWebview with script length:', script.length);
    return runInWebview(script, 15000, "fillForm") as Promise<{ filled: number; unfilled: UnfilledField[]; message: string } | null>;
  };
  // ── ADVANCE: click Next or Submit ───────────────────────────────────────
  const advanceForm = async (): Promise<{ clicked: boolean; isSubmit: boolean; message: string } | null> => {
    const script = `
(function() {
try {
  var norm = function(v) { return String(v || "").toLowerCase().trim(); };
  var isVis = function(el, view) {
    try { var s = (view || window).getComputedStyle(el); var r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; } catch(e) { return false; }
  };
  var getDocs = function() {
    var docs = [document]; var frames = Array.from(document.querySelectorAll("iframe"));
    for (var i = 0; i < frames.length; i++) { try { if (frames[i].contentDocument && frames[i].contentDocument.body) docs.push(frames[i].contentDocument); } catch(e) {} }
    return docs;
  };
  var score = function(text) {
    var t = norm(text); if (!t) return 0;
    if (t.includes("submit application")) return 100; if (t.includes("submit")) return 90;
    if (t.includes("complete application") || t.includes("apply")) return 80;
    if (t.includes("save and continue") || t.includes("save & continue")) return 65;
    if (t.includes("next")) return 60; if (t.includes("continue")) return 50;
    return 0;
  };
  var best = null; var bestScore = 0; var docs = getDocs();
  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    var btns = Array.from(doc.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button']"));
    for (var bi = 0; bi < btns.length; bi++) {
      var btn = btns[bi]; if (!(btn instanceof HTMLElement)) continue;
      if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") continue;
      if (!isVis(btn, view)) continue;
      var text = String(btn.textContent || btn.getAttribute("value") || btn.getAttribute("aria-label") || "");
      var sc = score(text); if (sc > bestScore) { best = btn; bestScore = sc; }
    }
  }
  if (!best) return { clicked: false, isSubmit: false, message: "No Next/Submit button found" };
  var label = String(best.textContent || best.getAttribute("value") || "button").trim().slice(0, 50);
  var isSubmit = bestScore >= 80;
  best.scrollIntoView({ block: "center" }); 
  setTimeout(function() { try { best.click(); } catch(e){} }, 10);
  return { clicked: true, isSubmit: isSubmit, message: "Clicked: " + label };
} catch(err) { return { clicked: false, isSubmit: false, message: "Advance error: " + (err && err.message ? err.message : String(err)) }; }
})()`;
    return runInWebview(script, 15000, "advanceForm") as Promise<{ clicked: boolean; isSubmit: boolean; message: string } | null>;
  };

  const applyBasicFieldAnswer = async (selector: string, value: string): Promise<"done" | "custom" | "missing" | "skip"> => {
    const selB64 = btoa(unescape(encodeURIComponent(selector)));
    const valB64 = btoa(unescape(encodeURIComponent(value)));
    const script = `
(function() {
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var val = decodeURIComponent(escape(atob("${valB64}")));
  var el = document.querySelector(sel);
  if (!el) return { mode: "missing" };
  var norm = function(v) { return String(v || "").toLowerCase().trim(); };
  var setV = function(node, v) { try { var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value"); if (d && d.set) d.set.call(node, v); else node.value = v; } catch(e) { node.value = v; } };
  if (el.tagName === "SELECT") {
    var opts = Array.from(el.options);
    var lower = norm(val);
    for (var i = 0; i < opts.length; i++) {
      var t = norm(opts[i].textContent || "");
      if (t === lower || t.includes(lower) || lower.includes(t)) {
        setV(el, opts[i].value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { mode: "done" };
      }
    }
    return { mode: "skip" };
  }
  var isCombo = false;
  try { isCombo = !!(el.closest("[role='combobox']") || el.closest("[class*='__control']") || el.closest("[class*='react-select__']")); } catch(e) {}
  if (isCombo || el.tagName === "DIV" || el.tagName === "BUTTON") return { mode: "custom" };
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.focus();
    setV(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setV(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return { mode: "done" };
  }
  return { mode: "skip" };
} catch(e) {
  return { mode: "missing" };
}
})()`;
    const result = await runInWebview(script, 5000, "applyBasicField");
    return result?.mode ?? "missing";
  };

  const openCustomDropdownInWebview = async (selector: string): Promise<string | null> => {
    const token = `autoapply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeSel = JSON.stringify(selector);
    const safeToken = JSON.stringify(token);
    const safeAttr = JSON.stringify(WEBVIEW_SNAPSHOT_ATTR);
    // Correct order: 1) close any open dropdown, 2) snapshot current options, 3) open ours
    const script = `
(function() {
try {
  var ATTR = ${safeAttr};
  // Step 1: close anything currently open
  try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); } catch(e) {}
  try { document.body.click(); } catch(e) {}

  var el = document.querySelector(${safeSel});
  if (!el) return { opened: false };

  // Step 2: snapshot ALL current option-like nodes so we can detect newly rendered ones
  try { document.querySelectorAll("[" + ATTR + "]").forEach(function(n) { n.removeAttribute(ATTR); }); } catch(e) {}
  var SNAP_SELS = [
    "[role='option']", "[role='menuitem']", "[role='listitem']",
    "[class*='__option']", "[class*='-option']", "[class*='Option']",
    "[class*='item']", "li", "[data-value]"
  ];
  for (var si = 0; si < SNAP_SELS.length; si++) {
    try { document.querySelectorAll(SNAP_SELS[si]).forEach(function(n) { if (!n.getAttribute(ATTR)) n.setAttribute(ATTR, ${safeToken}); }); } catch(e) {}
  }

  // Step 3: find the trigger element and open with full mouse event sequence
  var con = el.closest("[role='combobox']") || el.closest("[aria-haspopup='listbox']") || el.closest("[class*='__control']") || el.closest("[class*='SelectControl']") || el.parentElement || el;
  var trigger = con || el;
  var fire = function(t) {
    try { t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch(e) {}
    try { t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch(e) {}
    try { t.click(); } catch(e) {}
  };
  fire(trigger);
  if (trigger !== el) fire(el);
  try { if (el.tagName === "INPUT" || el.tagName === "BUTTON") el.focus(); } catch(e) {}
  return { opened: true };
} catch(e) {
  return { opened: false, err: String(e.message || e) };
}
})()`;
    const result = await runInWebview(script, 5000, "openDropdown");
    return result?.opened ? token : null;
  };

  const readCustomDropdownOptionsInWebview = async (selector: string, token: string): Promise<string[]> => {
    const safeSel = JSON.stringify(selector);
    const safeToken = JSON.stringify(token);
    const safeOptSel = JSON.stringify(WEBVIEW_OPTION_SELECTOR);
    const safeAttr = JSON.stringify(WEBVIEW_SNAPSHOT_ATTR);
    const script = `
(function() {
try {
  var OPT_SEL = ${safeOptSel};
  var ATTR = ${safeAttr};
  var el = document.querySelector(${safeSel});
  if (!el) return [];
  var seen = {};
  var all = Array.from(document.querySelectorAll(OPT_SEL));
  var fresh = all.filter(function(node) { return node.getAttribute(ATTR) !== ${safeToken}; });
  var source = fresh.length > 0 ? fresh : all;
  return source
    .map(function(node) { return (node.textContent || "").trim().replace(/\\s+/g, " "); })
    .filter(function(text) { return text.length >= 2 && text.length <= 120 && !seen[text] && (seen[text] = true); });
} catch(e) {
  return [];
}
})()`;
    const result = await runInWebview(script, 5000, "readDropdownOptions");
    return Array.isArray(result) ? (result as string[]) : [];
  };

  const selectCustomDropdownOptionInWebview = async (selector: string, token: string, value: string): Promise<boolean> => {
    const safeSel = JSON.stringify(selector);
    const safeToken = JSON.stringify(token);
    const valB64 = btoa(unescape(encodeURIComponent(value)));
    const safeAttr = JSON.stringify(WEBVIEW_SNAPSHOT_ATTR);
    const script = `
(function() {
try {
  var ATTR = ${safeAttr};
  var val = decodeURIComponent(escape(atob("${valB64}")));
  var lower = String(val || "").toLowerCase().trim();

  var normT = function(t) { return String(t || "").toLowerCase().trim().replace(/\\s+/g, " "); };
  var scoreNode = function(node) {
    var t = normT(node.textContent || "");
    if (!t || t.length > 120) return 0;
    if (t === lower) return 100;
    if (t.startsWith(lower) || lower.startsWith(t)) return 80;
    if (t.includes(lower) || lower.includes(t)) return (t.length <= 40 ? 60 : 30);
    return 0;
  };

  // Collect all candidate option nodes using many selectors
  var OPTION_SELS = [
    "[role='option']",
    "[role='menuitem']",
    "[role='listitem']",
    "[class*='__option']",
    "[class*='-option']",
    "[class*='Option']",
    "[class*='dropdown'] li",
    "[class*='Dropdown'] li",
    "[class*='menu'] li",
    "[class*='Menu'] li",
    "[class*='listbox'] li",
    "[class*='Listbox'] li",
    "[class*='select'] li",
    "[class*='Select'] li",
    "ul[role='listbox'] > *",
    "[data-value]",
    "li"
  ];
  var seen = {};
  var fresh = []; var stale = [];
  for (var si = 0; si < OPTION_SELS.length; si++) {
    try {
      var nodes = document.querySelectorAll(OPTION_SELS[si]);
      for (var ni = 0; ni < nodes.length; ni++) {
        var n = nodes[ni];
        var uid = n.tagName + "__" + (n.className || "") + "__" + (n.textContent || "").trim().slice(0, 30);
        if (seen[uid]) continue; seen[uid] = true;
        if (n.getAttribute(ATTR) === ${safeToken}) { stale.push(n); } else { fresh.push(n); }
      }
    } catch(e) {}
  }

  // Prefer fresh (newly appeared) nodes; fall back to all if none found
  var candidates = fresh.length > 0 ? fresh : fresh.concat(stale);

  var best = null; var bestScore = 0;
  for (var i = 0; i < candidates.length; i++) {
    var sc = scoreNode(candidates[i]);
    if (sc > bestScore) { bestScore = sc; best = candidates[i]; }
  }

  if (!best || bestScore < 60) {
    return { clicked: false, tried: candidates.length, bestScore: bestScore };
  }
  best.scrollIntoView({ block: "nearest" });
  try { best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch(e) {}
  try { best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch(e) {}
  try { best.click(); } catch(e) {}
  return { clicked: true, text: String(best.textContent || "").trim().slice(0, 60) };
} catch(e) {
  return { clicked: false, err: String(e.message || e) };
}
})()`;
    const result = await runInWebview(script, 5000, "selectDropdownOption");
    if (result && !result.clicked) {
      console.warn(`[AutoApply:selectDropdownOption] No match – tried ${result.tried} nodes, bestScore=${result.bestScore}, value="${value}"`);
      setStatus(`⚠️ Dropdown: no option matched "${value}" (${result.tried} options found)`);
    }
    return Boolean(result?.clicked);
  };

  const closeCustomDropdownInWebview = async (selector: string, token: string): Promise<void> => {
    const safeSel = JSON.stringify(selector);
    const safeToken = JSON.stringify(token);
    const safeAttr = JSON.stringify(WEBVIEW_SNAPSHOT_ATTR);
    const script = `
(function() {
try {
  var ATTR = ${safeAttr};
  var el = document.querySelector(${safeSel});
  if (el) {
    try { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); } catch(e) {}
    try { if (typeof el.blur === "function") el.blur(); } catch(e) {}
  }
  try { document.body.click(); } catch(e) {}
  try {
    document.querySelectorAll("[" + ATTR + "]").forEach(function(node) {
      if (node.getAttribute(ATTR) === ${safeToken}) node.removeAttribute(ATTR);
    });
  } catch(e) {}
  return true;
} catch(e) {
  return false;
}
})()`;
    await runInWebview(script, 5000, "closeDropdown");
  };

  // ── APPLY USER ANSWERS: inject manually-provided answers back to form ────
  const applyUserAnswersToForm = async (answers: Record<string, string>): Promise<void> => {
    if (Object.keys(answers).length === 0) return;
    for (const [selector, rawValue] of Object.entries(answers)) {
      const value = rawValue.trim();
      if (!value) continue;

      const mode = await applyBasicFieldAnswer(selector, value);
      if (mode === "done" || mode === "missing" || mode === "skip") {
        await sleep(120);
        continue;
      }

      const token = await openCustomDropdownInWebview(selector);
      if (!token) continue;

      await sleep(700);
      const matched = await selectCustomDropdownOptionInWebview(selector, token, value);
      if (!matched) await applyBasicFieldAnswer(selector, value);
      await closeCustomDropdownInWebview(selector, token);
      await sleep(180);
    }
  };

  // ── FETCH OPTIONS FOR CLOSED CUSTOM DROPDOWNS ────────────────────────────
  // Opens the dropdown, waits for JS frameworks to render options, reads them, closes.
  const fetchDropdownOptions = async (selector: string): Promise<string[]> => {
    const safeSel = JSON.stringify(selector);
    const inspectScript = `
(function() {
try {
  var el = document.querySelector(${safeSel});
  if (!el) return { kind: "missing", options: [] };
  if (el.tagName === "SELECT") {
    var opts = Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean);
    var ccCount = 0;
    for (var i = 0; i < Math.min(opts.length, 8); i++) { if (/\\+\\d{1,4}$/.test(opts[i]) || /^\\+\\d/.test(opts[i])) ccCount++; }
    return { kind: "select", options: ccCount >= 3 ? [] : opts };
  }
  var isCombo = false;
  try { isCombo = !!(el.closest("[role='combobox']") || el.closest("[class*='__control']") || el.closest("[class*='react-select__']")); } catch(e) {}
  if (isCombo || el.tagName === "DIV" || el.tagName === "BUTTON") return { kind: "custom", options: [] };
  return { kind: "other", options: [] };
} catch(e) {
  return { kind: "missing", options: [] };
}
})()`;
    const inspected = await runInWebview(inspectScript, 5000, "inspectDropdown");
    if (inspected?.kind === "select") return Array.isArray(inspected.options) ? inspected.options : [];
    if (inspected?.kind !== "custom") return [];

    const token = await openCustomDropdownInWebview(selector);
    if (!token) return [];

    await sleep(700);
    const options = await readCustomDropdownOptionsInWebview(selector, token);
    await closeCustomDropdownInWebview(selector, token);
    await sleep(180);
    return options;
  };

  // Enriches unfilled fields that are custom-selects with no options by opening their dropdowns.
  const enrichUnfilledWithOptions = async (fields: UnfilledField[]): Promise<UnfilledField[]> => {
    const enriched = [...fields];
    for (let i = 0; i < enriched.length; i++) {
      const f = enriched[i];
      if ((f.fieldType === "custom-select" || f.fieldType === "select") && f.options.length === 0) {
        await sleep(300);
        const opts = await fetchDropdownOptions(f.selector);
        if (opts.length > 0) enriched[i] = { ...f, options: opts };
      }
    }
    return enriched;
  };

  // ── AUTO-MODE LOOP ────────────────────────────────────────────────────────
  const runAutoModeSequence = async () => {
    if (!autoModeEnabledRef.current) return;
    if (loopTokenRef.current !== 0) return; // already running

    const token = Date.now();
    loopTokenRef.current = token;
    setAutoModeRunning(true);
    setStatus("Auto mode running...");

    let totalFilled = 0;
    try {
      for (let step = 0; step < 12; step++) {
        if (loopTokenRef.current !== token) break;

        setStatus("Looking for application form...");
        const locate = await locateForm();

        if (loopTokenRef.current !== token) break;
        if (locate === null) break; // navigation race — restart already queued by nav handler

        setStatus(locate.message);

        // If we clicked Apply, navigation will fire and onNavigate queues the restart.
        if (locate.clicked) break;

        await sleep(500);
        if (loopTokenRef.current !== token) break;

        setStatus("Filling fields...");
        const fill = await fillForm();

        if (loopTokenRef.current !== token) break;
        if (fill === null) break; // navigation race

        setStatus(fill.message);
        totalFilled += fill.filled;

        if (fill.unfilled.length > 0) {
          const enriched = await enrichUnfilledWithOptions(fill.unfilled);

          // Auto-apply custom dropdown fields where we already know the answer
          const autoApply: Record<string, string> = {};
          for (const f of enriched) {
            if ((f.fieldType === "custom-select") && f.autoValue) {
              autoApply[f.selector] = f.autoValue;
            }
          }
          if (Object.keys(autoApply).length > 0) {
            setStatus("Applying dropdown answers...");
            await applyUserAnswersToForm(autoApply);
            await sleep(400);
            totalFilled += Object.keys(autoApply).length;
          }

          // Show remaining unfilled (no autoValue or autoApply failed)
          const stillUnfilled = enriched.filter(f => !f.autoValue || f.fieldType !== "custom-select");
          setUnfilledFields(stillUnfilled);
          const pre: Record<string, string> = {};
          for (const f of stillUnfilled) {
            const saved = profileRef.current.answers?.[f.label];
            if (saved) pre[f.selector] = saved;
          }
          if (Object.keys(pre).length > 0) setUserAnswers((prev) => ({ ...prev, ...pre }));
          if (fill.filled === 0 && Object.keys(autoApply).length === 0) {
            setStatus(`${stillUnfilled.length} field(s) need your input — answer below and click "Apply & Save".`);
            break;
          }
        }

        await sleep(500);
        if (loopTokenRef.current !== token) break;

        const advance = await advanceForm();
        if (loopTokenRef.current !== token) break;
        if (advance === null) break;

        setStatus(advance.message);

        if (advance.isSubmit) {
          if (totalFilled === 0) { setStatus("Safety stop: not submitting — no fields were filled."); }
          else { setStatus("Application submitted!"); }
          break;
        }

        if (!advance.clicked && fill.filled === 0) { setStatus("No progress — auto mode stopped."); break; }

        await sleep(700);
      }
    } finally {
      if (loopTokenRef.current === token || loopTokenRef.current === 0) {
        loopTokenRef.current = 0;
        setAutoModeRunning(false);
      }
    }
  };

  // Keep ref in sync so nav-event closures always invoke the latest version.
  runAutoRef.current = runAutoModeSequence;

  const stopAutoMode = () => {
    loopTokenRef.current = 0;
    if (restartTimerRef.current !== null) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    setAutoModeRunning(false);
    setStatus("Auto mode stopped.");
  };

  const loadAddress = () => {
    const candidate = address.trim(); if (!candidate) return;
    const next = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    setCurrentSrc(next);
  };

  const handleSaveAndApply = async () => {
    const toApply: Record<string, string> = {}; const labelMap: Record<string, string> = {};
    for (const field of unfilledFields) {
      const v = userAnswers[field.selector]; if (!v?.trim()) continue;
      toApply[field.selector] = v.trim(); labelMap[field.label] = v.trim();
    }
    if (Object.keys(toApply).length === 0) return;
    setSavingAnswers(true);
    try {
      await applyUserAnswersToForm(toApply);
      const updated: UserProfile = { ...profileRef.current, answers: { ...(profileRef.current.answers ?? {}), ...labelMap } };
      saveProfile(updated);
      await putProfile(updated).catch(() => {});
      onProfileUpdate?.(updated);
      setUnfilledFields((prev) => prev.filter((f) => !toApply[f.selector]));
      setStatus(`Applied ${Object.keys(toApply).length} answer(s) and saved to profile.`);
    } finally { setSavingAnswers(false); }
  };
  // ── JSX ──────────────────────────────────────────────────────────────────
  const WebviewTag = "webview" as any;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">In-App Browser Automation</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white">
          {/* Window chrome dots */}
          <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-rose-400/80" />
            <span className="h-2 w-2 rounded-full bg-amber-400/80" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
            <p className="ml-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">Browser Session</p>
          </div>

          {/* URL bar */}
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.goBack?.()}>Back</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.goForward?.()}>Fwd</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => webviewRef.current?.reload?.()}>Reload</Button>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); loadAddress(); } }}
              placeholder="https://job-boards.greenhouse.io/..."
              className="h-8 flex-1 rounded border border-slate-300 px-2 text-xs text-slate-700 outline-none focus:border-slate-500"
            />
            <Button type="button" size="sm" variant="default" onClick={loadAddress}>Go</Button>
            <Button
              type="button" size="sm"
              variant={autoModeEnabled ? "default" : "ghost"}
              onClick={() => { if (autoModeEnabled) stopAutoMode(); setAutoModeEnabled((v) => !v); }}
            >
              Auto {autoModeEnabled ? "ON" : "OFF"}
            </Button>
            {autoModeRunning && (
              <Button type="button" size="sm" variant="danger" onClick={stopAutoMode}>Stop</Button>
            )}
          </div>

          {/* Status bar */}
          <div className="border-b border-slate-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {autoModeRunning && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle" />}
            {status}
          </div>

          {/* Webview */}
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

          {/* Manual controls */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => void locateForm().then((r) => r && setStatus(r.message))}>Find Form</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void fillForm().then((r) => r && setStatus(r.message))}>Fill Fields</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void advanceForm().then((r) => r && setStatus(r.message))}>Next / Submit</Button>
            <Button
              type="button" size="sm" variant="default"
              onClick={async () => {
                setAutoModeRunning(true);
                const loc = await locateForm(); if (loc) setStatus(loc.message);
                await sleep(600);
                const fill = await fillForm(); if (fill) setStatus(fill.message);
                await sleep(400);
                const adv = await advanceForm(); if (adv) setStatus(adv.message);
                setAutoModeRunning(false);
              }}
            >Run All Steps</Button>
          </div>
        </div>

        {/* Unfilled fields panel */}
        {unfilledFields.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-[11px] font-bold text-amber-700">{unfilledFields.length}</span>
                <p className="text-sm font-semibold text-slate-800">
                  {unfilledFields.length === 1 ? "1 field needs your input" : `${unfilledFields.length} fields need your input`}
                </p>
              </div>
              <button type="button" onClick={() => setUnfilledFields([])} className="rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-600" aria-label="Dismiss">✕</button>
            </div>

            <p className="px-4 pt-3 text-xs text-slate-500">Pick the right option — it will be selected in the form automatically and saved for future applications.</p>

            <div className="divide-y divide-slate-100 px-4 pb-2 pt-1">
              {unfilledFields.map((field) => (
                <div key={field.selector} className="py-3">
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{field.label}</label>
                  {(field.fieldType === "select" || field.fieldType === "custom-select") && field.options.length > 0 ? (
                    <select
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      value={userAnswers[field.selector] ?? ""}
                      onChange={(e) => setUserAnswers((prev) => ({ ...prev, [field.selector]: e.target.value }))}
                    >
                      <option value="">— Choose an option —</option>
                      {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : field.fieldType === "textarea" ? (
                    <textarea
                      rows={3}
                      className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      placeholder="Enter your answer..."
                      value={userAnswers[field.selector] ?? ""}
                      onChange={(e) => setUserAnswers((prev) => ({ ...prev, [field.selector]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      placeholder={field.fieldType === "custom-select" ? "Type the option to select..." : "Enter your answer..."}
                      value={userAnswers[field.selector] ?? ""}
                      onChange={(e) => setUserAnswers((prev) => ({ ...prev, [field.selector]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs text-slate-400">Unanswered fields will be skipped.</p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setUnfilledFields([])}>Skip All</Button>
                <Button
                  type="button" size="sm" variant="default"
                  onClick={() => void handleSaveAndApply()}
                  disabled={savingAnswers || Object.values(userAnswers).every((v) => !v?.trim())}
                >
                  {savingAnswers ? "Applying..." : "Apply & Save"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}