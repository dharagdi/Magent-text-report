/* content-autofill.js — fills the application form on the current page from the
   user's saved profile, and (where the browser allows) attaches the tailored
   resume file. Runs on Indeed/LinkedIn and common ATS domains (Greenhouse,
   Lever, Workday, Ashby).

   Design principles:
   - Never overwrite a field the user already filled.
   - Match fields by their real label / aria-label / placeholder / name.
   - Fire native input+change events so React/Vue-based forms register the value.
   - The final Submit is always left to the user (ToS + account safety). */
(function () {
  "use strict";

  function labelText(el) {
    const parts = [];
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) parts.push(l.innerText);
    }
    const al = el.getAttribute("aria-label"); if (al) parts.push(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      lb.split(/\s+/).forEach((id) => { const l = document.getElementById(id); if (l) parts.push(l.innerText); });
    }
    if (el.placeholder) parts.push(el.placeholder);
    if (el.name) parts.push(el.name);
    // ATS-specific hooks: Workday (data-automation-id), Greenhouse/Ashby (data-*)
    ["data-automation-id", "data-qa", "data-testid", "data-field"].forEach((a) => {
      const v = el.getAttribute(a); if (v) parts.push(v.replace(/[-_]/g, " "));
    });
    const wrap = el.closest("label"); if (wrap) parts.push(wrap.innerText);
    // nearest question/field container's label/legend
    const grp = el.closest("[class*='field'], [class*='question'], [class*='form-group'], [data-automation-id*='formField'], .application-question, fieldset, div");
    if (grp) {
      const lbl = grp.querySelector("label, legend, .label, [class*='label'], [id$='-label']");
      if (lbl && !lbl.contains(el)) parts.push(lbl.innerText);
    }
    return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function setNative(el, val) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectMatch(el, val) {
    const v = String(val).toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(v) || opt.value.toLowerCase().includes(v)) {
        el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return true;
      }
    }
    return false;
  }

  function firstLast(name, which) {
    const p = (name || "").trim().split(/\s+/);
    return which === "first" ? (p[0] || "") : (p.length > 1 ? p[p.length - 1] : "");
  }

  function buildRules(profile, ctx) {
    // Order matters — more specific patterns first so "first name" wins over "name".
    return [
      { re: /first[\s_]*name|given name|\bfname\b|forename/, val: firstLast(profile.name, "first") },
      { re: /last[\s_]*name|surname|family name|\blname\b/, val: firstLast(profile.name, "last") },
      { re: /preferred name/, val: firstLast(profile.name, "first") },
      { re: /full[\s_]*name|your name|^name$|candidate name|legal name|applicant name/, val: profile.name },
      { re: /e-?mail/, val: profile.email },
      { re: /phone|mobile|telephone|\btel\b|contact number/, val: profile.phone },
      { re: /linkedin/, val: profile.linkedin },
      { re: /github|portfolio|personal (site|website)|website|\burl\b/, val: profile.website },
      { re: /street|address line|address 1|address$/, val: profile.address },
      { re: /postal|zip/, val: profile.postal },
      { re: /\bcountry\b/, val: profile.country },
      { re: /\bstate\b|province|region/, val: profile.state },
      { re: /\bcity\b|town|locality|current location|based in|location/, val: profile.city || profile.location },
      { re: /salary|compensation|expected pay|desired pay|pay expectation|rate/, val: profile.salary },
      { re: /years.*experience|experience.*years|\byoe\b/, val: profile.years },
      { re: /notice period|start date|availability|when.*(start|available)|earliest/, val: profile.notice },
      { re: /how did you (hear|find)|source|referr/, val: profile.source || "Company website" },
      { re: /cover letter|why.*(you|interest)|message to|motivat|additional info|tell us|anything else/, val: ctx.cover, textareaOnly: true },
    ];
  }

  function fillYesNo(profile) {
    let n = 0;
    // Radio/select questions for work authorization & sponsorship.
    const groups = document.querySelectorAll("fieldset, [role='radiogroup'], [class*='question'], [class*='field']");
    groups.forEach((g) => {
      const t = (g.innerText || "").toLowerCase();
      let want = null;
      if (/authoriz(ed|ation) to work|legally.*work|right to work|work permit/.test(t)) want = profile.workAuth !== false;
      else if (/sponsor|visa/.test(t)) want = profile.sponsorship === true;
      if (want === null) return;
      const wantText = want ? "yes" : "no";
      // radios
      const radios = g.querySelectorAll("input[type=radio]");
      for (const r of radios) {
        const lab = labelText(r);
        if ((wantText === "yes" && /\byes\b/.test(lab)) || (wantText === "no" && /\bno\b/.test(lab))) {
          if (!r.checked) { r.click(); n++; }
          break;
        }
      }
      // selects
      const sel = g.querySelector("select");
      if (sel && !sel.value) { if (selectMatch(sel, wantText)) n++; }
    });
    return n;
  }

  function autofill(profile, ctx) {
    const rules = buildRules(profile, ctx);
    let filled = 0;
    const fields = Array.from(document.querySelectorAll("input, textarea, select"));
    for (const el of fields) {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "file", "password", "submit", "button", "checkbox", "radio"].includes(type)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim()) continue; // never overwrite
      const lab = labelText(el);
      if (!lab) continue;
      for (const r of rules) {
        if (r.textareaOnly && el.tagName !== "TEXTAREA") continue;
        if (r.val && r.re.test(lab)) {
          if (el.tagName === "SELECT") { if (selectMatch(el, r.val)) filled++; }
          else { setNative(el, r.val); filled++; flash(el); }
          break;
        }
      }
    }
    filled += fillYesNo(profile);
    return filled;
  }

  function flash(el) {
    const prev = el.style.outline;
    el.style.outline = "2px solid #4f46e5";
    el.style.transition = "outline .3s";
    setTimeout(() => { el.style.outline = prev; }, 1600);
  }

  function attachResume(base64, filename) {
    let bin;
    try { bin = atob(base64); } catch (e) { return 0; }
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], filename, { type: "application/pdf" });
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    let done = 0;
    for (const inp of inputs) {
      const accept = (inp.getAttribute("accept") || "").toLowerCase();
      if (accept && !/pdf|\*|application/.test(accept)) continue;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        inp.files = dt.files;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        flash(inp.closest("label, div") || inp);
        done++;
      } catch (e) { /* custom uploader — user attaches manually */ }
    }
    return done;
  }

  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg) return false;
    if (msg.type === "autofill") { send({ filled: autofill(msg.profile || {}, { cover: msg.cover || "" }) }); return true; }
    if (msg.type === "attachResume") { send({ attached: attachResume(msg.pdfBase64, msg.filename) }); return true; }
    if (msg.type === "ping") { send({ ok: true }); return true; }
    return false;
  });
})();
