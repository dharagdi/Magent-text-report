"""Job search — pull postings from public providers, or import a single JD.

Design choices:
  * Only *public, documented* JSON endpoints are used (Remotive, RemoteOK) and
    per-company public boards (Greenhouse, Lever). These are meant to be read
    programmatically and do not require circumventing auth or scraping HTML
    behind a login.
  * LinkedIn / Indeed are deliberately NOT scraped: their ToS forbid automated
    access and they actively block/ban it. For those, use `import_job` to paste
    a JD or point at a public posting URL.

Everything degrades gracefully: no network => empty results, never a crash.
"""
from __future__ import annotations

import json
import re
import hashlib
import urllib.request
import urllib.parse
import urllib.error
from html.parser import HTMLParser
from typing import Callable, Dict, List, Optional

from .models import JobPosting

USER_AGENT = "jobapplier/0.1 (+https://github.com/; personal job search)"
TIMEOUT = 20


def _get(url: str, headers: Optional[dict] = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _get_json(url: str, headers: Optional[dict] = None):
    return json.loads(_get(url, headers).decode("utf-8", "replace"))


def _hash_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: List[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        if tag in ("br", "p", "li", "div", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html_str: str) -> str:
    p = _HTMLText()
    try:
        p.feed(html_str)
    except Exception:
        return re.sub(r"<[^>]+>", " ", html_str)
    text = "".join(p.parts)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
def search_remotive(query: str, limit: int = 25, **_) -> List[JobPosting]:
    """Remotive public API — remote jobs. https://remotive.com/api/remote-jobs"""
    url = "https://remotive.com/api/remote-jobs?" + urllib.parse.urlencode(
        {"search": query, "limit": limit})
    data = _get_json(url)
    out = []
    for j in data.get("jobs", [])[:limit]:
        out.append(JobPosting(
            id="remotive:" + str(j.get("id")),
            source="remotive",
            title=j.get("title", ""),
            company=j.get("company_name", ""),
            location=j.get("candidate_required_location", "Remote"),
            url=j.get("url", ""),
            apply_url=j.get("url", ""),
            description=html_to_text(j.get("description", "")),
            posted_at=j.get("publication_date", ""),
            salary=j.get("salary", ""),
            remote=True,
            tags=j.get("tags", []) or [],
        ))
    return out


def search_remoteok(query: str, limit: int = 25, **_) -> List[JobPosting]:
    """RemoteOK public API. https://remoteok.com/api"""
    data = _get_json("https://remoteok.com/api")
    q = query.lower()
    out = []
    for j in data:
        if not isinstance(j, dict) or "position" not in j:
            continue
        blob = " ".join(str(j.get(k, "")) for k in ("position", "description", "tags", "company")).lower()
        if q and q not in blob:
            continue
        out.append(JobPosting(
            id="remoteok:" + str(j.get("id", j.get("slug", ""))),
            source="remoteok",
            title=j.get("position", ""),
            company=j.get("company", ""),
            location=j.get("location", "Remote"),
            url=j.get("url", ""),
            apply_url=j.get("apply_url", j.get("url", "")),
            description=html_to_text(j.get("description", "")),
            posted_at=j.get("date", ""),
            salary=(f"{j.get('salary_min','')}-{j.get('salary_max','')}"
                    if j.get("salary_min") else ""),
            remote=True,
            tags=j.get("tags", []) or [],
        ))
        if len(out) >= limit:
            break
    return out


def search_greenhouse(query: str, limit: int = 25, board: str = "", **_) -> List[JobPosting]:
    """Greenhouse public board for one company.
    `board` = the company's greenhouse token (e.g. 'stripe', 'airbnb')."""
    if not board:
        return []
    url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true"
    data = _get_json(url)
    q = query.lower()
    out = []
    for j in data.get("jobs", []):
        title = j.get("title", "")
        desc = html_to_text(j.get("content", ""))
        if q and q not in (title + " " + desc).lower():
            continue
        out.append(JobPosting(
            id="greenhouse:" + board + ":" + str(j.get("id")),
            source="greenhouse",
            title=title,
            company=board.replace("-", " ").title(),
            location=(j.get("location") or {}).get("name", ""),
            url=j.get("absolute_url", ""),
            apply_url=j.get("absolute_url", ""),
            description=desc,
            posted_at=j.get("updated_at", ""),
        ))
        if len(out) >= limit:
            break
    return out


def search_lever(query: str, limit: int = 25, board: str = "", **_) -> List[JobPosting]:
    """Lever public postings for one company.
    `board` = the company's lever token (e.g. 'netflix', 'palantir')."""
    if not board:
        return []
    url = f"https://api.lever.co/v0/postings/{board}?mode=json"
    data = _get_json(url)
    q = query.lower()
    out = []
    for j in data:
        title = j.get("text", "")
        desc = html_to_text(j.get("description", "") + " " +
                            " ".join(l.get("text", "") for l in j.get("lists", [])))
        if q and q not in (title + " " + desc).lower():
            continue
        cats = j.get("categories", {}) or {}
        out.append(JobPosting(
            id="lever:" + board + ":" + str(j.get("id", "")),
            source="lever",
            title=title,
            company=board.replace("-", " ").title(),
            location=cats.get("location", ""),
            url=j.get("hostedUrl", ""),
            apply_url=j.get("applyUrl", j.get("hostedUrl", "")),
            description=desc,
            posted_at=str(j.get("createdAt", "")),
            tags=[cats.get("team", ""), cats.get("commitment", "")],
        ))
        if len(out) >= limit:
            break
    return out


PROVIDERS: Dict[str, Callable[..., List[JobPosting]]] = {
    "remotive": search_remotive,
    "remoteok": search_remoteok,
    "greenhouse": search_greenhouse,
    "lever": search_lever,
}


def search(query: str, providers: Optional[List[str]] = None, limit: int = 25,
           board: str = "") -> List[JobPosting]:
    """Run a query across the requested providers; merge + de-dupe by id.

    Each provider that errors (e.g. offline, board-specific ones with no board)
    is skipped with a note rather than aborting the whole search.
    """
    providers = providers or ["remotive", "remoteok"]
    seen = set()
    results: List[JobPosting] = []
    errors: List[str] = []
    for name in providers:
        fn = PROVIDERS.get(name)
        if not fn:
            errors.append(f"{name}: unknown provider")
            continue
        try:
            for job in fn(query, limit=limit, board=board):
                if job.id in seen:
                    continue
                seen.add(job.id)
                results.append(job)
        except urllib.error.URLError as e:
            errors.append(f"{name}: network error ({e.reason})")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {type(e).__name__}: {e}")
    search.last_errors = errors  # type: ignore[attr-defined]
    return results


# --------------------------------------------------------------------------- #
# Import a single JD (paste text or fetch a public URL)
# --------------------------------------------------------------------------- #
def import_job(*, url: str = "", text: str = "", company: str = "",
               title: str = "", source: str = "manual") -> JobPosting:
    desc = text
    fetched_title = title
    if url and not text:
        try:
            raw = _get(url).decode("utf-8", "replace")
            m = re.search(r"<title>(.*?)</title>", raw, re.I | re.S)
            if m and not fetched_title:
                fetched_title = html_to_text(m.group(1))[:120]
            desc = html_to_text(raw)
        except Exception as e:  # noqa: BLE001
            desc = f"[Could not fetch {url}: {e}]"
    jid = "manual:" + _hash_id(url or "", company, title, desc[:200])
    return JobPosting(
        id=jid, source=source, title=fetched_title or title,
        company=company, url=url, apply_url=url, description=desc,
    )
