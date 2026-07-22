"""jobapplier command-line interface.

Subcommands:
  search   Pull job postings from public providers into the tracker.
  import   Import a single JD (paste text, a file, or a public URL).
  tailor   Tailor + ATS-score + export a resume for one job (or an ad-hoc JD).
  run      End-to-end: search -> tailor -> score -> export -> apply-package,
           persistently, resuming where a previous run left off.
  list     Show the application pipeline.
  status   Get/set the status of an application.
  score    Score your master resume against a JD without tailoring.

Design: everything is persisted in a SQLite tracker (~/.jobapplier by default),
so runs are resumable and no job is processed twice.
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import List, Optional

from . import __version__
from .models import Resume, JobPosting
from .resume_io import load_resume
from .jd import parse_jd
from . import ats as ats_mod
from . import search as search_mod
from . import render as render_mod
from . import apply as apply_mod
from .tailor import get_tailorer
from .tracker import Tracker, DEFAULT_DB

OUT_DEFAULT = "./applications"


# --------------------------------------------------------------------------- #
def _print(*a):
    print(*a, flush=True)


def _load_master(path: Optional[str]) -> Resume:
    path = path or os.environ.get("JOBAPPLIER_RESUME")
    if not path:
        _print("error: no master resume. Pass --resume PATH or set JOBAPPLIER_RESUME.")
        sys.exit(2)
    if not os.path.exists(path):
        _print(f"error: resume not found: {path}")
        sys.exit(2)
    return load_resume(path)


def _tailor_one(master: Resume, job: JobPosting, engine: str,
                out_dir: str, formats: List[str], tracker: Tracker,
                prefill=None) -> dict:
    """Full per-job pipeline: parse -> tailor -> score -> export -> package."""
    jd = parse_jd(job.description, title_hint=job.title)
    tailorer = get_tailorer(engine)
    try:
        tailored = tailorer.tailor(master, jd)
        engine_used = tailorer.name
    except Exception as e:  # noqa: BLE001 — never let LLM errors kill the run
        _print(f"  ! tailoring via {tailorer.name} failed ({e}); using deterministic")
        from .tailor import DeterministicTailorer
        tailored = DeterministicTailorer().tailor(master, jd)
        engine_used = "deterministic(fallback)"

    result = ats_mod.score(tailored, jd)
    before = ats_mod.score(master, jd)

    files = render_mod.export_resume(tailored, job, out_dir, formats=tuple(formats))
    basename = render_mod.job_basename(job)
    pkg = apply_mod.build_apply_package(tailored, job, jd, result, files, prefill=prefill)
    pkg_path = apply_mod.write_package(pkg, out_dir, basename)

    tracker.update_application(
        job.id, status="ready", ats_score=result.score,
        resume_path=files[0] if files else "",
    )
    return {
        "job": job, "files": files, "package": pkg_path,
        "score": result.score, "before": before.score, "grade": result.grade(),
        "engine": engine_used, "result": result,
    }


# --------------------------------------------------------------------------- #
# Subcommands
# --------------------------------------------------------------------------- #
def cmd_search(args) -> int:
    tracker = Tracker(args.db)
    providers = args.providers.split(",") if args.providers else None
    _print(f"Searching [{', '.join(providers or ['remotive','remoteok'])}] for "
           f"'{args.query}' ...")
    jobs = search_mod.search(args.query, providers=providers,
                             limit=args.limit, board=args.board or "")
    errs = getattr(search_mod.search, "last_errors", [])
    for e in errs:
        _print(f"  (skipped) {e}")
    new = 0
    for job in jobs:
        if tracker.upsert_job(job):
            new += 1
    _print(f"Found {len(jobs)} postings; {new} new added to tracker "
           f"({tracker.path}).")
    for j in jobs[:args.limit]:
        _print(f"  [{j.source}] {j.title} @ {j.company}  ({j.id})")
    tracker.close()
    return 0


def cmd_import(args) -> int:
    tracker = Tracker(args.db)
    text = ""
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    job = search_mod.import_job(url=args.url or "", text=text,
                               company=args.company or "", title=args.title or "")
    tracker.upsert_job(job)
    _print(f"Imported job {job.id}: {job.title or '(untitled)'} @ "
           f"{job.company or '(unknown)'}  [{len(job.description)} chars]")
    _print(f"Next:  jobapplier tailor {job.id} --resume <master> ")
    tracker.close()
    return 0


def cmd_tailor(args) -> int:
    tracker = Tracker(args.db)
    master = _load_master(args.resume)
    formats = args.formats.split(",")

    if args.job_id:
        job = tracker.get_job(args.job_id)
        if not job:
            _print(f"error: job {args.job_id} not in tracker. Run search/import first.")
            return 2
    else:
        # ad-hoc JD without a tracked job
        text = ""
        if args.jd:
            with open(args.jd, "r", encoding="utf-8") as f:
                text = f.read()
        elif args.text:
            text = args.text
        else:
            _print("error: provide a JOB_ID, or --jd FILE / --text for an ad-hoc JD.")
            return 2
        job = search_mod.import_job(text=text, company=args.company or "",
                                   title=args.title or "")
        tracker.upsert_job(job)

    info = _tailor_one(master, job, args.engine, args.out, formats, tracker)
    _print(f"\nTailored for: {job.title or '(untitled)'} @ {job.company or '(unknown)'}")
    _print(f"  engine: {info['engine']}")
    _print(f"  ATS score: {info['before']} -> {info['score']}/100 "
           f"(grade {info['grade']})")
    _print("  files:")
    for fp in info["files"]:
        _print(f"    {fp}")
    _print(f"  apply package: {info['package']}")
    if args.verbose:
        _print("\n" + ats_mod.format_report(info["result"]))
    tracker.close()
    return 0


def cmd_run(args) -> int:
    """End-to-end persistent pipeline."""
    tracker = Tracker(args.db)
    master = _load_master(args.resume)
    formats = args.formats.split(",")

    # 1) discover (unless --no-search) using the query
    if args.query and not args.no_search:
        providers = args.providers.split(",") if args.providers else None
        _print(f"[1/2] Searching for '{args.query}' ...")
        jobs = search_mod.search(args.query, providers=providers,
                                 limit=args.limit, board=args.board or "")
        for e in getattr(search_mod.search, "last_errors", []):
            _print(f"  (skipped) {e}")
        added = sum(1 for j in jobs if tracker.upsert_job(j))
        _print(f"  {len(jobs)} postings, {added} new.")

    # 2) process the pending queue (resumable: only 'discovered/tailored')
    pending = tracker.pending(limit=args.max)
    if not pending:
        _print("Nothing pending. (Everything discovered has been processed.)")
        _summary(tracker)
        tracker.close()
        return 0

    _print(f"[2/2] Processing {len(pending)} pending job(s) "
           f"(min ATS to keep: {args.min_score}) ...\n")
    kept = 0
    for app in pending:
        job = tracker.get_job(app.job_id)
        if not job or not job.description.strip():
            tracker.set_status(app.job_id, "skipped", "no description")
            continue
        info = _tailor_one(master, job, args.engine, args.out, formats, tracker)
        flag = ""
        if info["score"] < args.min_score:
            tracker.set_status(app.job_id, "skipped",
                               f"ATS {info['score']} < {args.min_score}")
            flag = "  (below threshold -> skipped)"
        else:
            kept += 1
        _print(f"  {info['before']:>5} -> {info['score']:<5} {info['grade']}  "
               f"{job.title[:40]:<40} @ {job.company[:20]:<20}{flag}")

    _print(f"\nDone. {kept} application package(s) ready in {args.out}/")
    _summary(tracker)
    tracker.close()
    return 0


def cmd_list(args) -> int:
    tracker = Tracker(args.db)
    apps = tracker.list_applications(status=args.status, limit=args.limit)
    if not apps:
        _print("No applications yet. Try:  jobapplier search 'python engineer'")
        tracker.close()
        return 0
    _print(f"{'STATUS':<12} {'ATS':>5}  {'TITLE @ COMPANY':<48} JOB_ID")
    _print("-" * 90)
    for a in apps:
        score = f"{a.ats_score:.0f}" if a.ats_score is not None else "-"
        tc = f"{(a.title or '')[:28]} @ {(a.company or '')[:16]}"
        _print(f"{a.status:<12} {score:>5}  {tc:<48} {a.job_id}")
    _summary(tracker)
    tracker.close()
    return 0


def cmd_status(args) -> int:
    tracker = Tracker(args.db)
    app = tracker.get_application(args.job_id)
    if not app:
        _print(f"error: no application for job {args.job_id}")
        tracker.close()
        return 2
    if args.set:
        tracker.set_status(args.job_id, args.set, notes=args.notes or "")
        _print(f"{args.job_id}: status -> {args.set}")
    else:
        _print(f"job_id:   {app.job_id}")
        _print(f"title:    {app.title} @ {app.company}")
        _print(f"status:   {app.status}")
        _print(f"ats:      {app.ats_score}")
        _print(f"resume:   {app.resume_path}")
        _print(f"apply:    {app.apply_url or app.url}")
        if app.notes:
            _print(f"notes:    {app.notes}")
    tracker.close()
    return 0


def cmd_score(args) -> int:
    master = _load_master(args.resume)
    text = ""
    if args.jd:
        with open(args.jd, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    else:
        _print("error: provide --jd FILE or --text.")
        return 2
    jd = parse_jd(text, title_hint=args.title or "")
    result = ats_mod.score(master, jd)
    _print(ats_mod.format_report(result))
    return 0


def _summary(tracker: Tracker) -> None:
    stats = tracker.stats()
    if stats:
        line = "  ".join(f"{k}:{v}" for k, v in sorted(stats.items()))
        _print(f"\nPipeline: {line}")


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="jobapplier",
        description="Persistent ATS-focused job-application assistant.")
    p.add_argument("--version", action="version", version=f"jobapplier {__version__}")
    p.add_argument("--db", default=DEFAULT_DB, help=f"tracker DB path (default {DEFAULT_DB})")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--resume", help="master resume (.yaml/.json); or set JOBAPPLIER_RESUME")
        sp.add_argument("--engine", default="auto",
                        choices=["auto", "deterministic", "claude"],
                        help="tailoring backend (default auto)")
        sp.add_argument("--out", default=OUT_DEFAULT, help="output dir for resumes/packages")
        sp.add_argument("--formats", default="pdf,txt",
                        help="comma list: pdf,txt,html")

    # search
    s = sub.add_parser("search", help="pull jobs from public providers")
    s.add_argument("query")
    s.add_argument("--providers", help="comma list: remotive,remoteok,greenhouse,lever")
    s.add_argument("--board", help="company token for greenhouse/lever (e.g. stripe)")
    s.add_argument("--limit", type=int, default=25)
    s.set_defaults(func=cmd_search)

    # import
    im = sub.add_parser("import", help="import a single JD")
    im.add_argument("--url", help="public posting URL to fetch")
    im.add_argument("--file", help="path to a JD text file")
    im.add_argument("--text", help="JD text inline")
    im.add_argument("--company")
    im.add_argument("--title")
    im.set_defaults(func=cmd_import)

    # tailor
    t = sub.add_parser("tailor", help="tailor+score+export for one job/JD")
    t.add_argument("job_id", nargs="?", help="tracked job id (from search/import)")
    t.add_argument("--jd", help="ad-hoc JD file (if no job_id)")
    t.add_argument("--text", help="ad-hoc JD text (if no job_id)")
    t.add_argument("--company")
    t.add_argument("--title")
    t.add_argument("-v", "--verbose", action="store_true", help="print ATS report")
    add_common(t)
    t.set_defaults(func=cmd_tailor)

    # run
    r = sub.add_parser("run", help="end-to-end persistent pipeline")
    r.add_argument("query", nargs="?", default="", help="search query (optional)")
    r.add_argument("--providers", help="comma list of providers")
    r.add_argument("--board", help="greenhouse/lever company token")
    r.add_argument("--limit", type=int, default=25, help="max postings per search")
    r.add_argument("--max", type=int, default=50, help="max pending jobs to process")
    r.add_argument("--min-score", type=float, default=0.0,
                   help="skip jobs whose tailored ATS score is below this")
    r.add_argument("--no-search", action="store_true",
                   help="only process already-discovered jobs")
    add_common(r)
    r.set_defaults(func=cmd_run)

    # list
    l = sub.add_parser("list", help="show the pipeline")
    l.add_argument("--status", help="filter by status")
    l.add_argument("--limit", type=int, default=100)
    l.set_defaults(func=cmd_list)

    # status
    st = sub.add_parser("status", help="get/set an application's status")
    st.add_argument("job_id")
    st.add_argument("--set", help="new status (applied, interviewing, rejected, ...)")
    st.add_argument("--notes")
    st.set_defaults(func=cmd_status)

    # score
    sc = sub.add_parser("score", help="score master resume against a JD")
    sc.add_argument("--resume")
    sc.add_argument("--jd")
    sc.add_argument("--text")
    sc.add_argument("--title")
    sc.set_defaults(func=cmd_score)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        _print("\ninterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
