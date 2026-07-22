"""Resume tailoring engine — pluggable.

Two backends, same interface:

* DeterministicTailorer  — no API key, always available. Reorders skills to
  surface JD-relevant ones, injects missing-but-truthful skills ONLY if the
  candidate already lists them elsewhere, rewrites the summary to lead with the
  target title + top JD keywords the candidate genuinely has, and reorders
  experience bullets to foreground JD-relevant ones. It never fabricates.

* ClaudeTailorer — used when `anthropic` is installed and ANTHROPIC_API_KEY is
  set (or engine="claude" forced). Rewrites summary/bullets fluently, still
  constrained by a strict "do not invent experience" instruction.

`get_tailorer(engine=...)` picks the backend. Default "auto" = Claude if
available, else deterministic.
"""
from __future__ import annotations

import os
import json
import re
from typing import List, Optional

from .models import Resume
from .jd import ParsedJD, KNOWN_SKILLS
from . import ats


# --------------------------------------------------------------------------- #
# Base
# --------------------------------------------------------------------------- #
class Tailorer:
    name = "base"

    def tailor(self, resume: Resume, jd: ParsedJD) -> Resume:
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Deterministic backend
# --------------------------------------------------------------------------- #
class DeterministicTailorer(Tailorer):
    name = "deterministic"

    def tailor(self, resume: Resume, jd: ParsedJD) -> Resume:
        out = resume.copy()
        text_lower = ats.resume_text(resume).lower()
        top_kw = jd.top(30)

        # 1) Reorder skills: JD-relevant first, keep the rest, de-dup.
        jd_kw_lower = {k.lower() for k in jd.keywords}
        have = {s.lower(): s for s in out.skills}
        prioritized: List[str] = []
        for kw in top_kw:
            if kw in have and have[kw] not in prioritized:
                prioritized.append(have[kw])
        for s in out.skills:
            if s not in prioritized:
                prioritized.append(s)

        # 1b) Surface skills the candidate demonstrably has (present in resume
        #     text / a known skill) but that aren't in the Skills list yet.
        for kw in top_kw:
            if kw in jd_kw_lower and kw not in have:
                if kw in KNOWN_SKILLS and self._mentioned(kw, text_lower):
                    prioritized.append(self._titleize(kw))
                    have[kw] = self._titleize(kw)
        out.skills = _dedup_keep_order(prioritized)

        # 2) Rewrite the summary to lead with target title + owned JD keywords.
        owned = [self._titleize(kw) for kw in top_kw
                 if kw in jd_kw_lower and (kw in have or self._mentioned(kw, text_lower))]
        out.summary = self._build_summary(resume, jd, owned[:6])

        # 3) Reorder bullets within each experience: JD-relevant first.
        for exp in out.experience:
            exp.bullets = self._reorder_bullets(exp.bullets, top_kw)

        return out

    # -- helpers ------------------------------------------------------------ #
    @staticmethod
    def _mentioned(kw: str, text_lower: str) -> bool:
        pat = r"(?<![A-Za-z0-9])" + re.escape(kw) + r"(?![A-Za-z0-9])"
        return re.search(pat, text_lower) is not None

    @staticmethod
    def _titleize(kw: str) -> str:
        specials = {
            "aws": "AWS", "gcp": "GCP", "sql": "SQL", "nlp": "NLP",
            "ci/cd": "CI/CD", "cicd": "CI/CD", "api": "API", "rest": "REST",
            "rest api": "REST APIs", "graphql": "GraphQL", "html": "HTML",
            "css": "CSS", "k8s": "Kubernetes", "ml": "ML", "llm": "LLMs",
            "tdd": "TDD", "oop": "OOP", "etl": "ETL", "seo": "SEO",
            ".net": ".NET", "node.js": "Node.js", "next.js": "Next.js",
            "postgresql": "PostgreSQL", "postgres": "Postgres", "mysql": "MySQL",
            "mongodb": "MongoDB", "graphql": "GraphQL", "devops": "DevOps",
            "mlops": "MLOps", "gdpr": "GDPR", "hipaa": "HIPAA", "siem": "SIEM",
        }
        if kw in specials:
            return specials[kw]
        return kw.title() if kw.islower() else kw

    def _build_summary(self, resume: Resume, jd: ParsedJD, owned: List[str]) -> str:
        target = (jd.title_guess or resume.title or "").strip()
        base = resume.summary.strip()
        # One clean lead sentence naming the target role, only if the summary
        # doesn't already open with that title.
        lead = ""
        if target and target.lower() not in base[:80].lower():
            lead = f"{target} with a background aligned to this role. "
        kw_clause = ""
        if owned:
            kw_clause = " Core strengths: " + ", ".join(owned) + "."
        return (lead + base + kw_clause).strip()

    def _reorder_bullets(self, bullets: List[str], top_kw: List[str]) -> List[str]:
        def relevance(b: str) -> int:
            bl = b.lower()
            return sum(1 for kw in top_kw if kw in bl)
        # Stable sort: more JD-relevant bullets first, original order kept on ties.
        ordered = sorted(enumerate(bullets),
                         key=lambda ib: (-relevance(ib[1]), ib[0]))
        return [b for _, b in ordered]


