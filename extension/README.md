# JobApplier — browser extension (Chrome / Edge)

Does the part a hosted web page **can't**: read the job you're viewing on
LinkedIn/Indeed, tailor + ATS-score your resume against it, then **autofill the
application form** and stage the tailored PDF — right on the page. You always
click the final **Submit** yourself.

## Why an extension (and the honest limits)

- A normal web page cannot read another site's content or fill its form fields
  (browser same-origin policy). Only an extension with permission for those
  domains can. That's this.
- **No Indeed/LinkedIn search API exists** publicly, and scraping their servers
  violates their Terms. So this doesn't "search" their servers — it reads the
  page **you** have open in **your** logged-in browser (normal browsing), and
  pulls the job/listings from it.
- **Auto-submit is intentionally not done** — it violates their ToS and gets
  accounts banned. The extension fills everything; you review and submit.
- **File auto-attach** works on standard upload fields (most company ATS:
  Greenhouse, Lever, Ashby, Workable). Some sites (and parts of LinkedIn/Indeed
  Easy Apply) use custom uploaders where the browser blocks scripted file
  selection — there, use **Download tailored PDF** and attach it by hand.

## Install (takes 1 minute)

1. Download/clone this repo so you have the `extension/` folder on disk.
2. Open **`chrome://extensions`** (or `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the **JobApplier** icon; click it to open the side panel.

To share with a friend: send them the `extension/` folder (or the repo) and the
same 5 steps. (A signed Chrome Web Store build can come later; load-unpacked
needs no review.)

## Use

1. **Resume tab** → paste or upload your base resume once (PDF / LaTeX / text).
   Check the **Autofill profile** (name, email, phone, links, work
   authorization, salary, notice) and **Save profile**.
2. Open a **job on LinkedIn or Indeed** → **Apply tab** → **Pull job from this
   tab**. You'll see the ATS score of your current resume vs that JD.
3. **Tailor my resume to this job** → see the before→after score, matched /
   missing keywords, and get the tailored PDF (named `Company_Role.pdf`).
4. Open the application form → **Autofill fields** → **Attach resume** (or
   download + attach) → paste the cover letter → **review** → **Submit**
   yourself.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content-script matches |
| `engine.js` | Shared engine (JD parse, ATS score, tailor, PDF, resume import) — same logic as the web app |
| `content-scrape.js` | Reads the job / listings from LinkedIn & Indeed pages |
| `content-autofill.js` | Fills form fields + attaches the resume on the page |
| `background.js` | Service worker: opens the side panel, injects scripts on demand |
| `sidepanel.html/js` | The panel UI + workflow |

## Privacy

Everything runs locally. Your resume, profile, and applications live in the
browser's extension storage — nothing is sent to any server.

## Notes on fragility

LinkedIn/Indeed change their HTML often, so the scrapers use several fallback
selectors and a "largest text block" backstop. If a pull ever comes back thin,
copy the JD text into the web dashboard's **Tailor & Apply** tab instead — same
engine, always works.
