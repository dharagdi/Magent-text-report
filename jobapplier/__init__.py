"""jobapplier — a persistent, ATS-focused job-application assistant.

Pipeline:
    search  -> pull job postings from public providers (or import a JD by URL/paste)
    tailor  -> rewrite your master resume to match a specific JD (deterministic or Claude)
    score   -> ATS keyword/coverage scoring so you know how well it matches
    export  -> ATS-friendly PDF/TXT/HTML named after the job (Company_Role.pdf)
    track   -> SQLite tracker that remembers every job & status so runs resume
    apply   -> semi-automated assist: deep-link + pre-filled data for the apply page

The tool deliberately does NOT auto-submit on LinkedIn/Indeed: that violates their
Terms of Service and risks account bans. It does all the hard work and hands you a
ready-to-submit application.
"""

__version__ = "0.1.0"

from .models import Resume, JobPosting, Application  # noqa: F401
