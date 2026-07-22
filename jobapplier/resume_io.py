"""Load a master resume from YAML or JSON (YAML optional)."""
from __future__ import annotations

import json
import os
from typing import Any, Dict

from .models import Resume


def load_resume(path: str) -> Resume:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    data = _parse(text, path)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping at top level")
    return Resume.from_dict(data)


def _parse(text: str, path: str) -> Dict[str, Any]:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
            return yaml.safe_load(text)
        except ImportError:
            raise SystemExit(
                "This resume is YAML but PyYAML isn't installed. "
                "Install it (`pip install pyyaml`) or use a .json resume."
            )
    return json.loads(text)