# --------------------------------------------------------------------------- #
# Claude backend
# --------------------------------------------------------------------------- #
class ClaudeTailorer(Tailorer):
    name = "claude"

    MODEL = os.environ.get("JOBAPPLIER_MODEL", "claude-sonnet-5")

    def __init__(self) -> None:
        import anthropic  # noqa: F401  (raises if unavailable)
        self._anthropic = anthropic

    def available(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    def tailor(self, resume: Resume, jd: ParsedJD) -> Resume:
        client = self._anthropic.Anthropic()
        sys = (
            "You are an expert resume writer and ATS optimization specialist. "
            "You tailor an existing resume to a specific job description so it "
            "passes ATS keyword screening and reads well to a recruiter. "
            "STRICT RULES: Never invent employers, titles, dates, degrees, or "
            "accomplishments. Only rephrase, reorder, and surface skills the "
            "candidate genuinely has. Weave in JD keywords ONLY where truthful. "
            "Return ONLY valid JSON matching the given schema."
        )
        schema_hint = {
            "summary": "string - 2-4 sentence professional summary tailored to the JD",
            "skills": ["string - reordered/expanded skills, JD-relevant first, no fabrication"],
            "experience": [{"title": "str", "company": "str", "location": "str",
                            "start": "str", "end": "str",
                            "bullets": ["str - rewritten, quantified where possible, JD-aligned"]}],
        }
        user = (
            "JOB DESCRIPTION:\n" + jd.raw[:6000] + "\n\n"
            "TOP JD KEYWORDS (weighted): " + ", ".join(jd.top(30)) + "\n\n"
            "CURRENT RESUME (JSON):\n" + json.dumps(resume.to_dict(), indent=2)[:8000] + "\n\n"
            "Rewrite `summary`, `skills`, and each experience's `bullets` to match "
            "the JD while obeying the strict rules. Keep companies/titles/dates "
            "EXACTLY as given. Return JSON with this shape:\n"
            + json.dumps(schema_hint, indent=2)
        )
        msg = client.messages.create(
            model=self.MODEL,
            max_tokens=4000,
            system=sys,
            messages=[{"role": "user", "content": user}],
        )
        raw = "".join(getattr(b, "text", "") for b in msg.content)
        data = _extract_json(raw)
        return _merge_llm(resume, data)


# --------------------------------------------------------------------------- #
# Factory + helpers
# --------------------------------------------------------------------------- #
def get_tailorer(engine: str = "auto") -> Tailorer:
    engine = (engine or "auto").lower()
    if engine == "deterministic":
        return DeterministicTailorer()
    if engine in ("claude", "llm"):
        return ClaudeTailorer()
    # auto
    try:
        c = ClaudeTailorer()
        if c.available():
            return c
    except Exception:
        pass
    return DeterministicTailorer()


def _dedup_keep_order(items: List[str]) -> List[str]:
    seen = set()
    out = []
    for it in items:
        k = it.lower()
        if k not in seen:
            seen.add(k)
            out.append(it)
    return out


def _extract_json(raw: str) -> dict:
    raw = raw.strip()
    # strip code fences if present
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def _merge_llm(resume: Resume, data: dict) -> Resume:
    out = resume.copy()
    if data.get("summary"):
        out.summary = str(data["summary"]).strip()
    if data.get("skills"):
        out.skills = _dedup_keep_order([str(s) for s in data["skills"] if str(s).strip()])
    llm_exp = {(_norm(e.get("company")), _norm(e.get("title"))): e
               for e in (data.get("experience") or [])}
    for exp in out.experience:
        key = (_norm(exp.company), _norm(exp.title))
        if key in llm_exp:
            bullets = llm_exp[key].get("bullets")
            if bullets:
                exp.bullets = [str(b).strip() for b in bullets if str(b).strip()]
    return out


def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())
