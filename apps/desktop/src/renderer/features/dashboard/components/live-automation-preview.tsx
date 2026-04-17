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

// Broad selector for dropdown options — covers React Select, Workday, Lever, Ashby, Greenhouse and raw li-based menus.
// Token filtering (WEBVIEW_SNAPSHOT_ATTR) is the primary isolation mechanism; this selector intentionally casts wide.
const WEBVIEW_OPTION_SELECTOR = "[role='option'],[role='menuitem'],[role='listitem'],[class*='__option'],[class*='-option'],[class*='Option'],[class*='dropdown-item'],[class*='menu-item'],[data-value],li";
const WEBVIEW_SNAPSHOT_ATTR = "data-autoapply-before";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

type ExtractedField = {
  selector: string;
  label: string;
  fieldType: "text" | "textarea" | "select" | "custom-select";
  options: string[];
  suggestedValue: string;
  existingValue: string;
};

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

  // ── EXTRACT: scan all form fields and return metadata (NO filling) ──────
  const extractFormFields = async (): Promise<ExtractedField[] | null> => {
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
    } catch (encErr) {
      console.error('[AutoApply:extractFields] encoding FAILED', encErr);
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
  var cleanLabel = function(raw) {
    if (!raw) return "";
    return String(raw).replace(/[*\u2022]+/g, "").replace(/(\\s*(required|optional|mandatory)\\s*)/gi, " ").replace(/\\s+/g, " ").replace(/\\n+/g, " ").trim();
  };
  var getBestLabel = function(el, doc) {
    try {
      var SKIP_TEXT = /^(select\\b|choose\\b|pick\\b|none\\b|-{2,}|_{2,}|enter\\b.*answer|your answer|type here)/i;
      var al = el.getAttribute("aria-label"); if (al) { var alC = cleanLabel(al); if (alC.length > 2 && !/^(select|choose|pick|none)\\b/i.test(alC)) return alC; }
      var labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        var ids = labelledBy.trim().split(/\\s+/); var parts = [];
        for (var li = 0; li < ids.length; li++) { try { var ref = doc.getElementById(ids[li]); if (ref) { var rt = (ref.innerText || ref.textContent || "").trim(); if (rt) parts.push(rt); } } catch(e2) {} }
        if (parts.length > 0) { var joined = cleanLabel(parts.join(" ")); if (joined.length > 2 && !SKIP_TEXT.test(joined)) return joined; }
      }
      var eid = el.id;
      if (eid) { var lbl = doc.querySelector("label[for=" + JSON.stringify(eid) + "]"); if (lbl) { var c = lbl.cloneNode(true); try { c.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); } catch(e3) {} var t = cleanLabel(c.textContent); if (t.length > 2) return t; } }
      var wrapped = el.closest("label");
      if (wrapped) { var c2 = wrapped.cloneNode(true); try { c2.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); } catch(e4) {} var t2 = cleanLabel(c2.textContent); if (t2.length > 2) return t2; }
      var fs = el.closest("fieldset"); if (fs) { var leg = fs.querySelector("legend"); if (leg) { var lt = cleanLabel(leg.textContent); if (lt.length > 2) return lt; } }
      var pathEl = el;
      for (var dd = 0; dd < 6; dd++) {
        var par2 = pathEl.parentElement; if (!par2) break;
        var sibs2 = []; var cnodes = Array.from(par2.childNodes);
        for (var cj = 0; cj < cnodes.length; cj++) {
          var cn = cnodes[cj];
          if (cn === pathEl || (cn.nodeType === 1 && typeof cn.contains === "function" && cn.contains(pathEl))) continue;
          var ctg2 = cn.nodeType === 1 ? ((cn.tagName || "").toLowerCase()) : "";
          if (ctg2 && /^(script|style|input|select|textarea|button)$/.test(ctg2)) continue;
          var ctt = ((cn.innerText || cn.textContent) || "").trim();
          if (ctt && ctt.length >= 2 && ctt.length <= 200) sibs2.push(ctt);
        }
        var combined2 = cleanLabel(sibs2.join(" "));
        if (combined2.length > 3 && combined2.length < 200 && !SKIP_TEXT.test(combined2)) return combined2;
        pathEl = par2;
      }
      var ph = el.getAttribute("placeholder"); var phClean = ph ? cleanLabel(ph) : "";
      if (phClean.length > 2 && !/^(select|choose|pick|none)\\b/i.test(phClean) && !/^-{2,}/.test(phClean) && !/^_{2,}/.test(phClean)) return phClean;
      var nm = el.getAttribute("name"); if (nm && cleanLabel(nm).length > 2) return cleanLabel(nm).replace(/[_\\-]/g, " ");
      return "";
    } catch(e) { return ""; }
  };
  var getUniqueSelector = function(el) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      var n = el.getAttribute("name"); if (n) return el.tagName.toLowerCase() + "[name=" + JSON.stringify(n) + "]";
      var td = el.getAttribute("data-testid"); if (td) return "[data-testid=" + JSON.stringify(td) + "]";
      var path = []; var cur = el;
      while (cur && cur.nodeType === 1 && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
        var seg = cur.nodeName.toLowerCase();
        if (cur.id) { path.unshift("#" + CSS.escape(cur.id)); break; }
        var rawCls = typeof cur.className === "string" ? cur.className.trim().split(/\\s+/).filter(function(c) { return c && /^[a-zA-Z_\\-][a-zA-Z0-9_\\-]*$/.test(c); }).slice(0, 2) : [];
        if (rawCls.length > 0) seg += "." + rawCls.join(".");
        var parent = cur.parentNode;
        if (parent && parent.children) { var sibs = Array.from(parent.children).filter(function(e) { return e.nodeName === cur.nodeName; }); if (sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")"; }
        path.unshift(seg);
        cur = cur.parentNode;
        if (path.length >= 8) break;
      }
      return path.length > 0 ? path.join(" > ") : el.tagName.toLowerCase();
    } catch(e) { return el.tagName ? el.tagName.toLowerCase() : "unknown"; }
  };
  var isCustom = function(el) {
    if (!el || el.tagName !== "INPUT") return false;
    try { if (el.closest("[role='combobox']")) return true; if (el.closest("[class*='__control']")) return true; if (el.closest("[class*='react-select__']")) return true; } catch(e) {}
    return false;
  };
  var isPhonePicker = function(el) {
    var ni = ((el.getAttribute("name") || "") + " " + (el.id || "")).toLowerCase();
    if (/country.?code|dial.?code|phone.?country|calling.?code/.test(ni)) return true;
    var ac = el.getAttribute("autocomplete") || "";
    if (ac === "tel-country-code" || ac === "country-calling-code") return true;
    // Protect the actual phone NUMBER input: tel-type means it is the number field, not the country picker
    if (el.tagName === "INPUT" && (el.type === "tel" || ac === "tel" || ac === "tel-national" || ac === "tel-local")) return false;
    try { if (el.closest("[class*='flag-dropdown'],[class*='iti__flag'],[class*='PhoneInputCountry'],[class*='react-phone'],[class*='phone-input'],[class*='intl-tel']")) return true; } catch(e) {}
    if (el.tagName === "SELECT") { try { var optTexts = Array.from(el.options).slice(0, 8).map(function(o) { return (o.text || "").trim(); }); var ccCount = 0; for (var pi = 0; pi < optTexts.length; pi++) { if (/\\+\\d{1,4}$/.test(optTexts[pi]) || /^\\+\\d/.test(optTexts[pi])) ccCount++; } if (ccCount >= 3) return true; } catch(e) {} }
    return false;
  };

  var fields = []; var seen = {}; var docs = getDocs();
  for (var di = 0; di < docs.length; di++) {
    var doc = docs[di]; var view = doc.defaultView || window;
    var candidates = Array.from(doc.querySelectorAll("input, textarea, select"));
    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci];
      try {
        if (el.tagName === "INPUT" && /hidden|file|checkbox|radio|submit|button|reset|image/.test(el.type || "")) continue;
        if (el.disabled || el.readOnly) continue;
        if (!isVis(el, view)) continue;
        if (isPhonePicker(el)) continue;
        var sel = getUniqueSelector(el);
        if (seen[sel]) continue; seen[sel] = true;
        var rawLabel = getBestLabel(el, doc);
        var label = cleanLabel(rawLabel);
        var val = fieldValue(label);
        var existing = tr(el.value || "");
        if (isCustom(el)) {
          var clbl = (label && label.length >= 3) ? label : ("Dropdown " + (fields.length + 1));
          fields.push({ selector: sel, label: clbl, fieldType: "custom-select", options: [], suggestedValue: fieldValue(clbl) || "", existingValue: existing });
          continue;
        }
        var ft = el.tagName === "SELECT" ? "select" : (el.tagName === "TEXTAREA" ? "textarea" : "text");
        var opts = el.tagName === "SELECT" ? Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean) : [];
        var effectiveLbl = (label && label.length >= 3) ? label : ("Field " + (fields.length + 1));
        fields.push({ selector: sel, label: effectiveLbl, fieldType: ft, options: opts, suggestedValue: val || "", existingValue: existing });
      } catch(e) {}
    }
    // Extra: div/button comboboxes without an inner <input>
    var combos = Array.from(doc.querySelectorAll("[role='combobox'],[aria-haspopup='listbox']"));
    for (var ki = 0; ki < combos.length; ki++) {
      var cel = combos[ki]; if (!cel) continue;
      try {
        var ctag = cel.tagName.toLowerCase();
        if (ctag === "input" || ctag === "select") continue;
        if (cel.querySelector("input:not([type='hidden']), select")) continue;
        if (!isVis(cel, view)) continue;
        var csel = getUniqueSelector(cel);
        if (seen[csel]) continue; seen[csel] = true;
        var clabel = cleanLabel(getBestLabel(cel, doc));
        if (!clabel || clabel.length < 3) clabel = "Dropdown " + (fields.length + 1);
        fields.push({ selector: csel, label: clabel, fieldType: "custom-select", options: [], suggestedValue: fieldValue(clabel) || "", existingValue: "" });
      } catch(e) {}
    }
  }
  var seenSel = {};
  return fields.filter(function(f) { if (!f.selector || seenSel[f.selector]) return false; seenSel[f.selector] = true; return true; });
} catch(topErr) { return []; }
})()`;

    const result = await runInWebview(script, 15000, "extractFields");
    return Array.isArray(result) ? result as ExtractedField[] : null;
  };

  // ── HUMAN-LIKE INTERACTION HELPERS ──────────────────────────────────────

  // Returns viewport-center coordinates of an element for trusted input events.
  const getElementCenter = async (selector: string, findContainer = false): Promise<{ x: number; y: number } | null> => {
    const selB64 = btoa(unescape(encodeURIComponent(selector)));
    const findContainerJs = findContainer ? "true" : "false";
    const script = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (!el) return null;
  var target = el;
  if (${findContainerJs}) {
    target = el.closest("[role='combobox']") || el.closest("[aria-haspopup='listbox']") || el.closest("[class*='__control']") || el.closest("[class*='SelectControl']") || el.parentElement || el;
  }
  target.scrollIntoView({ behavior: 'instant', block: 'center' });
  var r = target.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
} catch(e) { return null; }
})()`;
    return await runInWebview(script, 5000, "getCenter");
  };

  // Sends a REAL trusted OS-level click via Electron webview.sendInputEvent().
  // isTrusted=true — bypasses the check that blocks JS-dispatched events on modern ATS.
  const realClickAt = async (x: number, y: number): Promise<boolean> => {
    const node = webviewRef.current;
    if (!node || typeof node.sendInputEvent !== "function") return false;
    try {
      node.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1, modifiers: [] });
      await sleep(randomBetween(40, 80));
      node.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1, modifiers: [] });
      return true;
    } catch (e) {
      console.warn("[AutoApply:realClick] sendInputEvent failed:", e);
      return false;
    }
  };

  const humanScrollToField = async (selector: string): Promise<boolean> => {
    const selB64 = btoa(unescape(encodeURIComponent(selector)));
    const script = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
} catch(e) { return false; }
})()`;
    return (await runInWebview(script, 5000, "humanScroll")) === true;
  };

  // Highlights the combobox CONTAINER (not the inner input) so custom dropdowns are visibly outlined.
  const humanHighlightField = async (selector: string, on: boolean): Promise<void> => {
    const selB64 = btoa(unescape(encodeURIComponent(selector)));
    const script = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (!el) return false;
  var target = el.closest("[role='combobox']") || el.closest("[class*='__control']") || el.closest("[class*='SelectControl']") || el;
  target.style.outline = ${on ? "'2px solid #3b82f6'" : "''"};
  target.style.outlineOffset = ${on ? "'2px'" : "''"};
  return true;
} catch(e) { return false; }
})()`;
    await runInWebview(script, 3000, "humanHighlight");
  };

  const humanTypeInField = async (selector: string, value: string): Promise<boolean> => {
    const selB64 = btoa(unescape(encodeURIComponent(selector)));

    // Step 1: Focus, click, and clear existing value
    const clearScript = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (!el) return false;
  el.focus();
  el.click();
  try { var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); if (d && d.set) d.set.call(el, ''); else el.value = ''; } catch(e) { el.value = ''; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
} catch(e) { return false; }
})()`;
    const cleared = await runInWebview(clearScript, 5000, "humanClear");
    if (!cleared) return false;

    await sleep(randomBetween(200, 500)); // thinking pause

    // Step 2: Type each character one by one
    let burstCounter = randomBetween(5, 12);
    for (let i = 0; i < value.length; i++) {
      const textSoFar = value.substring(0, i + 1);
      const textB64 = btoa(unescape(encodeURIComponent(textSoFar)));

      const charScript = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (!el) return false;
  var text = decodeURIComponent(escape(atob("${textB64}")));
  try { var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); if (d && d.set) d.set.call(el, text); else el.value = text; } catch(e) { el.value = text; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
} catch(e) { return false; }
})()`;
      const typed = await runInWebview(charScript, 3000, "humanChar");
      if (!typed) return false;

      // Natural typing delay
      const char = value[i];
      let delay = randomBetween(35, 95);
      if (char === ' ' || /[.,!?;:\-]/.test(char)) delay += randomBetween(40, 120);
      burstCounter--;
      if (burstCounter <= 0) {
        delay += randomBetween(150, 400);
        burstCounter = randomBetween(5, 12);
      }
      // Speed up slightly for very long text
      if (i > 80) delay = Math.max(15, delay - 30);
      await sleep(delay);
    }

    // Step 3: Blur with change event
    const blurScript = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var el = document.querySelector(sel);
  if (el) { el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); }
  return true;
} catch(e) { return false; }
})()`;
    await runInWebview(blurScript, 3000, "humanBlur");
    return true;
  };

  // Native <select>: DO NOT el.click() — that opens the OS picker which JS cannot control.
  // Instead set .value directly with the React/Vue-compatible descriptor trick.
  const humanSelectNativeOption = async (selector: string, value: string): Promise<boolean> => {
    await humanScrollToField(selector);
    await sleep(randomBetween(200, 350));

    const selB64 = btoa(unescape(encodeURIComponent(selector)));
    const valB64 = btoa(unescape(encodeURIComponent(value)));
    const script = `(function(){
try {
  var sel = decodeURIComponent(escape(atob("${selB64}")));
  var val = decodeURIComponent(escape(atob("${valB64}")));
  var el = document.querySelector(sel);
  if (!el || el.tagName !== 'SELECT') return false;
  var opts = Array.from(el.options);
  var lower = String(val || '').toLowerCase().trim();
  var best = null; var bestScore = 0;
  for (var i = 0; i < opts.length; i++) {
    var t = String(opts[i].textContent || '').toLowerCase().trim();
    var sc = 0;
    if (t === lower) sc = 100;
    else if (t.startsWith(lower) || lower.startsWith(t)) sc = 80;
    else if (t.includes(lower) || lower.includes(t)) sc = 60;
    if (sc > bestScore) { best = opts[i]; bestScore = sc; }
  }
  if (!best || bestScore < 60) return false;
  el.focus();
  try { var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); if (d && d.set) d.set.call(el, best.value); else el.value = best.value; } catch(e) { el.value = best.value; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return true;
} catch(e) { return false; }
})()`;
    const result = await runInWebview(script, 5000, "humanSelectNative");
    await sleep(randomBetween(200, 400));
    return result === true;
  };

  const humanFillCustomDropdown = async (selector: string, value: string): Promise<boolean> => {
    // Step 1: Open dropdown with human-like click
    const opened = await openCustomDropdownInWebview(selector);
    if (!opened) return false;

    // Step 2: Pause to "read" the options
    await sleep(randomBetween(600, 1200));

    // Step 3: Select the matching option
    const matched = await selectCustomDropdownOptionInWebview(opened.resolvedSelector, opened.token, value);
    if (!matched) {
      await closeCustomDropdownInWebview(opened.resolvedSelector, opened.token);
      return false;
    }

    // Step 4: Close with a natural pause
    await sleep(randomBetween(200, 400));
    await closeCustomDropdownInWebview(opened.resolvedSelector, opened.token);
    return true;
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
  // Cleans a raw label string: collapses whitespace, strips asterisks/bullets, trims.
  var cleanLabel = function(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/[*•]+/g, "")
      .replace(/(\\s*(required|optional|mandatory)\\s*)/gi, " ")
      .replace(/\\s+/g, " ")
      .replace(/\\n+/g, " ")
      .trim();
  };
  // getBestLabel: robust label extraction covering aria-labelledby, DOM traversal,
  // and parent sibling text nodes — handles Workday, Ashby, Greenhouse, Lever etc.
  var getBestLabel = function(el, doc) {
    try {
      // Pattern for generic placeholder text that should never be returned as a label.
      var SKIP_TEXT = /^(select\b|choose\b|pick\b|none\b|-{2,}|_{2,}|enter\b.*answer|your answer|type here)/i;
      // 1. aria-label (skip generic placeholder-style aria-labels like "Select...")
      var al = el.getAttribute("aria-label"); if (al) { var alC = cleanLabel(al); if (alC.length > 2 && !/^(select|choose|pick|none)\b/i.test(alC)) return alC; }
      // 2. aria-labelledby → dereference the linked element
      var labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        var ids = labelledBy.trim().split(/\\s+/);
        var parts = [];
        for (var li = 0; li < ids.length; li++) {
          try { var ref = doc.getElementById(ids[li]); if (ref) { var rt = (ref.innerText || ref.textContent || "").trim(); if (rt) parts.push(rt); } } catch(e2) {}
        }
        if (parts.length > 0) { var joined = cleanLabel(parts.join(" ")); if (joined.length > 2 && !SKIP_TEXT.test(joined)) return joined; }
      }
      // 3. <label for=id> (clone to strip nested inputs from text)
      var eid = el.id;
      if (eid) {
        var lbl = doc.querySelector("label[for=" + JSON.stringify(eid) + "]");
        if (lbl) { var c = lbl.cloneNode(true); try { c.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); } catch(e3) {} var t = cleanLabel(c.textContent); if (t.length > 2) return t; }
      }
      // 4. parent <label> wrapper (clone to strip nested inputs)
      var wrapped = el.closest("label");
      if (wrapped) { var c2 = wrapped.cloneNode(true); try { c2.querySelectorAll("input,select,textarea,button").forEach(function(x) { x.remove(); }); } catch(e4) {} var t2 = cleanLabel(c2.textContent); if (t2.length > 2) return t2; }
      // 5. fieldset legend
      var fs = el.closest("fieldset"); if (fs) { var leg = fs.querySelector("legend"); if (leg) { var lt = cleanLabel(leg.textContent); if (lt.length > 2) return lt; } }
      // 6-7. Sibling-of-path DOM walk: at each ancestor level collect text from ALL children
      //       EXCEPT the child that is on the path to el. This is the key fix — it prevents
      //       el's own rendered text (e.g. "Select..." inside a combobox) from being read back
      //       as the label. Climbs up to 6 levels to find cousin labels (Workday, Ashby, etc.).
      //       ALSO: if collected text looks like a generic placeholder (e.g. "Select...") skip
      //       that level and keep climbing — the real label is further up the tree.
      var pathEl = el;
      for (var dd = 0; dd < 6; dd++) {
        var par2 = pathEl.parentElement;
        if (!par2) break;
        var sibs2 = [];
        var cnodes = Array.from(par2.childNodes);
        for (var cj = 0; cj < cnodes.length; cj++) {
          var cn = cnodes[cj];
          // Skip the subtree that contains el — its text is NOT the label
          if (cn === pathEl || (cn.nodeType === 1 && typeof cn.contains === "function" && cn.contains(pathEl))) continue;
          var ctg2 = cn.nodeType === 1 ? ((cn.tagName || "").toLowerCase()) : "";
          if (ctg2 && /^(script|style|input|select|textarea|button)$/.test(ctg2)) continue;
          var ctt = ((cn.innerText || cn.textContent) || "").trim();
          if (ctt && ctt.length >= 2 && ctt.length <= 200) sibs2.push(ctt);
        }
        var combined2 = cleanLabel(sibs2.join(" "));
        // Skip generic placeholder text (e.g. react-select __placeholder div) — keep climbing
        if (combined2.length > 3 && combined2.length < 200 && !SKIP_TEXT.test(combined2)) return combined2;
        pathEl = par2;
      }
      // 8. placeholder — reject generic non-label placeholders like "Select...", "Choose..."
      var ph = el.getAttribute("placeholder"); var phClean = ph ? cleanLabel(ph) : "";
      if (phClean.length > 2 && !/^(select|choose|pick|none)\b/i.test(phClean) && !/^-{2,}/.test(phClean) && !/^_{2,}/.test(phClean)) return phClean;
      // 9. name attribute
      var nm = el.getAttribute("name"); if (nm && cleanLabel(nm).length > 2) return cleanLabel(nm).replace(/[_\\-]/g, " ");
      return "";
    } catch(e) { return ""; }
  };
  // Returns a unique, stable CSS selector for an element.
  // Priority: id → name attr → data-testid → full ancestor path with class+nth-of-type.
  var getUniqueSelector = function(el) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      var n = el.getAttribute("name"); if (n) return el.tagName.toLowerCase() + "[name=" + JSON.stringify(n) + "]";
      var td = el.getAttribute("data-testid"); if (td) return "[data-testid=" + JSON.stringify(td) + "]";
      var path = []; var cur = el;
      while (cur && cur.nodeType === 1 && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
        var seg = cur.nodeName.toLowerCase();
        if (cur.id) { path.unshift("#" + CSS.escape(cur.id)); break; }
        var rawCls = typeof cur.className === "string" ? cur.className.trim().split(/\\s+/).filter(function(c) { return c && /^[a-zA-Z_\\-][a-zA-Z0-9_\\-]*$/.test(c); }).slice(0, 2) : [];
        if (rawCls.length > 0) seg += "." + rawCls.join(".");
        var parent = cur.parentNode;
        if (parent && parent.children) {
          var sibs = Array.from(parent.children).filter(function(e) { return e.nodeName === cur.nodeName; });
          if (sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
        }
        path.unshift(seg);
        cur = cur.parentNode;
        if (path.length >= 8) break;
      }
      return path.length > 0 ? path.join(" > ") : el.tagName.toLowerCase();
    } catch(e) { return el.tagName ? el.tagName.toLowerCase() : "unknown"; }
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
        var sel = getUniqueSelector(el); if (seen[sel]) continue; seen[sel] = true;
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
        var sel = getUniqueSelector(el); if (seen[sel]) continue; seen[sel] = true;
        var rawLabel = getBestLabel(el, doc); var label = cleanLabel(rawLabel); var val = fieldValue(label);
        console.log("[Label Debug]", JSON.stringify({ selector: sel, rawLabel: rawLabel, label: label, val: val ? val.slice(0,40) : "" }));
        if (isCustom(el)) {
          var con = el.closest("[class*='__control'],[class*='SelectControl'],[role='combobox']") || el.parentElement;
          // Always add — fallback label so unlabelled dropdowns are NOT silently dropped.
          var clblInner = (label && label.length >= 3) ? label : ("Dropdown " + (unfilled.length + 1));
          unfilled.push({ label: clblInner, selector: sel, fieldType: "custom-select", options: getCustomOpts(con, el), autoValue: fieldValue(clblInner) || "" });
          continue;
        }
        if (!val) { var ft = el.tagName === "SELECT" ? "select" : (el.tagName === "TEXTAREA" ? "textarea" : "text"); var fo = el.tagName === "SELECT" ? Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean) : []; var effectiveLbl = (label && label.length >= 3) ? label : ("Field " + (unfilled.length + 1)); unfilled.push({ label: effectiveLbl, selector: sel, fieldType: ft, options: fo, autoValue: "" }); continue; }
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && tr(el.value || "") && tr(el.value || "").length > 1) continue;
        if (el.tagName === "SELECT") { var fo2 = Array.from(el.options).map(function(o) { return (o.text || "").trim(); }).filter(Boolean); if (fillSel(el, val)) filled++; else { var fo2label = (label && label.length >= 3) ? label : ("Field " + (unfilled.length + 1)); unfilled.push({ label: fo2label, selector: sel, fieldType: "select", options: fo2, autoValue: val }); } } else { if (fillField(el, val)) filled++; }
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
        if (cel.querySelector("input:not([type='hidden']), select")) continue;
        if (!isVis(cel, view3)) continue;
        var csel = getUniqueSelector(cel); if (seen[csel]) continue; seen[csel] = true;
        var clabel = cleanLabel(getBestLabel(cel, doc3));
        console.log("[Label Debug Combo]", JSON.stringify({ selector: csel, label: clabel }));
        // Always add — fallback label so unlabelled comboboxes are NOT silently dropped.
        if (!clabel || clabel.length < 3) clabel = "Dropdown " + (unfilled.length + 1);
        var cval = fieldValue(clabel);
        var ctrlId = cel.getAttribute("aria-controls") || cel.getAttribute("aria-owns") || "";
        var copts = [];
        try { if (ctrlId) copts = Array.from(doc3.querySelectorAll("#" + CSS.escape(ctrlId) + " [role='option']")).map(function(o) { return (o.textContent || "").trim(); }).filter(Boolean); } catch(ce) {}
        if (!cval) { unfilled.push({ label: clabel, selector: csel, fieldType: "custom-select", options: copts, autoValue: "" }); }
        else { unfilled.push({ label: clabel, selector: csel, fieldType: "custom-select", options: copts, autoValue: cval }); }
      } catch(ce2) {}
    }
  }

  // Deduplicate by SELECTOR (not label) — multiple dropdowns can share a label but must have distinct selectors.
  var seenSel = {}; var deduped = unfilled.filter(function(f) { if (!f.selector || seenSel[f.selector]) return false; seenSel[f.selector] = true; return true; });
  console.log("[Unfilled Fields Debug]", JSON.stringify({ totalDetected: unfilled.length, afterDedup: deduped.length, autoAnswerCount: deduped.filter(function(f){return !!f.autoValue;}).length, noAnswerCount: deduped.filter(function(f){return !f.autoValue;}).length, fieldLabels: deduped.map(function(f){return f.label;}), filled: filled }));
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

  const openCustomDropdownInWebview = async (selector: string): Promise<{ token: string; resolvedSelector: string } | null> => {
    const token = `autoapply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeSel = JSON.stringify(selector);
    const safeToken = JSON.stringify(token);
    const safeAttr = JSON.stringify(WEBVIEW_SNAPSHOT_ATTR);
    // Step A: close menus, snapshot option nodes, resolve selector, find trigger rect
    const prepScript = `
(function() {
try {
  var ATTR = ${safeAttr};
  // Close any open dropdown
  try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); } catch(e) {}
  try { document.body.click(); } catch(e) {}

  var matches = document.querySelectorAll(${safeSel});
  console.log("[Dropdown Open]", JSON.stringify({ selector: ${safeSel}, matchCount: matches.length }));
  if (matches.length === 0) return { ok: false, reason: "no-match" };
  var resolvedSel = ${safeSel};
  if (matches.length !== 1) {
    var autoId = "aa-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    matches[0].setAttribute("data-auto-id", autoId);
    resolvedSel = ${safeSel} + "[data-auto-id='" + autoId + "']";
  }
  var el = matches[0];

  // Snapshot all current option-like nodes
  try { document.querySelectorAll("[" + ATTR + "]").forEach(function(n) { n.removeAttribute(ATTR); }); } catch(e) {}
  var SNAP_SELS = [
    "[role='option']", "[role='menuitem']", "[role='listitem']",
    "[class*='__option']", "[class*='-option']", "[class*='Option']",
    "[class*='item']", "li", "[data-value]"
  ];
  for (var si = 0; si < SNAP_SELS.length; si++) {
    try { document.querySelectorAll(SNAP_SELS[si]).forEach(function(n) { if (!n.getAttribute(ATTR)) n.setAttribute(ATTR, ${safeToken}); }); } catch(e) {}
  }

  // Find the trigger container and get its viewport coordinates
  var con = el.closest("[role='combobox']") || el.closest("[aria-haspopup='listbox']") || el.closest("[class*='__control']") || el.closest("[class*='SelectControl']") || el.parentElement || el;
  var trigger = con || el;
  trigger.scrollIntoView({ behavior: 'instant', block: 'center' });
  var r = trigger.getBoundingClientRect();
  try { if (el.tagName === "INPUT" || el.tagName === "BUTTON") el.focus(); } catch(e) {}
  return { ok: true, resolvedSel: resolvedSel, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
} catch(e) {
  return { ok: false, err: String(e.message || e) };
}
})()`;
    const prep = await runInWebview(prepScript, 5000, "openDropdownPrep");
    if (!prep?.ok) return null;

    const resolvedSel = (prep.resolvedSel as string) || selector;

    // Step B: Use REAL trusted click via Electron sendInputEvent, then JS dispatch fallback
    let clicked = false;
    if (typeof prep.cx === "number" && typeof prep.cy === "number") {
      clicked = await realClickAt(prep.cx, prep.cy);
    }
    if (!clicked) {
      // Fallback: JS-dispatch click on the trigger (works for some ATS)
      const fallbackScript = `
(function() {
try {
  var el = document.querySelector(${JSON.stringify(resolvedSel)});
  if (!el) return false;
  var con = el.closest("[role='combobox']") || el.closest("[aria-haspopup='listbox']") || el.closest("[class*='__control']") || el.closest("[class*='SelectControl']") || el.parentElement || el;
  var trigger = con || el;
  var fire = function(t) {
    try { t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch(e) {}
    try { t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch(e) {}
    try { t.click(); } catch(e) {}
  };
  fire(trigger);
  if (trigger !== el) fire(el);
  return true;
} catch(e) { return false; }
})()`;
      await runInWebview(fallbackScript, 5000, "openDropdownFallback");
    }

    return { token, resolvedSelector: resolvedSel };
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
  var seen = {};
  var all = Array.from(document.querySelectorAll(OPT_SEL));
  var dropdownEl = document.querySelector(${safeSel});

  // Proximity filter: option must be within 300px vertically of the dropdown bottom
  // and horizontally overlapping. Prevents cross-dropdown contamination when multiple
  // option lists remain open in the DOM simultaneously (common in ATS systems).
  var isNearDropdown = function(optionNode, ddEl) {
    if (!optionNode || !ddEl) return false;
    try {
      var dr = ddEl.getBoundingClientRect();
      var or = optionNode.getBoundingClientRect();
      var verticalDistance = Math.abs(or.top - dr.bottom);
      var horizontalOverlap = or.left < dr.right && or.right > dr.left;
      return verticalDistance < 600 && horizontalOverlap;
    } catch(e) { return false; }
  };

  // Fresh = nodes that appeared AFTER the snapshot (DOM-insertion pattern, e.g. React portals)
  var fresh = all.filter(function(node) { return node.getAttribute(ATTR) !== ${safeToken}; });

  var candidates;
  var visibleCount = 0;
  var nearVisibleCount = 0;
  if (fresh.length > 0) {
    // DOM-insert pattern: use only the newly inserted nodes
    candidates = fresh;
  } else {
    // CSS-toggle pattern: options were pre-rendered; visibility + proximity isolate
    // this dropdown's options and prevent cross-field contamination.
    var visible = all.filter(function(node) {
      try { var r = node.getBoundingClientRect(); return r.height > 0 && r.width > 0; } catch(e) { return false; }
    });
    visibleCount = visible.length;
    var nearVisible = visible.filter(function(node) { return isNearDropdown(node, dropdownEl); });
    nearVisibleCount = nearVisible.length;
    candidates = nearVisible.length > 0 ? nearVisible : visible;
  }

  var result = candidates
    .map(function(node) { return (node.textContent || "").trim().replace(/\\s+/g, " "); })
    .filter(function(text) { return text.length >= 2 && text.length <= 300 && !seen[text] && (seen[text] = true); });

  console.log("[Dropdown Read Debug]", JSON.stringify({ selector: ${safeSel}, freshCount: fresh.length, visibleCount: visibleCount, nearVisibleCount: nearVisibleCount, finalCount: result.length }));
  console.log("[Dropdown Read]", JSON.stringify({ selector: ${safeSel}, freshCount: fresh.length, sourceCount: candidates.length, optionCount: result.length, preview: result.slice(0, 4) }));
  return result;
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
    if (!t || t.length > 300) return 0;
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

  // Proximity filter: option must be within 300px vertically of the dropdown bottom
  // and horizontally overlapping. Prevents cross-dropdown contamination when multiple
  // option lists remain open in the DOM simultaneously.
  var dropdownEl = document.querySelector(${safeSel});
  var isNearDropdown = function(optionNode, ddEl) {
    if (!optionNode || !ddEl) return false;
    try {
      var dr = ddEl.getBoundingClientRect();
      var or = optionNode.getBoundingClientRect();
      var verticalDistance = Math.abs(or.top - dr.bottom);
      var horizontalOverlap = or.left < dr.right && or.right > dr.left;
      return verticalDistance < 600 && horizontalOverlap;
    } catch(e) { return false; }
  };

  // Prefer fresh (DOM-insert pattern). For CSS-toggle pattern, fresh is empty — fall back
  // to VISIBLE + spatially-near stale nodes. Proximity prevents cross-dropdown contamination
  // when multiple option lists remain open in the DOM simultaneously.
  var candidates;
  var nearVisibleCount = 0;
  if (fresh.length > 0) {
    candidates = fresh;
  } else {
    var visible = stale.filter(function(n) {
      try { var r = n.getBoundingClientRect(); return r.height > 0 && r.width > 0; } catch(e) { return false; }
    });
    var nearVisible = visible.filter(function(n) { return isNearDropdown(n, dropdownEl); });
    nearVisibleCount = nearVisible.length;
    if (nearVisible.length > 0) {
      candidates = nearVisible;
    } else if (visible.length > 0) {
      candidates = visible;
    } else {
      candidates = stale; // Last resort
    }
  }

  console.log("[Dropdown Select Debug]", JSON.stringify({ selector: ${safeSel}, value: val, freshCount: fresh.length, staleCount: stale.length, nearVisibleCount: nearVisibleCount, candidateCount: candidates.length }));

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
  // Returns the set of selectors that could NOT be filled successfully.
  const applyUserAnswersToForm = async (answers: Record<string, string>, fieldMap?: Map<string, UnfilledField>): Promise<Set<string>> => {
    const failed = new Set<string>();
    if (Object.keys(answers).length === 0) return failed;

    const entries = Object.entries(answers);
    for (let i = 0; i < entries.length; i++) {
      const [selector, rawValue] = entries[i];
      const value = rawValue.trim();
      if (!value) continue;

      const field = fieldMap?.get(selector);
      const fieldType = field?.fieldType ?? "text";

      setStatus(`Filling field ${i + 1}/${entries.length}: "${field?.label ?? "field"}"...`);

      // Scroll to field first
      await humanScrollToField(selector);
      await sleep(randomBetween(300, 500));
      await humanHighlightField(selector, true);
      await sleep(randomBetween(200, 300));

      let success = false;

      if (fieldType === "custom-select") {
        success = await humanFillCustomDropdown(selector, value);
        if (!success) {
          // Fallback: try native select or typing
          const nativeOk = await humanSelectNativeOption(selector, value);
          if (!nativeOk) {
            success = await humanTypeInField(selector, value);
          } else {
            success = true;
          }
        }
      } else if (fieldType === "select") {
        success = await humanSelectNativeOption(selector, value);
      } else {
        // text / textarea — human type
        success = await humanTypeInField(selector, value);
      }

      await humanHighlightField(selector, false);

      if (!success) {
        // Last-resort: try the basic instant approach
        const mode = await applyBasicFieldAnswer(selector, value);
        if (mode === "done") {
          success = true;
        } else if (mode === "custom") {
          const opened = await openCustomDropdownInWebview(selector);
          if (opened) {
            await sleep(700);
            const matched = await selectCustomDropdownOptionInWebview(opened.resolvedSelector, opened.token, value);
            await closeCustomDropdownInWebview(opened.resolvedSelector, opened.token);
            success = matched;
          }
        }
      }

      if (!success) failed.add(selector);

      // Pause between fields
      await sleep(randomBetween(400, 700));
    }

    return failed;
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
    // For custom AND other (div-based comboboxes), try opening
    if (inspected?.kind === "missing") return [];

    const opened = await openCustomDropdownInWebview(selector);
    if (!opened) return [];

    await sleep(700);
    const options = await readCustomDropdownOptionsInWebview(opened.resolvedSelector, opened.token);
    await closeCustomDropdownInWebview(opened.resolvedSelector, opened.token);
    await sleep(180);
    return options;
  };

  // Enriches each custom-select field independently: open → read → close per field.
  // Each field gets its own token; NO state is shared between iterations.
  const enrichUnfilledWithOptions = async (fields: UnfilledField[]): Promise<UnfilledField[]> => {
    const enriched = [...fields];
    for (let i = 0; i < enriched.length; i++) {
      const f = enriched[i];
      if (f.fieldType !== "custom-select" || f.options.length > 0) continue;

      console.log(`[AutoApply:enrich] Dropdown ${i + 1}/${enriched.length}: "${f.label}" selector="${f.selector}"`);
      await sleep(300);

      const opened = await openCustomDropdownInWebview(f.selector);
      if (!opened) {
        console.warn(`[AutoApply:enrich] Failed to open dropdown for "${f.label}"`);
        continue;
      }

      await sleep(700);
      const opts = await readCustomDropdownOptionsInWebview(opened.resolvedSelector, opened.token);
      console.log(`[AutoApply:enrich] "${f.label}" → ${opts.length} options:`, opts.slice(0, 5));

      await closeCustomDropdownInWebview(opened.resolvedSelector, opened.token);
      await sleep(300);

      if (opts.length > 0) enriched[i] = { ...f, options: opts };
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

    try {
      for (let step = 0; step < 12; step++) {
        if (loopTokenRef.current !== token) break;

        // ── Step 1: Locate form / click Apply ──────────────────────────
        setStatus("Looking for application form...");
        const locate = await locateForm();

        if (loopTokenRef.current !== token) break;
        if (locate === null) break;
        setStatus(locate.message);

        if (locate.clicked) break; // clicked Apply — nav handler will restart

        await sleep(randomBetween(500, 900));
        if (loopTokenRef.current !== token) break;

        // ── Step 2: Extract all fields (no filling yet) ────────────────
        setStatus("Reading form fields...");
        const fields = await extractFormFields();

        if (loopTokenRef.current !== token) break;
        if (!fields || fields.length === 0) {
          setStatus("No form fields found.");
          break;
        }

        setStatus(`Found ${fields.length} field(s). Filling one by one...`);
        await sleep(randomBetween(400, 800));

        // ── Step 3: Process each field sequentially like a human ───────
        let totalFilled = 0;
        const needsInput: UnfilledField[] = [];

        for (let fi = 0; fi < fields.length; fi++) {
          if (loopTokenRef.current !== token) break;

          const field = fields[fi];

          // Skip if already correctly filled.
          // text/textarea: any existing content = skip (don't overwrite user-typed data).
          // select/custom-select: a pre-selected default (e.g. "United States") is NOT filled —
          //   only skip if the current value already matches what we would fill.
          if (field.existingValue && field.existingValue.length > 1) {
            if (field.fieldType === "text" || field.fieldType === "textarea") continue;
            if (field.suggestedValue && field.existingValue.toLowerCase() === field.suggestedValue.toLowerCase()) continue;
            if (!field.suggestedValue) continue; // no answer to fill, nothing to do
          }

          setStatus(`Field ${fi + 1}/${fields.length}: "${field.label}"`);

          // Scroll to the field so user can see it
          await humanScrollToField(field.selector);
          await sleep(randomBetween(300, 600));

          // Highlight the current field
          await humanHighlightField(field.selector, true);
          await sleep(randomBetween(200, 400));

          if (field.suggestedValue) {
            // We know the answer — fill it human-like
            let filled = false;

            if (field.fieldType === "text" || field.fieldType === "textarea") {
              filled = await humanTypeInField(field.selector, field.suggestedValue);
            } else if (field.fieldType === "select") {
              filled = await humanSelectNativeOption(field.selector, field.suggestedValue);
            } else if (field.fieldType === "custom-select") {
              filled = await humanFillCustomDropdown(field.selector, field.suggestedValue);
            }

            // Remove highlight
            await humanHighlightField(field.selector, false);

            if (filled) {
              totalFilled++;
              setStatus(`✓ Filled "${field.label}"`);
            } else {
              // Fill failed — fetch options for dropdown types before showing in panel
              if ((field.fieldType === "custom-select" || field.fieldType === "select") && field.options.length === 0) {
                setStatus(`Reading options for "${field.label}"...`);
                const opts = await fetchDropdownOptions(field.selector);
                field.options = opts;
              }
              needsInput.push({
                label: field.label,
                selector: field.selector,
                fieldType: field.fieldType === "custom-select" ? "custom-select" : field.fieldType === "select" ? "select" : field.fieldType === "textarea" ? "textarea" : "text",
                options: field.options,
                autoValue: field.suggestedValue,
              });
            }

            // Pause between fields like a human
            await sleep(randomBetween(400, 900));
          } else {
            // No known answer — collect for user input panel
            await humanHighlightField(field.selector, false);

            if ((field.fieldType === "custom-select" || field.fieldType === "select") && field.options.length === 0) {
              // Open dropdown / read native select to extract options for the panel
              setStatus(`Reading options for "${field.label}"...`);
              const opts = await fetchDropdownOptions(field.selector);
              field.options = opts;
              await sleep(randomBetween(200, 400));
            }

            needsInput.push({
              label: field.label,
              selector: field.selector,
              fieldType: field.fieldType === "custom-select" ? "custom-select" : field.fieldType === "select" ? "select" : field.fieldType === "textarea" ? "textarea" : "text",
              options: field.options,
              autoValue: "",
            });
          }
        }

        if (loopTokenRef.current !== token) break;

        // ── Step 4: Show unfilled fields panel if any ──────────────────
        if (needsInput.length > 0) {
          setUnfilledFields(needsInput);

          // Pre-populate from saved profile answers
          const pre: Record<string, string> = {};
          for (const f of needsInput) {
            const saved = profileRef.current.answers?.[f.label];
            if (saved) pre[f.selector] = saved;
            if (f.autoValue) pre[f.selector] = f.autoValue;
          }
          if (Object.keys(pre).length > 0) setUserAnswers((prev) => ({ ...prev, ...pre }));

          setStatus(`Filled ${totalFilled} field(s). ${needsInput.length} need your input — answer below.`);
          break;
        }

        // ── Step 5: Advance form (Next / Submit) ───────────────────────
        await sleep(randomBetween(500, 1000));
        if (loopTokenRef.current !== token) break;

        setStatus("Looking for Next / Submit...");
        const advance = await advanceForm();
        if (loopTokenRef.current !== token) break;
        if (advance === null) break;
        setStatus(advance.message);

        if (advance.isSubmit) {
          if (totalFilled === 0) setStatus("Safety stop: not submitting — no fields were filled.");
          else setStatus("Application submitted!");
          break;
        }

        if (!advance.clicked && totalFilled === 0) {
          setStatus("No progress — auto mode stopped.");
          break;
        }

        await sleep(randomBetween(800, 1500));
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
    const fieldInfoMap = new Map<string, UnfilledField>();
    for (const field of unfilledFields) {
      const v = userAnswers[field.selector]; if (!v?.trim()) continue;
      toApply[field.selector] = v.trim(); labelMap[field.label] = v.trim();
      fieldInfoMap.set(field.selector, field);
    }
    if (Object.keys(toApply).length === 0) return;
    setSavingAnswers(true);
    try {
      const failedOnSave = await applyUserAnswersToForm(toApply, fieldInfoMap);
      const updated: UserProfile = { ...profileRef.current, answers: { ...(profileRef.current.answers ?? {}), ...labelMap } };
      saveProfile(updated);
      await putProfile(updated).catch(() => {});
      onProfileUpdate?.(updated);
      // Remove fields that were successfully applied; keep failed ones in panel so user can retry
      setUnfilledFields((prev) => prev.filter((f) => !toApply[f.selector] || failedOnSave.has(f.selector)));
      if (failedOnSave.size > 0) {
        setStatus(`Applied ${Object.keys(toApply).length - failedOnSave.size} answer(s). ${failedOnSave.size} field(s) could not be filled — please try again.`);
      } else {
        setStatus(`Applied ${Object.keys(toApply).length} answer(s) and saved to profile.`);
      }
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
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{field.label || `Field ${unfilledFields.indexOf(field) + 1}`}</label>
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