/* sidepanel.js — glue between the page (content scripts) and the shared engine.
   Reuses engine.js: parseJD, atsScore, tailor, buildResumePdfBytes, jobBasename,
   coverBlurb, stripLatex, parseResumeText, extractPdfText, looksLikeText, grade. */
"use strict";

const RESUME_KEY = "ja_resume_v1";
const PROFILE_KEY = "ja_profile_v1";
const LEARN_KEY = "ja_learned_v1";

let master = null;      // base resume object (with .raw)
let profile = {};       // autofill profile
let learned = {};       // { fieldKey: {label, type:'value'|'choice', value} }
let state = {};         // { job, tailored, before, after, pdfBytes, cover }

const $ = (id) => document.getElementById(id);
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200); }
function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ── storage ─────────────────────────────────────────────── */
async function load() {
  const d = await chrome.storage.local.get([RESUME_KEY, PROFILE_KEY, LEARN_KEY]);
  master = d[RESUME_KEY] || null;
  profile = d[PROFILE_KEY] || {};
  learned = d[LEARN_KEY] || {};
  if (master && !Object.keys(profile).length) profile = profileFromResume(master);
  fillProfileForm();
  refreshResumeState();
  updateLearnCount();
}
function profileFromResume(r) {
  const links = r.links || [];
  const exp0 = (r.experience || [])[0] || {};
  const edu0 = (r.education || [])[0] || {};
  return {
    name: r.name || "", email: r.email || "", phone: r.phone || "", location: r.location || "",
    linkedin: links.find((l) => /linkedin/i.test(l)) || "",
    website: links.find((l) => !/linkedin/i.test(l)) || "",
    currentEmployer: exp0.company || "", currentTitle: exp0.title || "",
    school: edu0.school || "", degree: edu0.degree || "", gradYear: edu0.year || "",
    tools: (r.skills || []).slice(0, 12).join(", "),
    salary: "", years: "", notice: "", workAuth: null, sponsorship: null,
  };
}
function updateLearnCount() {
  const n = Object.keys(learned || {}).length;
  const el = $("learnCount");
  if (el) { el.textContent = n ? n + " learned" : ""; el.className = "badge " + (n ? "ok" : "no"); }
}
function refreshResumeState() {
  const has = master && master.name;
  $("resumeWarn").style.display = has ? "none" : "flex";
}

/* ── tabs ────────────────────────────────────────────────── */
document.querySelectorAll("#seg button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#seg button").forEach((x) => x.classList.toggle("active", x === b));
  $("tab-apply").style.display = b.dataset.tab === "apply" ? "block" : "none";
  $("tab-resume").style.display = b.dataset.tab === "resume" ? "block" : "none";
}));
document.querySelectorAll("#impSeg button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#impSeg button").forEach((x) => x.classList.toggle("active", x === b));
  $("impPaste").style.display = b.dataset.imp === "paste" ? "block" : "none";
  $("impUpload").style.display = b.dataset.imp === "upload" ? "block" : "none";
}));

/* ── resume import ───────────────────────────────────────── */
const SAMPLE = { name: "Jordan A. Rivera", title: "Senior Software Engineer", email: "jordan.rivera@example.com", phone: "+1 (555) 013-2049", location: "Austin, TX (open to remote)", links: ["linkedin.com/in/jordanrivera", "github.com/jrivera"], summary: "Backend-focused software engineer with 8 years building scalable services and data platforms.", skills: ["Python", "Go", "PostgreSQL", "Docker", "Kubernetes", "AWS", "Terraform", "CI/CD", "REST APIs", "GraphQL", "Kafka", "Microservices", "System Design"], experience: [{ title: "Senior Software Engineer", company: "Northwind Data", location: "Remote", start: "2021", end: "Present", bullets: ["Designed a microservices platform on Kubernetes serving 12M requests/day.", "Built Kafka + Python pipelines processing 2TB/day.", "Introduced CI/CD with GitHub Actions cutting deploy time 40m to 6m."] }], education: [{ degree: "B.S. Computer Science", school: "UT Austin", year: "2016", details: "" }], certifications: ["AWS Solutions Architect", "CKAD"], projects: [] };

function importFromText(text, label) {
  const cleaned = stripLatex(text);
  const parsed = parseResumeText(cleaned);
  parsed.raw = cleaned;
  master = parsed;
  chrome.storage.local.set({ [RESUME_KEY]: master });
  if (!Object.keys(profile).filter((k) => profile[k]).length || !profile.name) {
    profile = profileFromResume(parsed); fillProfileForm(); chrome.storage.local.set({ [PROFILE_KEY]: profile });
  }
  const box = $("impMsg"); box.className = "msg ok";
  box.innerHTML = `<span><b>Imported${label ? " from " + esc(label) : ""}.</b> ${parsed.name ? "“" + esc(parsed.name) + "”, " : ""}${(parsed.skills || []).length} skills, ${(parsed.experience || []).length} role(s). Check the Autofill profile below.</span>`;
  refreshResumeState();
  toast("Base resume saved");
}
function importWarn(m) { const box = $("impMsg"); box.className = "msg warn"; box.innerHTML = `<span>${m}</span>`; }

