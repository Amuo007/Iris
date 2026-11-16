"""MCP server: the website (or any MCP client) analyzes a JD, starts a tailoring run, polls it and fetches the files.

    python -m resuma serve                                   # stdio, for Claude Desktop / Claude Code
    python -m resuma serve --transport streamable-http       # http://127.0.0.1:8765/mcp, for the website backend
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Annotated, Any, Callable, Literal

import anyio
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ResourceError, ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from . import config, prompts
from .config import LLMConfig
from .jobs import JobManager, find_run_dir, list_runs as scan_runs, load_run, run_summary
from .llm import LLM, BaseLLM
from .schemas import Analysis

VERSION = "0.1.0"
MIN_JD_CHARS = 80

INSTRUCTIONS = """resuma tailors one fixed-layout LaTeX resume (the candidate profile, see get_profile) to a job description
with a local LLM. The PDF stays exactly one page and every bullet, skills row and the coursework line keep the line
count of the original, so the layout is pixel-identical to the template.

Flow: tailor_resume starts a background job (a run takes 5-10 minutes; runs are serialized, get_job shows the queue
position) -> poll get_job until status is "done" -> get_run for the full result, or read the run's resources:
resuma://runs/<run>/pdf, preview.png, tex, report.md, report.json, jd.txt. list_runs lists every finished run on
disk. analyze_jd (about a minute) extracts the weighted keywords on its own when only the analysis is needed.

