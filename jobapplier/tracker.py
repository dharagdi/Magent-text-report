"""Persistent application tracker backed by SQLite (stdlib).

This is what gives the tool *persistence*: every discovered job and its status
is stored, so a run can stop and resume, skip already-applied jobs, and give you
a live pipeline view. The DB also caches the full JD text so you can re-tailor
later without re-fetching.
"""
from __future__ import annotations

import os
import sqlite3
import json
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from .models import Application, JobPosting

DEFAULT_DB = os.path.expanduser("~/.jobapplier/jobapplier.db")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Tracker:
    def __init__(self, path: str = DEFAULT_DB):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self._migrate()

    def _migrate(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                source TEXT, title TEXT, company TEXT, location TEXT,
                url TEXT, apply_url TEXT, description TEXT,
                posted_at TEXT, salary TEXT, remote INTEGER, tags TEXT,
                discovered_at TEXT
            );
            CREATE TABLE IF NOT EXISTS applications (
                job_id TEXT PRIMARY KEY,
                company TEXT, title TEXT, url TEXT, apply_url TEXT,
                status TEXT, ats_score REAL, resume_path TEXT,
                notes TEXT, created_at TEXT, updated_at TEXT,
                FOREIGN KEY(job_id) REFERENCES jobs(id)
            );
            CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);
            """
        )
        self.conn.commit()

    # ----- jobs -------------------------------------------------------------
    def upsert_job(self, job: JobPosting) -> bool:
        """Insert a job if new. Returns True if it was newly added."""
        cur = self.conn.execute("SELECT 1 FROM jobs WHERE id=?", (job.id,))
        exists = cur.fetchone() is not None
        self.conn.execute(
            """INSERT INTO jobs
               (id,source,title,company,location,url,apply_url,description,
                posted_at,salary,remote,tags,discovered_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 description=excluded.description, apply_url=excluded.apply_url""",
            (job.id, job.source, job.title, job.company, job.location, job.url,
             job.apply_url, job.description, job.posted_at, job.salary,
             1 if job.remote else 0, json.dumps(job.tags), _now()),
        )
        if not exists:
            self.conn.execute(
                """INSERT OR IGNORE INTO applications
                   (job_id,company,title,url,apply_url,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (job.id, job.company, job.title, job.url, job.apply_url,
                 "discovered", _now(), _now()),
            )
        self.conn.commit()
        return not exists

    def get_job(self, job_id: str) -> Optional[JobPosting]:
        row = self.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["remote"] = bool(d.get("remote"))
        d["tags"] = json.loads(d.get("tags") or "[]")
        d.pop("discovered_at", None)
        return JobPosting.from_dict(d)

    def has_job(self, job_id: str) -> bool:
        return self.conn.execute("SELECT 1 FROM jobs WHERE id=?", (job_id,)).fetchone() is not None

    # ----- applications -----------------------------------------------------
    def get_application(self, job_id: str) -> Optional[Application]:
        row = self.conn.execute(
            "SELECT * FROM applications WHERE job_id=?", (job_id,)).fetchone()
        return Application.from_row(dict(row)) if row else None

    def update_application(self, job_id: str, **fields) -> None:
        if not fields:
            return
        fields["updated_at"] = _now()
        cols = ", ".join(f"{k}=?" for k in fields)
        self.conn.execute(
            f"UPDATE applications SET {cols} WHERE job_id=?",
            (*fields.values(), job_id),
        )
        self.conn.commit()

    def set_status(self, job_id: str, status: str, notes: str = "") -> None:
        f: Dict[str, Any] = {"status": status}
        if notes:
            f["notes"] = notes
        self.update_application(job_id, **f)

    def list_applications(self, status: Optional[str] = None,
                          limit: int = 200) -> List[Application]:
        if status:
            rows = self.conn.execute(
                "SELECT * FROM applications WHERE status=? ORDER BY updated_at DESC LIMIT ?",
                (status, limit)).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM applications ORDER BY updated_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [Application.from_row(dict(r)) for r in rows]

    def pending(self, limit: int = 200) -> List[Application]:
        """Jobs discovered but not yet applied/skipped — the work queue."""
        rows = self.conn.execute(
            """SELECT * FROM applications
               WHERE status IN ('discovered','tailored','ready')
               ORDER BY created_at ASC LIMIT ?""", (limit,)).fetchall()
        return [Application.from_row(dict(r)) for r in rows]

    def stats(self) -> Dict[str, int]:
        rows = self.conn.execute(
            "SELECT status, COUNT(*) c FROM applications GROUP BY status").fetchall()
        return {r["status"]: r["c"] for r in rows}

    def close(self) -> None:
        self.conn.close()
