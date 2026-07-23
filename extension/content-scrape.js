/* content-scrape.js — reads the job posting / listings from the Indeed or
   LinkedIn page the user is currently viewing, on request from the side panel.

   Selectors on these sites change often, so every extractor tries several
   candidates and falls back to a generic "largest readable text block" so it
   degrades instead of breaking. Nothing is sent anywhere except back to the
   extension side panel. */
(function () {
  "use strict";

  function txt(el) { return el ? (el.innerText || el.textContent || "").trim() : ""; }
  function first(sels) {
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = txt(el);
      if (t) return t;
    }
    return "";
  }

  function largestTextBlock() {
    let best = "";
    document.querySelectorAll("article, section, main div, div").forEach((el) => {
      const t = el.innerText || "";
      if (t.length > best.length && t.length < 30000) best = t;
    });
    return best.trim();
  }

  function getJob() {
    const host = location.hostname;
    let title = "", company = "", loc = "", desc = "";

    if (host.includes("linkedin")) {
      title = first([
        "h1.job-details-jobs-unified-top-card__job-title",
        ".job-details-jobs-unified-top-card__job-title h1",
        ".job-details-jobs-unified-top-card__job-title",
        "h1.topcard__title", ".topcard__title", "h1",
      ]);
      company = first([
        ".job-details-jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name",
        ".topcard__org-name-link", "a.topcard__org-name-link",
      ]);
      loc = first([
        ".job-details-jobs-unified-top-card__primary-description-container",
        ".jobs-unified-top-card__bullet", ".topcard__flavor--bullet",
      ]);
      desc = first([
        "#job-details", ".jobs-description__content .jobs-box__html-content",
        ".jobs-description-content__text", ".jobs-description__content",
        ".show-more-less-html__markup", ".description__text",
      ]);
    } else if (host.includes("indeed")) {
      title = first([
        '[data-testid="jobsearch-JobInfoHeader-title"]',
        "h1.jobsearch-JobInfoHeader-title", "h2.jobTitle span", "h1",
      ]);
      company = first([
        '[data-testid="inlineHeader-companyName"] a',
        '[data-testid="inlineHeader-companyName"]',
        '[data-testid="company-name"]',
        ".jobsearch-CompanyInfoContainer a",
      ]);
      loc = first([
        '[data-testid="inlineHeader-companyLocation"]',
        '[data-testid="job-location"]',
        ".jobsearch-JobInfoHeader-subtitle div:last-child",
      ]);
      desc = first(["#jobDescriptionText", ".jobsearch-jobDescriptionText", '[id^="jobDescription"]']);
    }

    if (!desc || desc.length < 120) {
      const fb = largestTextBlock();
      if (fb.length > desc.length) desc = fb;
    }
    if (!title) title = (document.title || "").split(/[|\-–]/)[0].trim();

    return { title, company, location: loc, description: desc, url: location.href.split("?")[0], source: host.includes("linkedin") ? "linkedin" : host.includes("indeed") ? "indeed" : "web" };
  }

  function getListings() {
    const host = location.hostname;
    const out = [];
    const seen = new Set();
    const push = (o) => {
      if (!o.title) return;
      const k = (o.url || o.title + "|" + o.company).toLowerCase();
      if (seen.has(k)) return; seen.add(k); out.push(o);
    };

    if (host.includes("linkedin")) {
      document.querySelectorAll(
        ".job-card-container, li.scaffold-layout__list-item, .jobs-search-results__list-item, div.base-card"
      ).forEach((c) => {
        const t = c.querySelector(".job-card-list__title, .job-card-container__link, a.job-card-list__title--link, .base-search-card__title");
        const co = c.querySelector(".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .base-search-card__subtitle");
        const lo = c.querySelector(".job-card-container__metadata-item, .job-search-card__location");
        const a = c.querySelector("a[href*='/jobs/view/'], a.base-card__full-link");
        push({ title: txt(t), company: txt(co), location: txt(lo), url: a ? a.href.split("?")[0] : "" });
      });
    } else if (host.includes("indeed")) {
      document.querySelectorAll(".job_seen_beacon, [data-testid='slider_item'], .result, .cardOutline").forEach((c) => {
        const t = c.querySelector("h2.jobTitle span, a.jcs-JobTitle span, [data-testid='job-title'], h2.jobTitle");
        const co = c.querySelector("[data-testid='company-name'], .companyName");
        const lo = c.querySelector("[data-testid='text-location'], .companyLocation");
        const a = c.querySelector("a.jcs-JobTitle, h2.jobTitle a, a[data-jk]");
        let url = a ? a.href : "";
        const jk = a && a.getAttribute("data-jk");
        if (!url && jk) url = "https://www.indeed.com/viewjob?jk=" + jk;
        push({ title: txt(t), company: txt(co), location: txt(lo), url });
      });
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (msg && msg.type === "getJob") { send(getJob()); return true; }
    if (msg && msg.type === "getListings") { send(getListings()); return true; }
    return false;
  });
})();
