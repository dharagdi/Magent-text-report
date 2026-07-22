"""Render a Resume to ATS-friendly PDF, plain text, and HTML.

Filenames are derived from the job (Company_Role) so every export is named
after the JD, e.g.  Acme-Corp_Senior-Python-Engineer.pdf
"""
from __future__ import annotations

import os
import re
import html
from typing import List, Optional

from .models import Resume, JobPosting
from .pdfwriter import PDF, save_pdf


# --------------------------------------------------------------------------- #
# Filename helpers
# --------------------------------------------------------------------------- #
def slugify(s: str, maxlen: int = 60) -> str:
    s = (s or "").strip()
    s = re.sub(r"[^\w\s-]", "", s)          # drop punctuation
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return s[:maxlen] or "untitled"


def job_basename(job: JobPosting, resume_name: str = "") -> str:
    """Company_Role[_Name] basename (no extension), derived from the JD."""
    company = slugify(job.company) if job.company else ""
    role = slugify(job.title) if job.title else "resume"
    parts = [p for p in (company, role) if p]
    base = "_".join(parts) if parts else "resume"
    if resume_name:
        base += "_" + slugify(resume_name, 30)
    return base


# --------------------------------------------------------------------------- #
# Plain text (the most ATS-safe format)
# --------------------------------------------------------------------------- #
def to_text(r: Resume) -> str:
    L: List[str] = []
    L.append(r.name)
    if r.title:
        L.append(r.title)
    contact = " | ".join(x for x in [r.email, r.phone, r.location, *r.links] if x)
    if contact:
        L.append(contact)
    L.append("")
    if r.summary:
        L.append("SUMMARY")
        L.append(r.summary)
        L.append("")
    if r.skills:
        L.append("SKILLS")
        L.append(", ".join(r.skills))
        L.append("")
    if r.experience:
        L.append("EXPERIENCE")
        for e in r.experience:
            head = " | ".join(x for x in [e.title, e.company, e.location] if x)
            dates = " - ".join(x for x in [e.start, e.end] if x)
            L.append(head + (f"   ({dates})" if dates else ""))
            for b in e.bullets:
                L.append(f"  - {b}")
            L.append("")
    if r.projects:
        L.append("PROJECTS")
        for p in r.projects:
            L.append(f"  - {p}")
        L.append("")
    if r.education:
        L.append("EDUCATION")
        for ed in r.education:
            head = " | ".join(x for x in [ed.degree, ed.school, ed.location, ed.year] if x)
            L.append(head)
            if ed.details:
                L.append(f"  {ed.details}")
        L.append("")
    if r.certifications:
        L.append("CERTIFICATIONS")
        L.append(", ".join(r.certifications))
        L.append("")
    return "\n".join(L).rstrip() + "\n"