$("usePaste").addEventListener("click", () => {
  const t = $("pasteBox").value.trim();
  if (t.length < 30) { importWarn("Too short — paste your full resume text."); return; }
  importFromText(t, "pasted text");
});
$("loadSample").addEventListener("click", () => { $("pasteBox").value = JSON.stringify(SAMPLE, null, 2).replace(/[{}"]/g, "").replace(/,\n/g, "\n"); importFromText(sampleToText(SAMPLE), "sample"); });
function sampleToText(r) { return resumeToText(r); }

async function handleFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".pdf")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const text = extractPdfText(buf);
      if (looksLikeText(text)) importFromText(text, file.name);
      else importWarn(`Couldn't read text from <b>${esc(file.name)}</b> (unusual/scanned fonts). Switch to <b>Paste</b> and paste the text.`);
    } else if (name.endsWith(".docx")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const text = extractDocxText(buf);
      if (looksLikeText(text)) importFromText(text, file.name);
      else importWarn(`Couldn't read <b>${esc(file.name)}</b>. If it's an old .doc, re-save as .docx or paste the text.`);
    } else {
      const text = await file.text();
      if (text.trim().length < 30) { importWarn("That file looks empty."); return; }
      importFromText(text, file.name);
    }
  } catch (e) { importWarn("Couldn't read that file: " + esc(String(e.message || e))); }
}
$("fileInput").addEventListener("change", (e) => handleFile(e.target.files[0]));
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = ""; }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

/* ── profile ─────────────────────────────────────────────── */
const PF = ["name", "email", "phone", "location", "linkedin", "website", "salary", "years", "notice",
  "address", "city", "state", "postal", "country", "source",
  "currentEmployer", "currentTitle", "school", "degree", "gradYear", "tools"];
function triVal(v) { return v === true ? "true" : v === false ? "false" : ""; }
function parseTri(s) { return s === "true" ? true : s === "false" ? false : null; }
function fillProfileForm() {
  PF.forEach((k) => { const el = $("p_" + k); if (el) el.value = profile[k] || ""; });
  $("p_workAuth").value = triVal(profile.workAuth);
  $("p_sponsorship").value = triVal(profile.sponsorship);
}
$("saveProfile").addEventListener("click", () => {
  PF.forEach((k) => { const el = $("p_" + k); if (el) profile[k] = el.value.trim(); });
  profile.workAuth = parseTri($("p_workAuth").value);
  profile.sponsorship = parseTri($("p_sponsorship").value);
  chrome.storage.local.set({ [PROFILE_KEY]: profile });
  toast("Profile saved");
});

// Export / import the whole setup (resume + profile + learned answers).
$("exportProfile").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ resume: master, profile, learnedFields: learned }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = "jobapplier-profile.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
  toast("Profile exported");
});
$("importProfile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.resume) { master = d.resume; chrome.storage.local.set({ [RESUME_KEY]: master }); }
    if (d.profile) { profile = d.profile; chrome.storage.local.set({ [PROFILE_KEY]: profile }); }
    if (d.learnedFields) { learned = d.learnedFields; chrome.storage.local.set({ [LEARN_KEY]: learned }); }
    fillProfileForm(); refreshResumeState(); updateLearnCount();
    toast("Profile imported");
  } catch (err) { toast("Couldn't read that JSON"); }
});

