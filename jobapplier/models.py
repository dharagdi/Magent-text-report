"""Core data models for jobapplier.

These are plain dataclasses so the whole tool stays dependency-free. They
serialize to/from dicts (and therefore JSON/YAML) for storage and the CLI.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any


# --------------------------------------------------------------------------- #
# Resume model
# --------------------------------------------------------------------------- #
@dataclass
class Experience:
    title: str = ""
    company: str = ""
    location: str = ""
    start: str = ""
    end: str = ""
    bullets: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Experience":
        return cls(
            title=d.get("title", ""),
            company=d.get("company", ""),
            location=d.get("location", ""),
            start=d.get("start", ""),
            end=d.get("end", ""),
            bullets=list(d.get("bullets", []) or []),
        )


@dataclass
class Education:
    degree: str = ""
    school: str = ""
    location: str = ""
    year: str = ""
    details: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Education":
        return cls(
            degree=d.get("degree", ""),
            school=d.get("school", ""),
            location=d.get("location", ""),
            year=str(d.get("year", "")),
            details=d.get("details", ""),
        )


@dataclass
class Resume:
    """A candidate's master resume — the source of truth we tailor from."""
    name: str = ""
    title: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    links: List[str] = field(default_factory=list)      # e.g. LinkedIn, GitHub, portfolio
    summary: str = ""
    skills: List[str] = field(default_factory=list)
    experience: List[Experience] = field(default_factory=list)
    education: List[Education] = field(default_factory=list)
    certifications: List[str] = field(default_factory=list)
    projects: List[str] = field(default_factory=list)

    # ------------------------------------------------------------------ #
    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Resume":
        return cls(
            name=d.get("name", ""),
            title=d.get("title", ""),
            email=d.get("email", ""),
            phone=d.get("phone", ""),
            location=d.get("location", ""),
            links=list(d.get("links", []) or []),
            summary=d.get("summary", ""),
            skills=list(d.get("skills", []) or []),
            experience=[Experience.from_dict(e) for e in (d.get("experience") or [])],
            education=[Education.from_dict(e) for e in (d.get("education") or [])],
            certifications=list(d.get("certifications", []) or []),
            projects=list(d.get("projects", []) or []),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def copy(self) -> "Resume":
        return Resume.from_dict(json.loads(json.dumps(self.to_dict())))


# --------------------------------------------------------------------------- #
# Job posting model
# --------------------------------------------------------------------------- #
@dataclass
class JobPosting:
    """A single job posting pulled from a provider or imported by the user."""
    id: str = ""                 # stable dedupe id (provider:native_id or url hash)
    source: str = ""             # provider name: remotive, greenhouse, manual, ...
    title: str = ""
    company: str = ""
    location: str = ""
    url: str = ""                # canonical posting URL
    apply_url: str = ""          # direct application URL if known
    description: str = ""        # full JD text
    posted_at: str = ""
    salary: str = ""
    remote: Optional[bool] = None
    tags: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "JobPosting":
        return cls(
            id=str(d.get("id", "")),
            source=d.get("source", ""),
            title=d.get("title", ""),
            company=d.get("company", ""),
            location=d.get("location", ""),
            url=d.get("url", ""),
            apply_url=d.get("apply_url", ""),
            description=d.get("description", ""),
            posted_at=d.get("posted_at", ""),
            salary=d.get("salary", ""),
            remote=d.get("remote"),
            tags=list(d.get("tags", []) or []),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# Application record (tracker)
# --------------------------------------------------------------------------- #
# Status lifecycle for persistence / resumability.
STATUSES = [
    "discovered",   # pulled from search, not yet processed
    "tailored",     # resume generated + exported
    "ready",        # apply package prepared (deep link + prefill)
    "applied",      # user marked as submitted
    "interviewing",
    "offer",
    "rejected",
    "skipped",
]


@dataclass
class Application:
    job_id: str = ""
    company: str = ""
    title: str = ""
    url: str = ""
    apply_url: str = ""
    status: str = "discovered"
    ats_score: Optional[float] = None
    resume_path: str = ""
    notes: str = ""
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_row(cls, row: Dict[str, Any]) -> "Application":
        return cls(**{k: row.get(k) for k in cls.__dataclass_fields__})  # type: ignore
