from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import config
from .config import FitConfig, LLMConfig
from .latex import compile_tex, render_png
from .metrics import FontMetrics
from .profile import load_profile
from .slots import SlotBook


def cmd_measure(args) -> int:
    fm = FontMetrics.load_or_calibrate(force=args.force)
    book = SlotBook.baseline(load_profile(), fm, FitConfig(), force=args.force)
    print(f"avg char width {fm.avg_char_pt:.3f}pt\n{'slot':16s} {'kind':10s} lines  linewidth  orig_width  fill  budget(chars)")
    for sid, s in book.slots.items():
        fill = s.orig_width_pt / s.linewidth_pt - (s.target_lines - 1)
        b = book.budget(sid, None if s.kind == "bullet" else "Label")
        print(f"{sid:16s} {s.kind:10s} {s.target_lines:5d}  {s.linewidth_pt:9.1f}  {s.orig_width_pt:10.1f}  {fill:4.2f}  "
              f"{b.min_chars}-{b.max_chars} (target {b.target_chars}, original {b.orig_chars})" if s.editable else
              f"{sid:16s} {s.kind:10s} {s.target_lines:5d}  {s.linewidth_pt:9.1f}  {s.orig_width_pt:10.1f}  {fill:4.2f}")
    return 0


def cmd_tailor(args) -> int:
    from .llm import LLM
    from .pipeline import Tailor

    jd = Path(args.jd).read_text(encoding="utf-8")
    fit = FitConfig()
    if args.mode:
        fit.mode = args.mode
    if args.coverage is not None:
        fit.coverage_target = args.coverage
    thinking = None if args.thinking is None else (args.thinking == "on")
    llm = LLM(LLMConfig(), thinking=thinking)
    report = Tailor(jd, llm, fit=fit).run(company=args.company, out_root=Path(args.out))
    cov = report["coverage"]["ratio"]
    print(f"\n{report['pdf']}\n  pages={report['pages']} layout_ok={report['layout_ok']} coverage={cov:.0%} "
          f"(placeable {report['coverage']['ratio_placeable']:.0%}) "
          f"time={report['seconds']}s llm_calls={report['llm']['calls']} compiles={report['compiles']}")
    if report["fallbacks"]:
        print("  fallbacks: " + " | ".join(report["fallbacks"]))
    return 0 if report["layout_ok"] else 1


def cmd_check(args) -> int:
    src = Path(args.tex).read_text(encoding="utf-8")
    res = compile_tex(src, config.BUILD / "check", "check")
    print(f"ok={res.ok} pages={res.pages} overfull={res.overfull} errors={res.errors[:2]}")
    book = SlotBook.baseline(load_profile(), FontMetrics.load_or_calibrate(), FitConfig())
    bad = 0
    for sid, m in res.measures.items():
        s = book.slots.get(sid)
        mark = "" if not s or s.target_lines == m.lines else "  <-- line count differs from the original"
        bad += bool(mark)
        print(f"  {sid:16s} lines={m.lines} fill_last={m.last_line_fill:.2f}{mark}")
    if res.pdf and args.png:
        print(render_png(res.pdf, Path(args.png)))
    return 0 if res.ok and res.pages == 1 and not bad else 1


def cmd_serve(args) -> int:
    from .mcp_server import serve_from_args

    return serve_from_args(args)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="resuma", description="Tailor the fixed-layout LaTeX resume to a job description.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("measure", help="calibrate fonts and print the slot budgets of the baseline resume")
    m.add_argument("--force", action="store_true")
    m.set_defaults(fn=cmd_measure)
    t = sub.add_parser("tailor", help="generate a tailored one-page resume for a job description")
    t.add_argument("--jd", required=True, help="path to the job description text file")
    t.add_argument("--company", help="folder/file name to use (default: inferred from the JD)")
    t.add_argument("--mode", choices=["strict", "jd_aware"])
    t.add_argument("--coverage", type=float, help="weighted keyword coverage target (default 0.95)")
    t.add_argument("--thinking", choices=["on", "off"], help="force the model's thinking mode on/off (default: server default)")
    t.add_argument("--out", default=str(config.OUTPUT))
    t.set_defaults(fn=cmd_tailor)
    c = sub.add_parser("check", help="compile a .tex and verify every slot against the baseline line counts")
    c.add_argument("tex")
    c.add_argument("--png")
    c.set_defaults(fn=cmd_check)
    s = sub.add_parser("serve", help="run the MCP server (stdio by default; --transport streamable-http for the website)")
    from .mcp_server import add_serve_args

    add_serve_args(s)
    s.set_defaults(fn=cmd_serve)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