/* ── tab messaging helpers ───────────────────────────────── */
async function getActiveTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
async function sendToTab(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (e) {
    try { await chrome.runtime.sendMessage({ type: "ensureScripts", tabId }); }
    catch (_) {}
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}
async function detectSite() {
  const t = await getActiveTab();
  const url = (t && t.url) || "";
  const badge = $("siteBadge");
  if (/linkedin\.com/.test(url)) { badge.textContent = "LinkedIn"; badge.className = "badge ok"; }
  else if (/indeed\./.test(url)) { badge.textContent = "Indeed"; badge.className = "badge ok"; }
  else { badge.textContent = "other page"; badge.className = "badge no"; }
}

/* ── pull job + score ────────────────────────────────────── */
$("pullJob").addEventListener("click", async () => {
  if (!(master && master.name)) { toast("Import a base resume first"); return; }
  const tab = await getActiveTab();
  let job;
  try { job = await sendToTab(tab.id, { type: "getJob" }); }
  catch (e) { toast("Can't read this tab — open a LinkedIn/Indeed job page"); return; }
  if (!job || (!job.description && !job.title)) { toast("No job found on this page"); return; }
  state.job = job;
  $("jTitle").textContent = job.title || "(untitled role)";
  $("jCompany").textContent = [job.company, job.location].filter(Boolean).join(" · ");
  const jd = parseJD(job.description || "", job.title);
  const before = atsScore(master, jd);
  state.jd = jd; state.before = before;
  showScore(before.score, null);
  $("jobBox").style.display = "block";
  $("resultCard").style.display = "none";
  $("applyCard").style.display = "none";
  toast("Job pulled — ATS " + before.score + "/100");
});
function showScore(score, deltaFrom) {
  $("jScore").textContent = Math.round(score);
  const g = grade(score);
  const col = score >= 70 ? "good" : score >= 55 ? "warn" : "crit";
  const p = $("jGrade"); p.textContent = "Grade " + g;
  p.style.background = `var(--${col}-bg)`; p.style.color = `var(--${col === "crit" ? "crit" : col + "-ink"})`;
  $("jScore").style.color = `var(--${col === "crit" ? "crit" : col})`;
  $("jDelta").textContent = deltaFrom != null ? `${deltaFrom} → ${score} after tailoring` : "before tailoring";
}

/* ── tailor ──────────────────────────────────────────────── */
function renderResult() {
  const { job, after } = state;
  $("matchKw").innerHTML = after.matched.slice(0, 24).map((k) => `<span class="kw m">${esc(k)}</span>`).join("") || `<span class="hint">none</span>`;
  $("missKw").innerHTML = after.missing.filter(([k]) => k.length > 2).slice(0, 16).map(([k]) => `<span class="kw x">${esc(k)}</span>`).join("") || `<span class="hint">nothing missing 🎉</span>`;
  $("fname").textContent = "Saves as: " + jobBasename(job) + ".pdf";
}
$("tailorBtn").addEventListener("click", () => {
  const { job, jd, before } = state;
  const tailored = tailor(master, jd);
  const after = atsScore(tailored, jd);
  state.tailored = tailored; state.after = after;
  state.pdfBytes = buildResumePdfBytes(tailored);
  state.cover = coverBlurb(tailored, job, after.matched);
  showScore(after.score, before.score);
  renderResult();
  $("resultCard").style.display = "block";
  $("applyCard").style.display = "block";
  renderChecklist();
  toast("Tailored — " + before.score + " → " + after.score);
});

$("dlPdf").addEventListener("click", () => {
  if (!state.pdfBytes) return;
  downloadBytes(state.pdfBytes, jobBasename(state.job) + ".pdf", "application/pdf");
  toast("PDF downloaded — attach it if auto-attach fails");
});
$("copyCover").addEventListener("click", () => { navigator.clipboard.writeText(state.cover || "").then(() => toast("Cover letter copied")); });

/* ── autofill + attach ───────────────────────────────────── */
async function doAutofill(tab) {
  const res = await sendToTab(tab.id, { type: "autofill", profile, cover: state.cover || "", learned });
  return (res && res.filled) || 0;
}
async function doAttach(tab) {
  if (!state.pdfBytes) return 0;
  const b64 = bytesToBase64(state.pdfBytes);
  const res = await sendToTab(tab.id, { type: "attachResume", pdfBase64: b64, filename: jobBasename(state.job) + ".pdf" });
  return (res && res.attached) || 0;
}
$("autofillBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    const n = await doAutofill(tab);
    const box = $("applyMsg"); box.className = n ? "msg ok" : "msg warn";
    box.innerHTML = n ? `<span>Filled ${n} field(s). Review them, then finish anything we couldn't match — and hit “Remember my answers” so we learn the rest.</span>`
      : `<span>No matching fields found on this page. If the apply form is in a popup/iframe, click into it first, or fill manually.</span>`;
  } catch (e) { $("applyMsg").className = "msg warn"; $("applyMsg").innerHTML = `<span>Couldn't reach the form on this tab. Make sure the application page/section is open.</span>`; }
});

$("rememberBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    const res = await sendToTab(tab.id, { type: "learn" });
    const answers = (res && res.answers) || {};
    let added = 0;
    for (const k in answers) { if (!(k in learned)) added++; learned[k] = answers[k]; }
    chrome.storage.local.set({ [LEARN_KEY]: learned });
    updateLearnCount();
    const box = $("applyMsg"); box.className = "msg ok";
    box.innerHTML = `<span>Remembered ${Object.keys(answers).length} answer(s) (${added} new). They'll auto-fill on your next application.</span>`;
  } catch (e) { $("applyMsg").className = "msg warn"; $("applyMsg").innerHTML = `<span>Couldn't read the form to learn from. Open the application first.</span>`; }
});

