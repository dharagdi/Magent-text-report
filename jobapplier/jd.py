"""Job-description parsing: turn raw JD text into structured, weighted keywords.

Pure stdlib. The goal is ATS-relevant extraction: the tokens an Applicant
Tracking System is most likely to match on (hard skills, tools, titles,
qualifications), each with a weight reflecting how strongly the JD emphasizes it.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Set

# --------------------------------------------------------------------------- #
# Lexicons
# --------------------------------------------------------------------------- #
# A curated set of multi-word / hard skills we want to catch as single tokens
# even though a naive tokenizer would split them. Extend freely.
KNOWN_SKILLS: Set[str] = {
    # languages
    "python", "javascript", "typescript", "java", "c++", "c#", "go", "golang",
    "rust", "ruby", "php", "swift", "kotlin", "scala", "r", "matlab", "sql",
    "bash", "shell", "perl", "objective-c", "dart", "elixir", "haskell",
    # web / frameworks
    "react", "react native", "next.js", "nextjs", "vue", "angular", "svelte",
    "node.js", "nodejs", "express", "django", "flask", "fastapi", "rails",
    "spring", "spring boot", ".net", "asp.net", "laravel", "graphql", "rest",
    "rest api", "grpc", "html", "css", "sass", "tailwind", "redux",
    # data / ml
    "machine learning", "deep learning", "nlp", "computer vision", "pandas",
    "numpy", "scikit-learn", "tensorflow", "pytorch", "keras", "spark",
    "hadoop", "kafka", "airflow", "dbt", "snowflake", "redshift", "bigquery",
    "tableau", "power bi", "looker", "etl", "data engineering", "data science",
    "llm", "generative ai", "rag", "langchain",
    # cloud / devops
    "aws", "azure", "gcp", "google cloud", "docker", "kubernetes", "k8s",
    "terraform", "ansible", "jenkins", "ci/cd", "cicd", "github actions",
    "gitlab", "circleci", "prometheus", "grafana", "datadog", "helm",
    "serverless", "lambda", "ec2", "s3", "microservices", "linux",
    # databases
    "postgresql", "postgres", "mysql", "mongodb", "redis", "elasticsearch",
    "dynamodb", "cassandra", "sqlite", "oracle", "sql server",
    # practices / methodologies
    "agile", "scrum", "kanban", "tdd", "devops", "mlops", "oop",
    "distributed systems", "system design", "api design", "unit testing",
    "integration testing", "object-oriented", "functional programming",
    # business / general
    "project management", "product management", "stakeholder management",
    "budgeting", "forecasting", "excel", "salesforce", "sap", "jira",
    "confluence", "figma", "seo", "sem", "google analytics", "a/b testing",
    "customer success", "account management", "communication", "leadership",
    # security
    "cybersecurity", "penetration testing", "incident response", "siem",
    "soc", "digital forensics", "e-discovery", "encryption", "iso 27001",
    "gdpr", "hipaa", "soc 2",
}

# Words that are common but rarely what an ATS filters on.
STOPWORDS: Set[str] = {
    "the", "and", "for", "with", "you", "your", "our", "will", "are", "have",
    "this", "that", "from", "who", "was", "were", "has", "had", "not", "but",
    "all", "can", "may", "must", "should", "would", "could", "their", "them",
    "they", "his", "her", "its", "out", "get", "got", "how", "why", "what",
    "when", "where", "which", "such", "than", "then", "into", "over", "under",
    "about", "also", "some", "any", "each", "more", "most", "other", "these",
    "those", "being", "been", "does", "did", "doing", "here", "there",
    "a", "an", "in", "on", "of", "to", "as", "at", "by", "or", "is", "be",
    "it", "we", "us", "if", "so", "do", "up", "no", "yes", "per", "via",
    "job", "role", "team", "work", "working", "company", "position", "candidate",
    "experience", "years", "year", "ability", "strong", "excellent", "good",
    "including", "etc", "e.g", "i.e", "plus", "preferred", "required", "must",
    "responsibilities", "requirements", "qualifications", "benefits", "apply",
    "using", "help", "join", "looking", "seeking", "ideal", "opportunity",
    "environment", "across", "within", "new", "well", "high", "great",
}

# Section headers we try to isolate to weight requirements higher.
REQ_HEADERS = re.compile(
    r"(requirements|qualifications|what you.ll need|must have|skills|"
    r"we.re looking for|about you|who you are|minimum)",
    re.I,
)

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.#/-]*")
_TITLE_HINTS = ("engineer", "developer", "manager", "analyst", "scientist",
                "designer", "architect", "consultant", "specialist", "lead",
                "director", "administrator", "coordinator", "attorney",
                "paralegal", "accountant", "nurse", "technician")


@dataclass
class ParsedJD:
    title_guess: str = ""
    keywords: Dict[str, float] = field(default_factory=dict)   # keyword -> weight
    required: List[str] = field(default_factory=list)          # keywords in must-have sections
    raw: str = ""

    def top(self, n: int = 25) -> List[str]:
        return [k for k, _ in sorted(self.keywords.items(),
                                     key=lambda kv: kv[1], reverse=True)[:n]]


def _find_known_skills(text_lower: str) -> Counter:
    """Match multi-word / punctuated skills as whole tokens."""
    found: Counter = Counter()
    for skill in KNOWN_SKILLS:
        # word-ish boundaries; allow skills with +, #, ., / inside
        pat = r"(?<![A-Za-z0-9])" + re.escape(skill) + r"(?![A-Za-z0-9])"
        n = len(re.findall(pat, text_lower))
        if n:
            found[skill] += n
    return found


def parse_jd(text: str, title_hint: str = "") -> ParsedJD:
    """Parse JD text into weighted keywords.

    Weighting: known hard skills get a base boost; terms appearing in a
    requirements/qualifications section get an extra multiplier; frequency
    adds a mild boost.
    """
    text = text or ""
    lower = text.lower()

    # Isolate a "requirements-ish" region to up-weight its terms.
    req_region = ""
    m = REQ_HEADERS.search(text)
    if m:
        req_region = lower[m.start():m.start() + 1500]

    weights: Dict[str, float] = {}

    # 1) Known skills (highest confidence signals for ATS).
    for skill, freq in _find_known_skills(lower).items():
        w = 3.0 + min(freq - 1, 3) * 0.5
        if skill in req_region:
            w += 2.0
        weights[skill] = w

    # 2) Generic salient single words (capture domain nouns not in lexicon).
    tokens = [t.lower() for t in _WORD_RE.findall(text)]
    counts = Counter(t for t in tokens if t not in STOPWORDS and len(t) > 2)
    for word, freq in counts.items():
        if word in weights:
            continue
        # skip pure numbers
        if word.isdigit():
            continue
        w = 1.0 + min(freq - 1, 4) * 0.4
        if word in req_region:
            w += 1.0
        # only keep reasonably salient generic words
        if w >= 1.4 or freq >= 2:
            weights[word] = w

    # 3) Title guess.
    title_guess = title_hint.strip()
    if not title_guess:
        for line in text.splitlines():
            ls = line.strip()
            if 3 < len(ls) < 80 and any(h in ls.lower() for h in _TITLE_HINTS):
                title_guess = ls
                break

    required = sorted(
        [k for k in weights if k in req_region],
        key=lambda k: weights[k], reverse=True,
    )

    return ParsedJD(title_guess=title_guess, keywords=weights,
                    required=required, raw=text)
