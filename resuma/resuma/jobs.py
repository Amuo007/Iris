"""Background jobs: a tailoring run takes 5-10 minutes, so MCP clients start one, poll it and collect the result.

Runs are serialized on one worker thread: the local model server halves its throughput when two requests overlap,
so two parallel runs finish later than the same two run back to back.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
import traceback
import urllib.parse
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import config
from .config import FitConfig, LLMConfig
from .llm import LLM, BaseLLM, LLMCancelled

MODES = ("jd_aware", "strict")

# (substring of a pipeline log line, progress reached, human-readable phase). Progress only ever moves forward.
PHASES: list[tuple[str, float, str]] = [
    ("analyzing the job description", 0.02, "analyzing the job description"),
    ("planning projects", 0.10, "planning projects, angles and skills rows"),
    ("writing exp1", 0.18, "writing experience bullets"),
    ("writing exp2", 0.24, "writing experience bullets"),
    ("writing exp3", 0.30, "writing experience bullets"),
    ("writing proj1", 0.36, "writing project bullets"),
    ("writing proj2", 0.42, "writing project bullets"),
    ("writing proj3", 0.48, "writing project bullets"),
    ("compile #1", 0.56, "compiling and verifying the layout"),
    ("keyword coverage ", 0.62, "checking keyword coverage"),
    ("coverage boost 1", 0.66, "boosting keyword coverage"),
    ("coverage boost 2", 0.74, "boosting keyword coverage"),
    ("coverage boost 3", 0.80, "boosting keyword coverage"),
    ("coverage boost 4", 0.84, "boosting keyword coverage"),
    ("polishing skills", 0.88, "polishing the skills rows"),
    ("reviewing requirement evidence", 0.94, "reviewing requirement evidence and relevance"),
    ("done ->", 1.0, "done"),
]


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds") if ts else None


def slug(name: str) -> str:
    """'JP Morgan' -> 'jp-morgan': the run id used in resource URIs."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def resource_uris(run: str) -> dict[str, str]:
    r = slug(run)
    return {"pdf": f"resuma://runs/{r}/pdf", "preview_png": f"resuma://runs/{r}/preview.png",
            "tex": f"resuma://runs/{r}/tex", "report_md": f"resuma://runs/{r}/report.md",
            "report_json": f"resuma://runs/{r}/report.json", "jd": f"resuma://runs/{r}/jd.txt"}


def run_summary(report: dict, out_dir: Path | None = None) -> dict:
    """The part of a report a website needs to show a result card (paths, coverage, gaps) without the slot detail."""
    out_dir = Path(out_dir) if out_dir else Path(report["pdf"]).parent
    pdf = out_dir / Path(report["pdf"]).name
    cov = report["coverage"]
    return {
        "run": slug(out_dir.name), "folder": str(out_dir), "company": report["company"],
        "role_title": report["role_title"], "seniority": report["seniority"], "mode": report["mode"],
        "model": report["model"], "pages": report["pages"], "layout_ok": report["layout_ok"],
        "coverage": round(cov["ratio"], 3), "coverage_placeable": round(cov["ratio_placeable"], 3),
        "coverage_target": cov.get("target"), "target_met": cov.get("target_met"),
        "evidence_coverage": cov.get("ratio_body"),
        "supported_evidence_coverage": cov.get("ratio_body_supported"),
        "evidence_target_met": cov.get("body_target_met"),
        "missing_evidence": [m["term"] for m in cov.get("body_missing", [])],
        "missing_keywords": [m["term"] for m in cov["missing"] if m.get("counted")],
        "gap_skills": report["gap_skills"], "rejected_skill_items": report.get("rejected_skill_items", []),
        "projects_chosen": report["projects_chosen"],
        "project_drafts": report.get("project_drafts", []),
        "requirement_review": report.get("requirement_review", {}),
        "fallbacks": report["fallbacks"], "warnings": report["warnings"],
        "seconds": report["seconds"], "llm_calls": report["llm"].get("calls"), "compiles": report["compiles"],
        "files": {"pdf": str(pdf), "preview_png": str(out_dir / "preview.png"), "tex": str(pdf.with_suffix(".tex")),
                  "report_md": str(out_dir / "report.md"), "report_json": str(out_dir / "report.json"),
                  "jd": str(out_dir / "jd.txt")},
        "resources": resource_uris(out_dir.name),
    }


