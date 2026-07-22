"""Semi-automated apply assist.

We deliberately do NOT auto-submit on LinkedIn/Indeed/etc. (ToS + ban risk +
brittleness). Instead we produce an "apply package" that removes all the manual
busywork: the direct apply link, the exact resume file to upload, a
pre-written cover blurb, and answers to the common application-form questions,
plus a checklist. You paste/upload and click submit.

`build_apply_package` returns a dict; `write_package` drops a Markdown file
next to the resume so everything for a job lives together.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional

from .models import Resume, JobPosting
from .jd import ParsedJD
from .ats import ATSResult


COMMON_QUESTIONS = [
    "Are you legally authorized to work in this location?",
    "Will you now or in the future require sponsorship?",
    "Notice period / earliest start date",
    "Desired salary / compensation expectations",
    "Years of experience with the primary required skill",
    "How did you hear about this role?",
]


def cover_blurb(resume: Resume, job: JobPosting, jd: ParsedJD,
                matched: List[str]) -> str:
    role = job.title or jd.title_guess or "this role"
    company = job.company or "your team"
    strengths = ", ".join(matched[:5]) if matched else (", ".join(resume.skills[:5]))
    name = resume.name or "I"
    return (
        f"Dear Hiring Team at {company},\n\n"
        f"I'm excited to apply for {role}. My background in {strengths} maps "
        f"directly to what you're looking for. "
        f"{resume.summary.strip()} "
        f"I'd welcome the chance to bring this experience to {company}.\n\n"
        f"Best regards,\n{name}"
    )


def build_apply_package(resume: Resume, job: JobPosting, jd: ParsedJD,
                        ats: ATSResult, resume_files: List[str],
                        prefill: Optional[Dict[str, str]] = None) -> Dict:
    prefill = prefill or {}
    answers = {q: prefill.get(q, "") for q in COMMON_QUESTIONS}
    # sensible defaults from the resume where we can
    if not answers["Desired salary / compensation expectations"] and job.salary:
        answers["Desired salary / compensation expectations"] = f"In line with the posted range ({job.salary})"

    apply_url = job.apply_url or job.url
    return {
        "job_id": job.id,
        "company": job.company,
        "title": job.title,
        "apply_url": apply_url,
        "ats_score": ats.score,
        "ats_grade": ats.grade(),
        "resume_files": resume_files,
        "cover_letter": cover_blurb(resume, job, jd, ats.matched),
        "answers": answers,
        "still_missing_keywords": [k for k, _ in ats.missing[:10]],
        "checklist": [
            f"Open apply link: {apply_url or '(no direct URL — search the company site)'}",
            f"Upload resume: {resume_files[0] if resume_files else '(none generated)'}",
            "Paste cover letter (below) if a field is offered",
            "Answer screening questions (drafted below)",
            "Review, then submit",
            "Mark applied:  jobapplier status " + job.id + " --set applied",
        ],
    }


def render_package_md(pkg: Dict) -> str:
    L: List[str] = []
    L.append(f"# Apply package — {pkg['title']} @ {pkg['company']}")
    L.append("")
    L.append(f"- **ATS match:** {pkg['ats_score']}/100 (grade {pkg['ats_grade']})")
    L.append(f"- **Apply link:** {pkg['apply_url'] or 'N/A'}")
    L.append(f"- **Resume files:** " + ", ".join(pkg["resume_files"]) or "N/A")
    if pkg["still_missing_keywords"]:
        L.append(f"- **Consider adding (if true):** "
                 + ", ".join(pkg["still_missing_keywords"]))
    L.append("\n## Checklist")
    for i, step in enumerate(pkg["checklist"], 1):
        L.append(f"{i}. {step}")
    L.append("\n## Cover letter")
    L.append("```\n" + pkg["cover_letter"] + "\n```")
    L.append("\n## Screening answers (fill any blanks)")
    for q, a in pkg["answers"].items():
        L.append(f"- **{q}**  \n  {a or '_[your answer]_'}")
    L.append("")
    return "\n".join(L)


def write_package(pkg: Dict, out_dir: str, basename: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{basename}.apply.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(render_package_md(pkg))
    return path
