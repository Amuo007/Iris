"""Compile LaTeX with pdflatex, read our RESUMA| measurement lines back from the log."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

PT_RE = r"(-?[\d.]+)pt"
MEASURE_RE = re.compile(r"RESUMA\|(?P<slot>[^|]+)\|lines=(?P<lines>\d+)\|width=" + PT_RE + r"\|linewidth=" + PT_RE)
CAL_RE = re.compile(r"RESUMA-CAL\|(?P<face>\w+)\|(?P<key>[^|]+)\|" + PT_RE)
PAGES_RE = re.compile(r"Output written on .*?\((\d+) pages?")
OVERFULL_RE = re.compile(r"Overfull \\hbox \(([\d.]+)pt too wide\) in paragraph at lines (\d+)--(\d+)")
ERROR_RE = re.compile(r"^! (.*)$", re.M)


@dataclass
class SlotMeasure:
    slot: str
    lines: int
    width_pt: float      # natural width of the content if set on one infinitely long line
    linewidth_pt: float  # width available per line where the slot lives

    @property
    def est_lines(self) -> float:
        return self.width_pt / self.linewidth_pt if self.linewidth_pt else 0.0

    @property
    def last_line_fill(self) -> float:
        """Approximate fill of the last line (0..1), from natural width and actual line count."""
        if self.lines <= 0:
            return 0.0
        return max(0.0, min(1.0, self.est_lines - (self.lines - 1)))


@dataclass
class CompileResult:
    ok: bool
    pages: int | None
    pdf: Path | None
    tex: Path
    log: str
    measures: dict[str, SlotMeasure] = field(default_factory=dict)
    overfull: list[tuple[float, int, int]] = field(default_factory=list)  # (pt, from_line, to_line)
    errors: list[str] = field(default_factory=list)


def _pdflatex() -> str:
    exe = shutil.which("pdflatex") or "/Library/TeX/texbin/pdflatex"
    return exe


def compile_tex(tex_source: str, workdir: Path, jobname: str = "resume") -> CompileResult:
    workdir.mkdir(parents=True, exist_ok=True)
    tex_path = workdir / f"{jobname}.tex"
    tex_path.write_text(tex_source, encoding="utf-8")
    env = dict(os.environ, max_print_line="10000", error_line="254", half_error_line="238")
    cmd = [_pdflatex(), "-interaction=nonstopmode", "-halt-on-error", f"-jobname={jobname}",
           f"-output-directory={workdir}", str(tex_path)]
    proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, env=env, timeout=120)
    log_path = workdir / f"{jobname}.log"
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else proc.stdout
    pdf = workdir / f"{jobname}.pdf"
    measures = {}
    for m in MEASURE_RE.finditer(log):
        sm = SlotMeasure(m.group("slot"), int(m.group("lines")), float(m.group(3)), float(m.group(4)))
        measures[sm.slot] = sm
    pm = PAGES_RE.search(log)
    pages = int(pm.group(1)) if pm else None
    overfull = [(float(a), int(b), int(c)) for a, b, c in OVERFULL_RE.findall(log)]
    errors = ERROR_RE.findall(log)
    ok = proc.returncode == 0 and pdf.exists() and pages is not None and not errors
    return CompileResult(ok, pages, pdf if pdf.exists() else None, tex_path, log, measures, overfull, errors)


def parse_calibration(log: str) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {"regular": {}, "bold": {}}
    for m in CAL_RE.finditer(log):
        out.setdefault(m.group("face"), {})[m.group("key")] = float(m.group(3))
    return out


def render_png(pdf: Path, out_png: Path, dpi: int = 110) -> Path:
    import pymupdf  # lazy: only needed for previews

    with pymupdf.open(pdf) as doc:
        page = doc[0]
        pix = page.get_pixmap(dpi=dpi)
        pix.save(out_png)
    return out_png


def pdf_words(pdf: Path) -> list[tuple[float, float, float, float, str]]:
    import pymupdf

    out = []
    with pymupdf.open(pdf) as doc:
        for page in doc:
            for x0, y0, x1, y1, w, *_ in page.get_text("words"):
                out.append((round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), w))
    return out