Truth rules: bullets never claim tools, numbers or facts outside the profile. In jd_aware mode the skills section
may add adjacent JD terms; they come back as gap_skills ("what the student should learn"). strict mode adds nothing."""


def _default_llm(thinking: bool | None) -> BaseLLM:
    return LLM(LLMConfig(), thinking=thinking)


async def _quiet(coro) -> None:
    """Progress/log notifications are best effort: a client without a progress token must not break the run."""
    try:
        await coro
    except Exception:  # noqa: BLE001
        pass


def build_server(*, out_root: Path = config.OUTPUT, llm_factory: Callable[[bool | None], BaseLLM] | None = None,
                 profile_path: Path = config.PROFILE, name: str = "resuma") -> MCPServer:
    out_root = Path(out_root).resolve()
    jobs = JobManager(out_root=out_root, llm_factory=llm_factory or _default_llm)
    mcp = MCPServer(name, title="resuma resume tailor", instructions=INSTRUCTIONS, version=VERSION)
    mcp.jobs = jobs  # type: ignore[attr-defined]  (handy for tests and embedding)

    def _jd(text: str) -> str:
        jd = (text or "").strip()
        if len(jd) < MIN_JD_CHARS:
            raise ToolError(f"jd_text is too short to be a job description: give the full posting (at least {MIN_JD_CHARS} characters)")
        return jd

    # ------------------------------------------------------------------ tools
    @mcp.tool()
    def get_profile() -> dict[str, Any]:
        """The candidate profile every resume is built from: name, contact, education and coursework pool, experience
        entries with their original bullets, the project pool and the skills pool. A tailored resume may only claim
        what is in here (plus, in jd_aware mode, JD terms in the skills rows that are reported as gap_skills)."""
        return json.loads(Path(profile_path).read_text(encoding="utf-8"))

    @mcp.tool()
    def analyze_jd(jd_text: Annotated[str, Field(description="The full job posting text")]) -> dict[str, Any]:
        """Extract what a job description asks for: company, role_title, seniority, a one-line summary, emphasis and
        18-35 weighted keywords (term, aliases, weight 1-3, kind tool/concept/practice/domain/soft, where it belongs:
        bullets/skills/both, and listable: whether a recruiter would scan for it in a skills list). One LLM call, about a minute on the local model. tailor_resume runs this itself, so this
        is only for showing the analysis on its own."""
        jd = _jd(jd_text)
        llm = (llm_factory or _default_llm)(False)
        cfg = getattr(llm, "cfg", None) or LLMConfig()
        analysis = llm.chat_json(prompts.SYSTEM, prompts.analyze_jd(jd), Analysis, temperature=cfg.temperature_analyze,
                                 tag="analyze", max_tokens=cfg.tokens_analyze, thinking=False)
        return analysis.model_dump()

    @mcp.tool()
    async def tailor_resume(
        jd_text: Annotated[str, Field(description="The full job posting text")],
        company: Annotated[str | None, Field(description="Name for the output folder and file, e.g. 'JP Morgan'. "
                                                         "Default: the company named in the JD")] = None,
        mode: Annotated[Literal["jd_aware", "strict"], Field(description="jd_aware (default): the skills rows may add "
                        "adjacent JD skills, returned as gap_skills. strict: nothing outside the profile")] = "jd_aware",
        project_strategy: Annotated[Literal["existing", "adaptive"], Field(description="existing: tailor real projects only. "
                        "adaptive: replace weak-fit projects with generated drafts, flagged for verification in the report")] = "existing",
        coverage_target: Annotated[float | None, Field(description="Weighted keyword coverage to aim for, 0-1 (default 0.90)",
                                                       ge=0, le=1)] = None,
        thinking: Annotated[bool | None, Field(description="Force the model's thinking on or off for every call. "
                                                           "Default: per-call choice (best quality, ~8 minutes)")] = None,
        wait: Annotated[bool, Field(description="true: block until the run finishes (5-10 minutes, progress "
                                                "notifications are sent) and return the result. false (default): return "
                                                "the job at once and poll get_job")] = False,
        ctx: Context = None,
    ) -> dict[str, Any]:
        """Start a tailoring run for a job description. The local LLM rewrites the experience and project bullets, picks
        the three best projects, reorders coursework and rebuilds the skills rows to match the JD; the harness compiles
        the LaTeX, repairs any slot that is off its line count or under-filled, loops on keyword coverage and writes the
        PDF, preview.png, .tex, report.md and report.json under output/<company>/. Returns the job (job_id, status, phase,
        progress 0-1, queue_position) and, once done, result: file paths, resource URIs, pages, layout_ok, coverage,
        missing_keywords, gap_skills."""
        jd = _jd(jd_text)
        try:
            job = jobs.submit(jd, company=company, mode=mode, coverage_target=coverage_target, thinking=thinking,
                              project_strategy=project_strategy)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        if not wait:
            return jobs.describe(job)
        seen = 0
        while not job.done.is_set():
            await anyio.sleep(1.0)
            lines, seen = job.log[seen:], len(job.log)
            if ctx is not None:
                # one progress notification per poll; the message carries the latest pipeline log line
                message = f"{job.phase} | {lines[-1].strip()}" if lines else job.phase
                await _quiet(ctx.report_progress(job.progress, 1.0, message))
        if job.status != "done":
            raise ToolError(f"run {job.status}: {job.error or 'no output'}")
        return jobs.describe(job)

    @mcp.tool()
    def get_job(job_id: Annotated[str, Field(description="job_id returned by tailor_resume")],
                log_tail: Annotated[int, Field(description="How many of the latest pipeline log lines to include (0-200)",
                                               ge=0, le=200)] = 10) -> dict[str, Any]:
        """Status of a tailoring job: queued (queue_position, 1 = next), running (phase, progress 0-1, log_tail), done
        (result with file paths, resource URIs, coverage, missing_keywords, gap_skills) or failed (error)."""
        job = jobs.get(job_id)
        if job is None:
            raise ToolError(f"unknown job_id {job_id!r} (jobs live in memory; see list_runs for finished runs on disk)")
        return jobs.describe(job, log_tail=log_tail)

    @mcp.tool()
    def list_jobs() -> dict[str, Any]:
        """Every job submitted since the server started, newest first, with status (queued, running, done, failed,
        cancelled) and the id of the job running now."""
        return {"running": jobs.current, "jobs": [jobs.describe(j, log_tail=0) for j in jobs.all()]}

    @mcp.tool()
    def cancel_job(job_id: Annotated[str, Field(description="job_id returned by tailor_resume")]) -> dict[str, Any]:
        """Cancel queued or running tailoring, aborting its active LLM request and later stages."""
        job = jobs.get(job_id)
        if job is None:
            raise ToolError(f"unknown job_id {job_id!r}")
        cancelled = jobs.cancel(job_id)
        return {"job_id": job_id, "cancelled": cancelled, "status": job.status}

    @mcp.tool()
    def list_runs() -> dict[str, Any]:
        """Every finished run on disk (output/<company>/), newest first: run id, company, role, pages, layout_ok,
        coverage, missing_keywords, gap_skills, file paths and resource URIs."""
        return {"runs": scan_runs(out_root)}

    @mcp.tool()
    def get_run(run: Annotated[str, Field(description="Run id from list_runs ('jp-morgan') or the folder name ('JP Morgan')")],
                include_slots: Annotated[bool, Field(description="Include every bullet/row before and after, with line "
                                                                 "counts and last-line fill")] = True) -> dict[str, Any]:
        """Full result of a finished run: the summary (paths, resource URIs, coverage), the JD analysis, the final skills
        rows, coursework order, projects chosen, the keyword coverage table (covered and missing, with where each term
        landed) and, with include_slots, what changed slot by slot."""
        hit = load_run(run, out_root)
        if hit is None:
            raise ToolError(f"no finished run named {run!r}; see list_runs")
        out_dir, report = hit
        result = run_summary(report, out_dir)
        result["analysis"] = report["analysis"]
        result["skills"] = report["skills"]
        result["coursework"] = report["coursework"]
        result["keyword_coverage"] = {"covered": report["coverage"]["covered"], "missing": report["coverage"]["missing"]}
        if include_slots:
            result["slots"] = report["slots"]
        return result

    # ------------------------------------------------------------------ resources
    def _run_file(run: str, filename: str | None = None, suffix: str | None = None) -> Path:
        d = find_run_dir(run, out_root)
        if d is None:
            raise ResourceError(f"no finished run named {run!r}")
        p = d / filename if filename else next(iter(sorted(d.glob(f"*{suffix}"))), d / f"missing{suffix}")
        if not p.exists():
            raise ResourceError(f"{p.name} is missing from run {run!r}")
        return p

    @mcp.resource("resuma://profile", mime_type="application/json", title="Candidate profile")
    def profile_resource() -> str:
        return Path(profile_path).read_text(encoding="utf-8")

    @mcp.resource("resuma://runs", mime_type="application/json", title="Finished runs")
    def runs_resource() -> str:
        return json.dumps(scan_runs(out_root), indent=1, ensure_ascii=False)

    @mcp.resource("resuma://runs/{run}/pdf", mime_type="application/pdf", title="Tailored resume PDF")
    def run_pdf(run: str) -> bytes:
        return _run_file(run, suffix=".pdf").read_bytes()

    @mcp.resource("resuma://runs/{run}/preview.png", mime_type="image/png", title="Preview image of the first page")
    def run_preview(run: str) -> bytes:
        return _run_file(run, "preview.png").read_bytes()

    @mcp.resource("resuma://runs/{run}/tex", mime_type="text/x-tex", title="Tailored LaTeX source")
    def run_tex(run: str) -> str:
        return _run_file(run, suffix=".tex").read_text(encoding="utf-8")

    @mcp.resource("resuma://runs/{run}/report.md", mime_type="text/markdown", title="Human-readable report")
    def run_report_md(run: str) -> str:
        return _run_file(run, "report.md").read_text(encoding="utf-8")

    @mcp.resource("resuma://runs/{run}/report.json", mime_type="application/json", title="Machine-readable report")
    def run_report_json(run: str) -> str:
        return _run_file(run, "report.json").read_text(encoding="utf-8")

    @mcp.resource("resuma://runs/{run}/jd.txt", mime_type="text/plain", title="The job description the run used")
    def run_jd(run: str) -> str:
        return _run_file(run, "jd.txt").read_text(encoding="utf-8")

    return mcp


# ---------------------------------------------------------------------- command line
def add_serve_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--transport", choices=["stdio", "streamable-http"],
                    default=os.environ.get("RESUMA_MCP_TRANSPORT", "stdio"),
                    help="stdio (default; Claude Desktop/Code) or streamable-http (the website)")
    ap.add_argument("--host", default=os.environ.get("RESUMA_MCP_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("RESUMA_MCP_PORT", "8765")))
    ap.add_argument("--path", default=os.environ.get("RESUMA_MCP_PATH", "/mcp"), help="HTTP endpoint path")
    ap.add_argument("--allowed-host", action="append", default=[], metavar="HOST[:PORT]",
                    help="extra Host header values to accept when binding beyond localhost (DNS-rebinding protection)")
    ap.add_argument("--no-dns-rebinding-protection", action="store_true",
                    help="accept any Host header (only behind your own reverse proxy / firewall)")
    ap.add_argument("--out", default=str(config.OUTPUT), help="where runs are written and read from")


def serve_from_args(args: argparse.Namespace) -> int:
    server = build_server(out_root=Path(args.out))
    if args.transport == "stdio":
        server.run("stdio")
        return 0
    security = None
    if args.no_dns_rebinding_protection:
        security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    elif args.allowed_host:
        security = TransportSecuritySettings(enable_dns_rebinding_protection=True,
                                             allowed_hosts=list(args.allowed_host), allowed_origins=[])
    print(f"resuma MCP server on http://{args.host}:{args.port}{args.path} (runs in {args.out})", flush=True)
    server.run("streamable-http", host=args.host, port=args.port, streamable_http_path=args.path,
               transport_security=security)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="resuma serve", description="Run the resuma MCP server.")
    add_serve_args(ap)
    return serve_from_args(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
