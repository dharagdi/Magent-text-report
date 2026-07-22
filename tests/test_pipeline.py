"""End-to-end + unit tests for jobapplier (pure stdlib, no network)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jobapplier.models import Resume, JobPosting
from jobapplier.jd import parse_jd
from jobapplier import ats as ats_mod
from jobapplier.tailor import DeterministicTailorer, get_tailorer
from jobapplier import render as render_mod
from jobapplier.pdfwriter import PDF, wrap_text, text_width
from jobapplier.tracker import Tracker
from jobapplier import apply as apply_mod


SAMPLE_JD = """
Senior Python Engineer

We are looking for a Senior Python Engineer to build scalable microservices.

Requirements:
- 5+ years of Python
- Experience with AWS, Docker, and Kubernetes
- Strong knowledge of PostgreSQL and REST APIs
- CI/CD and system design experience
- GraphQL a plus
"""

MASTER = Resume(
    name="Test Candidate",
    title="Software Engineer",
    email="test@example.com",
    phone="555-1234",
    location="Remote",
    summary="Engineer who builds backend services.",
    skills=["Python", "AWS", "Docker", "PostgreSQL", "REST APIs", "Kafka"],
    experience=[
        __import__("jobapplier.models", fromlist=["Experience"]).Experience(
            title="Software Engineer", company="Acme", start="2019", end="2024",
            bullets=[
                "Built REST APIs in Python on AWS.",
                "Wrote docs and onboarded new hires.",
                "Deployed services with Docker and CI/CD.",
            ],
        )
    ],
)


def test_jd_parse_finds_skills():
    jd = parse_jd(SAMPLE_JD, title_hint="Senior Python Engineer")
    kws = set(jd.keywords)
    for expected in ("python", "aws", "docker", "kubernetes", "postgresql"):
        assert expected in kws, f"missing {expected}"
    # requirements-section terms should be weighted higher than base
    assert jd.keywords["kubernetes"] >= 3.0


def test_ats_score_and_missing():
    jd = parse_jd(SAMPLE_JD)
    res = ats_mod.score(MASTER, jd)
    assert 0 <= res.score <= 100
    assert "python" in res.matched
    missing = {k for k, _ in res.missing}
    assert "kubernetes" in missing  # master lacks it


def test_tailoring_improves_or_holds_score():
    jd = parse_jd(SAMPLE_JD)
    before = ats_mod.score(MASTER, jd).score
    tailored = DeterministicTailorer().tailor(MASTER, jd)
    after = ats_mod.score(tailored, jd).score
    assert after >= before  # tailoring never lowers ATS score
    # JD-relevant skills should be surfaced toward the front
    assert tailored.skills[0].lower() in {k for k in jd.keywords}


def test_tailoring_no_fabrication():
    jd = parse_jd(SAMPLE_JD)
    tailored = DeterministicTailorer().tailor(MASTER, jd)
    # kubernetes is NOT anywhere in the master -> must NOT be invented into skills
    assert not any("kubernetes" in s.lower() for s in tailored.skills)


def test_pdf_is_valid_and_has_text():
    pdf = PDF()
    pdf.title_block("Jane Doe", ["jane@example.com | 555"])
    pdf.heading("Summary")
    pdf.paragraph("A" * 500)  # force wrapping
    pdf.heading("Skills")
    pdf.paragraph("Python, AWS, Docker")
    data = pdf.build()
    assert data.startswith(b"%PDF-1.4")
    assert data.rstrip().endswith(b"%%EOF")
    assert b"/Type /Catalog" in data
    assert b"startxref" in data
    # selectable text present
    assert b"(Python, AWS, Docker)" in data or b"Python" in data


def test_wrap_respects_width():
    lines = wrap_text("word " * 40, size=10, max_width=200)
    for ln in lines:
        assert text_width(ln, 10) <= 200 + 1e-6


def test_export_names_after_job(tmp_path=None):
    d = tempfile.mkdtemp()
    job = JobPosting(company="Acme Corp", title="Senior Python Engineer",
                     description=SAMPLE_JD)
    files = render_mod.export_resume(MASTER, job, d, formats=("pdf", "txt", "html"))
    names = {os.path.basename(f) for f in files}
    assert "Acme-Corp_Senior-Python-Engineer.pdf" in names
    assert "Acme-Corp_Senior-Python-Engineer.txt" in names
    for f in files:
        assert os.path.getsize(f) > 0


def test_tracker_persistence_and_resume():
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    job = JobPosting(id="test:1", source="test", title="X", company="Y",
                     description=SAMPLE_JD)
    tr = Tracker(db)
    assert tr.upsert_job(job) is True         # newly added
    assert tr.upsert_job(job) is False        # dedup on second insert
    assert len(tr.pending()) == 1
    tr.set_status("test:1", "applied")
    assert len(tr.pending()) == 0             # applied -> no longer pending
    assert tr.get_application("test:1").status == "applied"
    tr.close()
    # reopen: state persisted
    tr2 = Tracker(db)
    assert tr2.get_application("test:1").status == "applied"
    tr2.close()


def test_apply_package_builds():
    jd = parse_jd(SAMPLE_JD)
    tailored = DeterministicTailorer().tailor(MASTER, jd)
    res = ats_mod.score(tailored, jd)
    job = JobPosting(company="Acme", title="Senior Python Engineer",
                     apply_url="https://example.com/apply", description=SAMPLE_JD)
    pkg = apply_mod.build_apply_package(tailored, job, jd, res, ["/tmp/r.pdf"])
    md = apply_mod.render_package_md(pkg)
    assert "Apply package" in md
    assert "https://example.com/apply" in md
    assert "Cover letter" in md


def test_auto_engine_falls_back_without_key():
    # No ANTHROPIC_API_KEY in test env -> auto must resolve to deterministic
    os.environ.pop("ANTHROPIC_API_KEY", None)
    t = get_tailorer("auto")
    assert t.name == "deterministic"


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
