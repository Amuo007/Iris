from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BUILD = ROOT / "build"
OUTPUT = ROOT / "output"
TEMPLATE = DATA / "template" / "resume.tex.j2"
PROFILE = DATA / "profile.json"
ORIGINAL_TEX = DATA / "original.tex"
METRICS_FILE = BUILD / "fontmetrics.json"
SLOTS_FILE = BUILD / "slots.json"

load_dotenv(ROOT / ".env")


@dataclass
class LLMConfig:
    base_url: str = os.environ.get("RESUMA_BASE_URL", "http://localhost:11434/v1")
    model: str = os.environ.get("RESUMA_MODEL", "")
    api_key: str = os.environ.get("RESUMA_API_KEY", "none")
    max_tokens: int = int(os.environ.get("RESUMA_MAX_TOKENS", "16384"))
    timeout: float = float(os.environ.get("RESUMA_TIMEOUT", "900"))
    temperature_write: float = 0.5
    temperature_analyze: float = 0.2
    # per-call token budgets. The local server trims the model's thinking to fit max_tokens, so these
    # also bound latency: structured extraction runs with thinking off, writing gets a small thinking allowance.
    tokens_analyze: int = 3600
    tokens_plan: int = 6500
    think_plan: bool = False
    tokens_write: int = 1400
    tokens_repair: int = 800
    tokens_boost: int = 3000
    think_write: bool = False


@dataclass
class FitConfig:
    """Thresholds that define 'fits and looks right'."""

    # a one-line slot must be at least this full (fraction of the available width)
    min_fill_single: float = 0.70
    # the last line of a multi-line slot must be at least this full
    min_fill_multi: float = 0.55
    # skills rows are lists; a little slack is fine
    min_fill_skills: float = 0.55
    # what we ask the model to aim for (fraction of the last line)
    target_fill: float = 0.85
    # predicted width must stay this far (fraction of a line) below the slot's capacity before we compile.
    # one-line slots: anything up to the full width fits; multi-line: leave room for an awkward last word
    overflow_margin_single: float = 0.01
    overflow_margin_multi: float = 0.06
    # how many times the LLM may retry a bullet before we compile
    max_rounds_precompile: int = 3
    # how many compile->repair rounds before we fall back to the original text
    max_rounds_compile: int = 3
    # weighted keyword coverage we aim for and how many boost rounds to spend on it
    coverage_target: float = 0.90
    max_coverage_rounds: int = 4
    semantic_review: bool = True
    # "strict": only facts from the profile. "jd_aware": skills section may add JD terms (flagged as gaps)
    mode: str = "jd_aware"
    # adaptive: may replace weak-fit projects with generated drafts, recorded in the report.
    project_strategy: str = "existing"
    # at most this fraction of all skills items may be JD additions the profile does not back
    max_gap_fraction: float = 0.50
