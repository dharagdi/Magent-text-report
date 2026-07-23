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

  const LEARN_KEY = "ja_learned_v1";
  const PROFILE_KEY = "ja_profile_v1";

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
    const p = profile || {};
    const fullLoc = [p.city || p.location, p.state, p.country].filter(Boolean).join(", ");
    // Order matters — MOST specific patterns first (e.g. "first name" before "name",
    // "address line 2" before "address"). Built from the fields Workday/Greenhouse/
    // Lever/iCIMS/Taleo and LinkedIn/Indeed apply forms actually ask for.
    return [
      // — Name —
      { re: /middle\s*name|middle initial/, val: p.middleName },
      { re: /first[\s_]*name|given name|\bfname\b|forename|legal first/, val: firstLast(p.name, "first") },
      { re: /last[\s_]*name|surname|family name|\blname\b|legal last/, val: firstLast(p.name, "last") },
      { re: /preferred name|nick\s*name|goes by|preferred first/, val: firstLast(p.name, "first") },
      { re: /full[\s_]*name|your name|^name$|candidate name|legal name|applicant name/, val: p.name },
      // — Contact —
      { re: /confirm.*e-?mail|e-?mail.*confirm|verify e-?mail/, val: p.email },
      { re: /e-?mail/, val: p.email },
      { re: /country code|dialing code/, val: p.countryCode || "+1" },
      { re: /mobile|cell|primary phone|phone|telephone|\btel\b|contact number/, val: p.phone },
      // — Address —
      { re: /address line ?2|apt|suite|unit|address 2/, val: p.addressLine2 },
      { re: /street|address line ?1|address 1|mailing address|home address|street address|^address/, val: p.address },
      { re: /postal|zip|pin ?code|post ?code/, val: p.postal },
      { re: /\bcounty\b/, val: p.county },
      { re: /\bstate\b|province|region/, val: p.state },
      { re: /\bcountry\b|nation/, val: p.country },
      { re: /\bcity\b|town|locality|current location|based in|where.*located|location/, val: p.city || p.location },
      // — Links —
      { re: /linkedin/, val: p.linkedin },
      { re: /github/, val: p.github || p.website },
      { re: /portfolio|personal (site|website)|website|web site|\burl\b|homepage/, val: p.website },
      { re: /twitter|\bx\.com|social/, val: p.twitter },
      // — Work history (most-recent role) —
      { re: /current employer|company name|employer name|employer|organization name|company\b/, val: p.currentEmployer },
      { re: /current title|job title|current (role|position)|position title|title\b/, val: p.currentTitle },
      { re: /responsibilities|job description|role description|describe your role|duties/, val: p.roleSummary, textareaOnly: true },
      // — Education —
      { re: /school|university|college|institution|alma mater/, val: p.school },
      { re: /degree|qualification|education level/, val: p.degree },
      { re: /field of study|major|concentration|discipline/, val: p.major || p.degree },
      { re: /\bgpa\b|grade point/, val: p.gpa },
      { re: /graduat|grad year|year of (completion|graduation)|expected (completion|graduation)|completion (year|date)/, val: p.gradYear },
      // — Screening / logistics —
      { re: /desired salary|salary expectation|expected (salary|pay|compensation)|compensation|desired pay|pay expectation|expected ctc|hourly rate|\brate\b/, val: p.salary },
      { re: /years.*experience|experience.*years|\byoe\b|total experience/, val: p.years },
      { re: /notice period|start date|availability|when.*(start|available)|earliest.*(start|available)|available to start/, val: p.notice },
      { re: /willing to relocate|open to relocat|relocat/, val: p.relocate },
      { re: /willing to travel|able to travel|travel/, val: p.travel },
      { re: /how did you (hear|find|learn)|referr(al|ed)|source|hear about/, val: p.source || "LinkedIn" },
      { re: /tools|software|technolog|proficien|technical skills|\bskills\b/, val: p.tools, textareaOnly: true },
      { re: /cover letter|why.*(you|interest|role|company)|message to|motivat|additional (info|information)|tell us|anything else|comments/, val: ctx.cover, textareaOnly: true },
    ];
  }

  // ── Field-memory helpers (adaptive learning) ──────────────────────
  function keyOf(label) {
    return (label || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  }
  function groupLabel(el) {
    const g = el.closest("fieldset, [role='radiogroup'], [class*='question'], [class*='form-group'], [data-automation-id*='formField']");
    if (g) {
      const l = g.querySelector("legend, label, .label, [class*='label'], [id$='-label']");
      if (l && !l.contains(el)) return (l.innerText || "").trim();
      // fallback: the group's leading text minus option text
      const t = (g.innerText || "").trim();
      if (t) return t.split("\n")[0];
    }
    return "";
  }
  // Sensitive labels we never store into learned memory.
  function isSensitive(lab) {
    return /gender|race|ethnic|veteran|disab|hispanic|latino|sexual|ssn|social security|date of birth|\bdob\b|password/.test(lab);
  }

  function fillYesNo(profile) {
    let n = 0;
    const groups = document.querySelectorAll("fieldset, [role='radiogroup'], [class*='question'], [class*='field']");
    groups.forEach((g) => {
      const t = (g.innerText || "").toLowerCase();
      let want = null;
      if (/authoriz(ed|ation) to work|legally.*work|right to work|work permit/.test(t)) want = profile.workAuth;
      else if (/sponsor|visa/.test(t)) want = profile.sponsorship;
      // Only answer if the user has explicitly set a value (true/false) — never guess.
      if (want !== true && want !== false) return;
      const wantText = want ? "yes" : "no";
      const radios = g.querySelectorAll("input[type=radio]");
      for (const r of radios) {
        const lab = labelText(r);
        if ((wantText === "yes" && /\byes\b/.test(lab)) || (wantText === "no" && /\bno\b/.test(lab))) {
          if (!r.checked) { r.click(); n++; }
          break;
        }
      }
      const sel = g.querySelector("select");
      if (sel && !sel.value) { if (selectMatch(sel, wantText)) n++; }
    });
    return n;
  }

  // Respectfully decline demographic / EEO self-identification (never fabricate).
  function fillEEO() {
    let n = 0;
    const demo = /gender|race|ethnic|veteran|disab|hispanic|latino/;
    const decline = /decline|prefer not|don.?t wish|do not wish|not to answer|not to disclose|not to identify/i;
    document.querySelectorAll("select").forEach((sel) => {
      const lab = labelText(sel);
      if (!demo.test(lab) || sel.value) return;
      for (const opt of sel.options) { if (decline.test(opt.text)) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); n++; break; } }
    });
    const seen = new Set();
    document.querySelectorAll("input[type=radio]").forEach((r) => {
      const q = (groupLabel(r) || labelText(r)).toLowerCase();
      if (!demo.test(q)) return;
      const k = keyOf(q); if (seen.has(k)) return; seen.add(k);
      const radios = Array.from(document.querySelectorAll('input[type=radio][name="' + (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name) + '"]'));
      if (radios.some((x) => x.checked)) return;
      for (const x of radios) { if (decline.test(labelText(x))) { x.click(); n++; break; } }
    });
    return n;
  }

  // Apply learned radio/select choices by matching the remembered question.
  function applyLearnedChoices(learned) {
    let n = 0;
    const groups = new Map();
    document.querySelectorAll("input[type=radio]").forEach((r) => {
      const k = keyOf(groupLabel(r) || labelText(r));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    for (const [k, radios] of groups) {
      const L = learned[k];
      if (!L || L.type !== "choice") continue;
      if (radios.some((r) => r.checked)) continue;
      const want = String(L.value).toLowerCase();
      for (const r of radios) { if (labelText(r).includes(want)) { r.click(); n++; break; } }
    }
    return n;
  }

  function autofill(profile, ctx, learned) {
    learned = learned || {};
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
      const key = keyOf(lab);
      // 1) learned value from a previous application wins
      const L = learned[key];
      if (L && L.type === "value" && L.value) {
        if (el.tagName === "SELECT") { if (selectMatch(el, L.value)) { filled++; continue; } }
        else { setNative(el, L.value); flash(el); filled++; continue; }
      }
      // 2) built-in rules
      for (const r of rules) {
        if (r.textareaOnly && el.tagName !== "TEXTAREA") continue;
        if (r.val && r.re.test(lab)) {
          if (el.tagName === "SELECT") { if (selectMatch(el, r.val)) filled++; }
          else { setNative(el, r.val); filled++; flash(el); }
          break;
        }
      }
    }
    filled += applyLearnedChoices(learned);
    filled += fillYesNo(profile);
    filled += fillEEO();
    return filled;
  }

  // Snapshot every answered field so unknown ones are remembered for next time.
  function collectAnswers() {
    const out = {};
    const fields = Array.from(document.querySelectorAll("input, textarea, select"));
    for (const el of fields) {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "file", "password", "submit", "button"].includes(type)) continue;
      const lab = labelText(el);
      if (!lab || isSensitive(lab)) continue;
      if (type === "radio") {
        if (el.checked) { const q = groupLabel(el) || lab; out[keyOf(q)] = { label: q, type: "choice", value: (labelText(el) || "").slice(0, 60) }; }
      } else if (type === "checkbox") {
        // skip — consent boxes shouldn't be auto-restored
      } else if (el.tagName === "SELECT") {
        if (el.value) { const t = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value; out[keyOf(lab)] = { label: lab, type: "value", value: t.trim() }; }
      } else {
        if (el.value && el.value.trim()) out[keyOf(lab)] = { label: lab, type: "value", value: el.value.trim() };
      }
    }
    return out;
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
    if (msg.type === "autofill") {
      // Merge learned answers from storage (source of truth) with any passed in.
      chrome.storage.local.get([LEARN_KEY, PROFILE_KEY], (d) => {
        const learned = Object.assign({}, d[LEARN_KEY] || {}, msg.learned || {});
        const profile = msg.profile || d[PROFILE_KEY] || {};
        send({ filled: autofill(profile, { cover: msg.cover || "" }, learned) });
      });
      return true;
    }
    if (msg.type === "learn") {
      const answers = collectAnswers();
      chrome.storage.local.get([LEARN_KEY], (d) => {
        chrome.storage.local.set({ [LEARN_KEY]: Object.assign({}, d[LEARN_KEY] || {}, answers) });
      });
      send({ answers });
      return true;
    }
    if (msg.type === "attachResume") { send({ attached: attachResume(msg.pdfBase64, msg.filename) }); return true; }
    if (msg.type === "ping") { send({ ok: true }); return true; }
    return false;
  });

  // ── Automatic learning ────────────────────────────────────────────
  // Whenever the user edits a field, remember it (label -> value, or
  // question -> chosen option) so it auto-fills on the next application.
  // No button needed. Sensitive fields are never stored.
  function autoLearn(el) {
    if (!el || !el.matches || !el.matches("input, textarea, select")) return;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "file", "password", "submit", "button", "checkbox"].includes(type)) return;
    const lab = labelText(el);
    if (!lab || isSensitive(lab)) return;
    let key, entry;
    if (type === "radio") {
      if (!el.checked) return;
      const q = groupLabel(el) || lab; key = keyOf(q);
      entry = { label: q, type: "choice", value: (labelText(el) || "").slice(0, 60) };
    } else if (el.tagName === "SELECT") {
      if (!el.value) return;
      const t = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value;
      key = keyOf(lab); entry = { label: lab, type: "value", value: (t || "").trim() };
    } else {
      const v = (el.value || "").trim();
      if (!v || v.length > 250) return;
      key = keyOf(lab); entry = { label: lab, type: "value", value: v };
    }
    if (!key) return;
    try {
      chrome.storage.local.get([LEARN_KEY], (d) => {
        const L = d[LEARN_KEY] || {};
        if (JSON.stringify(L[key]) === JSON.stringify(entry)) return;
        L[key] = entry;
        chrome.storage.local.set({ [LEARN_KEY]: L });
      });
    } catch (e) { /* extension reloaded — context gone; ignore */ }
  }
  document.addEventListener("change", (e) => autoLearn(e.target), true);
  document.addEventListener("focusout", (e) => autoLearn(e.target), true);
})();