def list_runs(out_root: Path = config.OUTPUT) -> list[dict]:
    """Every finished run under out_root, newest first."""
    out_root = Path(out_root)
    runs = []
    if not out_root.exists():
        return runs
    for rj in sorted(out_root.glob("*/report.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            report = json.loads(rj.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        s = run_summary(report, rj.parent)
        s["generated_at"] = _iso(rj.stat().st_mtime)
        runs.append(s)
    return runs


def find_run_dir(name: str, out_root: Path = config.OUTPUT) -> Path | None:
    """Resolve a run by folder name ('JP Morgan'), percent-encoded name or slug ('jp-morgan'). Never leaves out_root."""
    out_root = Path(out_root).resolve()
    if not name or any(c in name for c in "/\\\0") or ".." in name or not out_root.exists():
        return None
    wanted = {name, urllib.parse.unquote(name)}
    for d in sorted(out_root.iterdir()):
        if not d.is_dir() or not (d / "report.json").exists() or d.resolve().parent != out_root:
            continue
        if d.name in wanted or slug(d.name) == slug(name):
            return d
    return None


def load_run(name: str, out_root: Path = config.OUTPUT) -> tuple[Path, dict] | None:
    d = find_run_dir(name, out_root)
    if d is None:
        return None
    return d, json.loads((d / "report.json").read_text(encoding="utf-8"))


@dataclass(eq=False)
class Job:
    id: str
    jd_text: str
    company: str | None
    mode: str
    coverage_target: float | None
    thinking: bool | None
    project_strategy: str = "existing"
    status: str = "queued"          # queued | running | done | failed | cancelled
    phase: str = "queued"
    progress: float = 0.0
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    log: list[str] = field(default_factory=list)
    report: dict | None = None
    error: str | None = None
    out_dir: Path | None = None
    done: threading.Event = field(default_factory=threading.Event, repr=False)
    cancel_requested: threading.Event = field(default_factory=threading.Event, repr=False)
    llm: BaseLLM | None = field(default=None, repr=False)

    def note(self, line: str) -> None:
        """Pipeline log callback: keeps the line and advances the phase/progress estimate."""
        if self.cancel_requested.is_set():
            raise LLMCancelled("resume job cancelled")
        self.log.append(line)
        for needle, frac, phase in PHASES:
            if needle in line:
                if frac >= self.progress:
                    self.progress, self.phase = frac, phase
                break

    def summary(self, *, log_tail: int = 10, queue_position: int | None = None) -> dict:
        now = time.time()
        d = {
            "job_id": self.id, "status": self.status, "phase": self.phase, "progress": round(self.progress, 2),
            "company": self.company, "mode": self.mode, "coverage_target": self.coverage_target,
            "thinking": self.thinking, "project_strategy": self.project_strategy, "queue_position": queue_position,
            "created_at": _iso(self.created), "started_at": _iso(self.started), "finished_at": _iso(self.finished),
            "elapsed_seconds": round((self.finished or now) - self.started, 1) if self.started else 0.0,
            "log_tail": self.log[-log_tail:] if log_tail else [],
            "error": self.error,
        }
        if self.report is not None:
            d["result"] = run_summary(self.report, self.out_dir)
        return d


class JobManager:
    def __init__(self, *, out_root: Path = config.OUTPUT,
                 llm_factory: Callable[[bool | None], BaseLLM] | None = None,
                 fit_factory: Callable[[], FitConfig] | None = None):
        self.out_root = Path(out_root).resolve()
        self.llm_factory = llm_factory or (lambda thinking: LLM(LLMConfig(), thinking=thinking))
        self.fit_factory = fit_factory or FitConfig
        self.jobs: dict[str, Job] = {}
        self.current: str | None = None
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._loop, name="resuma-jobs", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------------ public
    def submit(self, jd_text: str, *, company: str | None = None, mode: str = "jd_aware",
               coverage_target: float | None = None, thinking: bool | None = None, project_strategy: str = "existing") -> Job:
        jd_text = (jd_text or "").strip()
        if len(jd_text) < 80:
            raise ValueError("jd_text is too short to be a job description (give the full posting, at least 80 characters)")
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if coverage_target is not None and not 0 < coverage_target <= 1:
            raise ValueError("coverage_target must be between 0 and 1")
        if project_strategy not in ("existing", "adaptive"):
            raise ValueError("project_strategy must be existing or adaptive")
        job = Job(id=uuid.uuid4().hex[:10], jd_text=jd_text, company=(company or "").strip() or None, mode=mode,
                  coverage_target=coverage_target, thinking=thinking, project_strategy=project_strategy)
        with self._lock:
            self.jobs[job.id] = job
        self._queue.put(job.id)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def all(self) -> list[Job]:
        with self._lock:
            return sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)

    def queue_position(self, job: Job) -> int | None:
        """1 = next to run; None once it is running or finished."""
        if job.status != "queued":
            return None
        with self._lock:
            queued = sorted((j for j in self.jobs.values() if j.status == "queued"), key=lambda j: j.created)
        return queued.index(job) + 1 if job in queued else None

    def describe(self, job: Job, log_tail: int = 10) -> dict:
        return job.summary(log_tail=log_tail, queue_position=self.queue_position(job))

    def cancel(self, job_id: str) -> bool:
        """Drop queued work or abort the running LLM request and all later tailoring stages."""
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None or job.status not in ("queued", "running", "cancelled"):
                return False
            queued = job.status == "queued"
            job.cancel_requested.set()
            job.status = job.phase = "cancelled"
            llm = job.llm
            if queued:
                job.finished = time.time()
                job.done.set()
        if llm is not None:
            llm.cancel()
        return True

    def wait(self, job_id: str, timeout: float | None = None) -> Job:
        job = self.jobs[job_id]
        job.done.wait(timeout)
        return job

    # ------------------------------------------------------------------ worker
    def _loop(self) -> None:
        while True:
            jid = self._queue.get()
            job = self.jobs.get(jid)
            if job is not None and job.status == "queued":
                self._run(job)

    def _run(self, job: Job) -> None:
        from .pipeline import Tailor

        with self._lock:
            if job.cancel_requested.is_set():
                return
            job.status, job.phase, job.started, self.current = "running", "starting", time.time(), job.id
        try:
            fit = self.fit_factory()
            fit.mode = job.mode
            fit.project_strategy = job.project_strategy
            if job.coverage_target is not None:
                fit.coverage_target = job.coverage_target
            llm = self.llm_factory(job.thinking)
            with self._lock:
                job.llm = llm
                if job.cancel_requested.is_set():
                    llm.cancel()
            llm.check_cancelled()
            report = Tailor(job.jd_text, llm, fit=fit, log=job.note).run(company=job.company, out_root=self.out_root)
            with self._lock:
                llm.check_cancelled()
                if job.cancel_requested.is_set():
                    raise LLMCancelled("resume job cancelled")
                job.report, job.out_dir, job.company = report, Path(report["pdf"]).parent, report["company"]
                job.status, job.phase, job.progress = "done", "done", 1.0
        except LLMCancelled:
            job.status = job.phase = "cancelled"
            job.log.append("cancelled: application was left; stopped resume generation")
        except Exception as exc:  # noqa: BLE001 - any failure must land in the job, not kill the worker
            if job.cancel_requested.is_set():
                job.status = job.phase = "cancelled"
            else:
                job.status = job.phase = "failed"
                job.error = f"{type(exc).__name__}: {exc}"[:600]
                job.log.append("traceback:\n" + traceback.format_exc())
        finally:
            with self._lock:
                job.finished, self.current, job.llm = time.time(), None, None
            self._write_job_file(job)
            job.done.set()

    def _write_job_file(self, job: Job) -> None:
        if job.out_dir is None:
            return
        data = job.summary(log_tail=0)
        data["log"] = list(job.log)
        try:
            (job.out_dir / "job.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
