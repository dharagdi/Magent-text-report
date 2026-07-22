"""ATS scoring: how well does a resume match a parsed JD?

Simulates the keyword-coverage logic real Applicant Tracking Systems use:
a weighted recall of JD keywords found in the resume text, plus structural
checks ATS parsers care about (contact info, standard sections, no exotic
formatting). Pure stdlib.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from .jd import ParsedJD
from .models import Resume

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.#/-]*")


def resume_text(resume: Resume) -> str:
    """Flatten a resume into the plain text an ATS would extract."""
    parts: List[str] = [
        resume.name, resume.title, resume.summary,
        " ".join(resume.skills),
        " ".join(resume.certifications),
        " ".join(resume.projects),
    ]
    for e in resume.experience:
        parts += [e.title, e.company, " ".join(e.bullets)]
    for ed in resume.education:
        parts += [ed.degree, ed.school, ed.details]
    return "\n".join(p for p in parts if p)


def _contains(haystack_lower: str, keyword: str) -> bool:
    pat = r"(?<![A-Za-z0-9])" + re.escape(keyword) + r"(?![A-Za-z0-9])"
    return re.search(pat, haystack_lower) is not None


@dataclass
class ATSResult:
    score: float = 0.0                       # 0..100
    keyword_score: float = 0.0
    structure_score: float = 0.0
    matched: List[str] = field(default_factory=list)
    missing: List[Tuple[str, float]] = field(default_factory=list)  # (kw, weight)
    structure_issues: List[str] = field(default_factory=list)

    def grade(self) -> str:
        s = self.score
        return ("A" if s >= 85 else "B" if s >= 70 else
                "C" if s >= 55 else "D" if s >= 40 else "F")


def _structure_checks(resume: Resume) -> Tuple[float, List[str]]:
    """ATS parsers reward clear contact info and standard sections."""
    issues: List[str] = []
    pts = 0.0
    if resume.email and re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+", resume.email):
        pts += 2
    else:
        issues.append("Missing or malformed email address")
    if resume.phone:
        pts += 1
    else:
        issues.append("Missing phone number")
    if resume.skills:
        pts += 2
    else:
        issues.append("No dedicated Skills section (ATS keyword-matches on it)")
    if resume.experience:
        pts += 2
    else:
        issues.append("No work experience entries")
    if resume.education:
        pts += 1
    else:
        issues.append("No education section")
    if any(e.bullets for e in resume.experience):
        pts += 1
    else:
        issues.append("Experience has no bullet points to match against")
    if resume.summary:
        pts += 1
    else:
        issues.append("No professional summary (missed keyword real estate)")
    return pts, issues  # out of 10


def score(resume: Resume, jd: ParsedJD) -> ATSResult:
    """Score a resume against a parsed JD. Returns 0..100 with a breakdown."""
    text_lower = resume_text(resume).lower()

    total_w = sum(jd.keywords.values()) or 1.0
    matched_w = 0.0
    matched: List[str] = []
    missing: List[Tuple[str, float]] = []
    for kw, w in jd.keywords.items():
        if _contains(text_lower, kw):
            matched_w += w
            matched.append(kw)
        else:
            missing.append((kw, w))

    keyword_score = 100.0 * matched_w / total_w              # weighted recall
    struct_pts, issues = _structure_checks(resume)
    structure_score = 100.0 * struct_pts / 10.0

    # ATS is dominated by keyword match; structure is a real but smaller factor.
    final = 0.82 * keyword_score + 0.18 * structure_score

    missing.sort(key=lambda kv: kv[1], reverse=True)
    matched.sort(key=lambda k: jd.keywords.get(k, 0), reverse=True)

    return ATSResult(
        score=round(final, 1),
        keyword_score=round(keyword_score, 1),
        structure_score=round(structure_score, 1),
        matched=matched,
        missing=missing,
        structure_issues=issues,
    )


def format_report(res: ATSResult, top_missing: int = 15) -> str:
    """Human-readable ATS report for the CLI."""
    lines = []
    lines.append(f"ATS Match Score: {res.score}/100  (grade {res.grade()})")
    lines.append(f"  keyword coverage: {res.keyword_score}/100")
    lines.append(f"  structure:        {res.structure_score}/100")
    if res.matched:
        lines.append(f"  matched keywords ({len(res.matched)}): "
                     + ", ".join(res.matched[:20])
                     + (" ..." if len(res.matched) > 20 else ""))
    if res.missing:
        miss = ", ".join(k for k, _ in res.missing[:top_missing])
        lines.append(f"  top missing keywords: {miss}")
    for issue in res.structure_issues:
        lines.append(f"  ! {issue}")
    return "\n".join(lines)