# --------------------------------------------------------------------------- #
# HTML (nice to preview / print)
# --------------------------------------------------------------------------- #
def to_html(r: Resume) -> str:
    e = html.escape
    contact = " &nbsp;•&nbsp; ".join(e(x) for x in [r.email, r.phone, r.location, *r.links] if x)
    blocks = []
    if r.summary:
        blocks.append(f"<section><h2>Summary</h2><p>{e(r.summary)}</p></section>")
    if r.skills:
        chips = "".join(f"<span class='chip'>{e(s)}</span>" for s in r.skills)
        blocks.append(f"<section><h2>Skills</h2><div class='chips'>{chips}</div></section>")
    if r.experience:
        items = []
        for x in r.experience:
            head = e(" — ".join(p for p in [x.title, x.company] if p))
            meta = e(" | ".join(p for p in [x.location, " - ".join(d for d in [x.start, x.end] if d)] if p))
            bl = "".join(f"<li>{e(b)}</li>" for b in x.bullets)
            items.append(f"<div class='exp'><div class='exp-h'>{head}"
                         f"<span class='meta'>{meta}</span></div><ul>{bl}</ul></div>")
        blocks.append("<section><h2>Experience</h2>" + "".join(items) + "</section>")
    if r.projects:
        li = "".join(f"<li>{e(p)}</li>" for p in r.projects)
        blocks.append(f"<section><h2>Projects</h2><ul>{li}</ul></section>")
    if r.education:
        li = []
        for ed in r.education:
            head = e(" — ".join(p for p in [ed.degree, ed.school, ed.year] if p))
            det = f"<div class='meta'>{e(ed.details)}</div>" if ed.details else ""
            li.append(f"<div class='edu'>{head}{det}</div>")
        blocks.append("<section><h2>Education</h2>" + "".join(li) + "</section>")
    if r.certifications:
        blocks.append("<section><h2>Certifications</h2><p>"
                      + e(", ".join(r.certifications)) + "</p></section>")

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>{e(r.name)} — Resume</title>
<style>
  body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:760px;
       margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.45;}}
  h1{{margin:0;font-size:26px;}} .title{{color:#444;font-size:15px;margin:2px 0 6px;}}
  .contact{{color:#666;font-size:13px;margin-bottom:18px;}}
  h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1.5px solid #222;
      padding-bottom:3px;margin:22px 0 10px;}}
  .chips{{display:flex;flex-wrap:wrap;gap:6px;}}
  .chip{{background:#eef2f7;border:1px solid #dce3ec;border-radius:4px;padding:2px 8px;font-size:12.5px;}}
  .exp{{margin-bottom:12px;}} .exp-h{{font-weight:600;font-size:14px;}}
  .meta{{color:#777;font-weight:400;font-size:12.5px;margin-left:8px;}}
  ul{{margin:4px 0 0 18px;}} li{{margin:2px 0;font-size:13.5px;}}
  .edu{{margin-bottom:6px;font-size:14px;}}
</style></head><body>
<h1>{e(r.name)}</h1>
{f'<div class="title">{e(r.title)}</div>' if r.title else ''}
<div class="contact">{contact}</div>
{''.join(blocks)}
</body></html>"""


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #
def to_pdf(r: Resume, path: str) -> None:
    pdf = PDF()
    contact = [" | ".join(x for x in [r.email, r.phone, r.location] if x)]
    if r.links:
        contact.append(" | ".join(r.links))
    header_name = r.name or "Resume"
    pdf.title_block(header_name, [c for c in contact if c])
    if r.title:
        pdf.paragraph(r.title, size=10.5, bold=True, gap=4)

    if r.summary:
        pdf.heading("Summary")
        pdf.paragraph(r.summary, size=10)
    if r.skills:
        pdf.heading("Skills")
        pdf.paragraph(", ".join(r.skills), size=10)
    if r.experience:
        pdf.heading("Experience")
        for e in r.experience:
            head = "  |  ".join(x for x in [e.title, e.company, e.location] if x)
            dates = " - ".join(x for x in [e.start, e.end] if x)
            pdf.paragraph(head + (f"   ({dates})" if dates else ""),
                          size=10.5, bold=True, gap=1)
            for b in e.bullets:
                pdf.bullet(b, size=10)
            pdf.space(3)
    if r.projects:
        pdf.heading("Projects")
        for p in r.projects:
            pdf.bullet(p, size=10)
    if r.education:
        pdf.heading("Education")
        for ed in r.education:
            head = "  |  ".join(x for x in [ed.degree, ed.school, ed.location, ed.year] if x)
            pdf.paragraph(head, size=10.5, bold=True, gap=1)
            if ed.details:
                pdf.paragraph(ed.details, size=9.5, indent=4)
    if r.certifications:
        pdf.heading("Certifications")
        pdf.paragraph(", ".join(r.certifications), size=10)

    save_pdf(pdf, path)


# --------------------------------------------------------------------------- #
# Orchestrator: write all requested formats, named after the JD.
# --------------------------------------------------------------------------- #
def export_resume(resume: Resume, job: JobPosting, out_dir: str,
                  formats=("pdf", "txt"), name_with_candidate=False) -> List[str]:
    os.makedirs(out_dir, exist_ok=True)
    base = job_basename(job, resume.name if name_with_candidate else "")
    written: List[str] = []
    for fmt in formats:
        path = os.path.join(out_dir, f"{base}.{fmt}")
        if fmt == "pdf":
            to_pdf(resume, path)
        elif fmt == "txt":
            with open(path, "w", encoding="utf-8") as f:
                f.write(to_text(resume))
        elif fmt == "html":
            with open(path, "w", encoding="utf-8") as f:
                f.write(to_html(resume))
        else:
            continue
        written.append(path)
    return written