$("autoApplyBtn").addEventListener("click", async () => {
  if (!(master && master.name)) { toast("Import a base resume first"); return; }
  const tab = await getActiveTab();
  const box = $("applyMsg");
  try {
    // 1) pull JD
    const job = await sendToTab(tab.id, { type: "getJob" });
    if (!job || (!job.description && !job.title)) { toast("Open a LinkedIn/Indeed job page first"); return; }
    state.job = job;
    $("jTitle").textContent = job.title || "(untitled role)";
    $("jCompany").textContent = [job.company, job.location].filter(Boolean).join(" · ");
    $("jobBox").style.display = "block";
    // 2) tailor to match
    const jd = parseJD(job.description || "", job.title);
    const before = atsScore(master, jd);
    const tailored = tailor(master, jd);
    const after = atsScore(tailored, jd);
    state.jd = jd; state.before = before; state.after = after; state.tailored = tailored;
    state.pdfBytes = buildResumePdfBytes(tailored);
    state.cover = coverBlurb(tailored, job, after.matched);
    showScore(after.score, before.score);
    renderResult();
    $("resultCard").style.display = "block"; $("applyCard").style.display = "block"; renderChecklist();
    // 3) autofill + 4) attach
    const filled = await doAutofill(tab);
    const attached = await doAttach(tab);
    box.className = "msg ok";
    box.innerHTML = `<span><b>Auto-applied.</b> Tailored ATS ${before.score}→${after.score}, filled ${filled} field(s), ${attached ? "attached the resume" : "resume ready to attach (Download if the uploader is custom)"}. Review everything, paste the cover letter, then <b>Submit</b>.</span>`;
    toast("Auto-apply done — review & submit");
  } catch (e) {
    box.className = "msg warn";
    box.innerHTML = `<span>Auto-apply couldn't reach this tab. Open the job's <b>apply</b> page (Easy Apply / company site) and try again, or use the buttons individually.</span>`;
  }
});
$("attachBtn").addEventListener("click", async () => {
  if (!state.pdfBytes) { toast("Tailor first"); return; }
  const tab = await getActiveTab();
  const b64 = bytesToBase64(state.pdfBytes);
  try {
    const res = await sendToTab(tab.id, { type: "attachResume", pdfBase64: b64, filename: jobBasename(state.job) + ".pdf" });
    const n = (res && res.attached) || 0;
    const box = $("applyMsg"); box.className = n ? "msg ok" : "msg info";
    box.innerHTML = n ? `<span>Attached the tailored resume to ${n} upload field.</span>`
      : `<span>This site uses a custom uploader we can't set directly. Click <b>Download tailored PDF</b> and attach it by hand.</span>`;
  } catch (e) { $("applyMsg").className = "msg info"; $("applyMsg").innerHTML = `<span>Couldn't attach automatically — use <b>Download tailored PDF</b> and attach it manually.</span>`; }
});
function bytesToBase64(bytes) { let bin = ""; const C = 8192; for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(bin); }

function renderChecklist() {
  const steps = [
    "Open the application form (Easy Apply / Apply on company site).",
    "Click <b>Autofill fields</b> — name, email, phone, links, screening Qs.",
    "Click <b>Attach resume</b> (or Download and attach it yourself).",
    "Paste the cover letter where offered (Copy cover letter).",
    "Review every field, then click the site's <b>Submit</b> — that stays your call.",
    "Come back and mark it applied in the web dashboard.",
  ];
  $("checklist").innerHTML = steps.map((s, i) => `<li><span class="n">${i + 1}</span><span>${s}</span></li>`).join("");
}

/* ── listings ────────────────────────────────────────────── */
$("pullListings").addEventListener("click", async () => {
  const tab = await getActiveTab();
  let list;
  try { list = await sendToTab(tab.id, { type: "getListings" }); }
  catch (e) { toast("Open an Indeed/LinkedIn search results page"); return; }
  const box = $("listings");
  if (!list || !list.length) { box.innerHTML = `<div class="hint" style="margin-top:8px;">No listings detected. Open a search results page and scroll a bit.</div>`; return; }
  box.innerHTML = list.slice(0, 25).map((j, i) => `
    <div class="listing"><div class="t">${esc(j.title)}</div><div class="c">${esc([j.company, j.location].filter(Boolean).join(" · "))}</div>
    ${j.url ? `<button class="btn sm sec" data-open="${i}">Open in tab →</button>` : ""}</div>`).join("");
  box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", async () => {
    const j = list[+b.dataset.open]; if (j.url) { await chrome.tabs.update(tab.id, { url: j.url }); toast("Opened — click “Pull job from this tab”"); }
  }));
});

/* ── init ────────────────────────────────────────────────── */
load();
detectSite();
chrome.tabs.onActivated.addListener(detectSite);
