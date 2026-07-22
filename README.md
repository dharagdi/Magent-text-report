# jobapplier

A **persistent, ATS-focused job-application assistant**. Point it at a job (or let
it search for jobs), and for each one it will:

1. **Parse the JD** into weighted, ATS-relevant keywords.
2. **Tailor your master resume** to that JD — reordering skills, surfacing the
   keywords you genuinely have, foregrounding your most relevant bullets, and
   rewriting your summary. (Deterministic by default; uses Claude if available.)
3. **Score the match** the way an Applicant Tracking System would (keyword
   coverage + structure), before and after tailoring.
4. **Export an ATS-friendly resume** to **PDF / TXT / HTML**, named after the job
   — e.g. `CloudScale_Senior-Backend-Engineer.pdf`.
5. **Build an "apply package"** — the direct apply link, the resume file to
   upload, a drafted cover letter, and answers to the common screening questions.
6. **Track everything** in a local SQLite database so runs are **persistent and
   resumable** and no job is processed twice.

## A note on "apply to every job automatically on LinkedIn/Indeed"

The tool intentionally **does not auto-submit** applications on LinkedIn, Indeed,
or other portals. Automated applying **violates those platforms' Terms of
Service**, gets accounts banned, breaks on CAPTCHAs/login walls, and — by
carpet-bombing every listing with an auto-generated resume — actually *lowers*
your callback rate. Instead, jobapplier does all the hard intellectual work
(tailoring, scoring, PDF, cover letter, screening answers) and hands you a
ready-to-submit package. You click submit. This is the version that actually
works and keeps your accounts safe.

Job **search** uses only genuinely public, documented endpoints (Remotive,
RemoteOK, and per-company Greenhouse/Lever boards) — not login-walled scraping.

## Install

Pure Python, standard library only for the core (PDF writer, ATS engine,
tracker, deterministic tailoring). No mandatory third-party deps.

```bash
pip install -e .            # installs the `jobapplier` command
# optional, for higher-quality LLM tailoring:
pip install anthropic       # then set ANTHROPIC_API_KEY
# optional, if your master resume is YAML:
pip install pyyaml
```

Or run without installing: `python3 -m jobapplier ...`

## Quick start

```bash
# 0. Point at your master resume (truthful, complete — tailoring only surfaces
#    what's already here; it never fabricates).
export JOBAPPLIER_RESUME=examples/master_resume.yaml

# 1. Search public job boards and load matches into the tracker
jobapplier search "python backend engineer" --limit 15

# 2. End-to-end: search + tailor + score + export + apply-package, resumable
jobapplier run "python backend engineer" --out ./applications --min-score 60

# 3. See your pipeline
jobapplier list

# 4. After you submit one, record it
jobapplier status <JOB_ID> --set applied
```

### Working from a single JD (paste / file / URL)

```bash
# import a JD you already have, then tailor for it
jobapplier import --file jd.txt --company "Acme" --title "Senior Engineer"
jobapplier tailor <JOB_ID> -v

# or a public posting URL (fetches the page text)
jobapplier import --url "https://boards.greenhouse.io/acme/jobs/123"

# or score your master resume against a JD without tailoring
jobapplier score --jd jd.txt
```

### Company-specific boards (Greenhouse / Lever)

```bash
jobapplier search "engineer" --providers greenhouse --board stripe
jobapplier search "data"     --providers lever      --board netflix
```

## Commands

| Command | What it does |
|---|---|
| `search QUERY` | Pull postings from providers into the tracker |
| `import` | Add one JD (`--file` / `--text` / `--url`) |
| `tailor [JOB_ID]` | Tailor + score + export for one job (or ad-hoc `--jd`) |
| `run [QUERY]` | Search → process the whole pending queue (resumable) |
| `list` | Show the application pipeline (`--status` to filter) |
| `status JOB_ID` | Get, or `--set`, an application's status |
| `score` | ATS-score your master resume against a JD |

Global: `--db PATH` (default `~/.jobapplier/jobapplier.db`),
`--engine {auto,deterministic,claude}`, `--out DIR`, `--formats pdf,txt,html`.

## Your master resume

YAML or JSON. See [`examples/master_resume.yaml`](examples/master_resume.yaml).
Keep it **truthful and complete** — the tailoring engine only reorders and
surfaces what's already there. It will not invent employers, dates, or skills.

## How the pieces fit

```
search.py   providers (remotive/remoteok/greenhouse/lever) + import a JD
   │
tracker.py  SQLite: stores jobs + application status  ← persistence/resume
   │
jd.py       JD text → weighted keywords
   │
tailor.py   deterministic | claude  → tailored resume (no fabrication)
   │
ats.py      ATS score (weighted keyword recall + structure)
   │
render.py   → PDF/TXT/HTML named Company_Role, via pdfwriter.py (pure-Python)
   │
apply.py    apply package: link + resume + cover letter + screening answers
```

## Tests

```bash
python3 -m pytest tests/ -q
```

## License

MIT
