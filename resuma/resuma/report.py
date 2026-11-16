"""Human- and machine-readable report of what changed, how well it fits and how well it covers the JD."""
from __future__ import annotations

import json
from pathlib import Path

from .texttools import norm


def build_report(*, profile, book, content, meta, analysis, plan, res, cov, jd_terms, fallbacks, warnings, soft_issues,
                 usage, seconds, company, pdf, mode, compiles, model, gaps, rejected=(), coverage_target=0.90, project_drafts=(), requirement_review=None) -> dict:
    texts = content.slot_text()
    slots = []
    for sid, slot in book.slots.items():
        m = res.measures.get(sid)
        if slot.kind not in ("bullet", "skills", "coursework"):
            continue
        before = slot.original
        after = texts.get(sid, "")
        entry = {"slot": sid, "kind": slot.kind, "target_lines": slot.target_lines, "lines": m.lines if m else None,
                 "fill_last_line": round(m.last_line_fill, 2) if m else None, "before": before, "after": after,
                 "changed": norm(before) != norm(after), "jd_terms_unverified": jd_terms.get(sid, []),
                 "soft_issue": soft_issues.get(sid, [])}
        if slot.kind == "bullet":
            entry["entry_id"] = meta[sid].entry_id if sid in meta else None
        slots.append(entry)
    n_bad = sum(1 for s in slots if s["lines"] != s["target_lines"])
    return {
        "company": company, "role_title": analysis.role_title, "seniority": analysis.seniority, "mode": mode,
        "model": model, "pdf": str(pdf), "pages": res.pages, "seconds": round(seconds, 1), "compiles": compiles,
        "llm": usage,
        "layout_ok": res.pages == 1 and n_bad == 0,
        "coverage": {"ratio": round(cov.ratio, 3), "ratio_placeable": round(cov.ratio_placeable, 3),
                     "total_weight": cov.total_weight, "covered": cov.covered, "missing": cov.missing,
                     "target": coverage_target, "target_met": cov.ratio >= coverage_target,
                     "ratio_body": round(cov.ratio_body, 3),
                     "ratio_body_supported": round(cov.ratio_body_supported, 3),
                     "body_target_met": cov.ratio_body_supported >= coverage_target,
                     "body_missing": cov.body_missing},
        "gap_skills": gaps,
        "rejected_skill_items": list(rejected),
        "projects_chosen": [p.id for p in content.projects],
        "project_drafts": list(project_drafts),
        "requirement_review": requirement_review or {},
        "plan": plan.model_dump(),
        "analysis": analysis.model_dump(),
        "slots": slots,
        "skills": [{"label": r.label, "items": r.items} for r in content.skills],
        "coursework": content.coursework,
        "fallbacks": fallbacks, "warnings": warnings,
    }


def _md(report: dict) -> str:
    L = []
    cov = report["coverage"]
    L.append(f"# Tailored resume: {report['company']}\n")
    L.append(f"**Role:** {report['role_title']} ({report['seniority']})  ")
    L.append(f"**Mode:** {report['mode']}  **Model:** {report['model']}  **Time:** {report['seconds']}s  "
             f"**LLM calls:** {report['llm'].get('calls')}  **Compiles:** {report['compiles']}\n")
    L.append("## Result\n")
    L.append(f"- Pages: {report['pages']} {'✅' if report['pages'] == 1 else '❌'}")
    bad = [s['slot'] for s in report['slots'] if s['lines'] != s['target_lines']]
    L.append(f"- Every slot keeps its line count: {'✅' if not bad else '❌ ' + ', '.join(bad)}")
    missing = [m['term'] for m in cov['missing'] if m.get('counted')]
    L.append(f"- Weighted keyword coverage (soft skills excluded): **{cov['ratio']:.0%}** "
             f"(short, listable terms only: {cov['ratio_placeable']:.0%})"
             + (f"; missing: {', '.join(missing)}" if missing else "; nothing missing"))
    L.append(f"- Target: **{cov['target']:.0%}**; {'met' if cov['target_met'] else 'below target; see gaps above'}")
    L.append(f"- Keyword evidence in experience/projects (skills excluded): **{cov['ratio_body']:.0%}**; "
             f"{cov['ratio_body_supported']:.0%} of requirements supported by the selected entries")
    ragged = [s for s in report['slots'] if s['soft_issue']]
    if ragged:
        L.append("- Ragged lines left (fill below threshold): " + ", ".join(f"{s['slot']} ({s['fill_last_line']:.0%})" for s in ragged))
    if report["gap_skills"]:
        L.append(f"- Skills added from the JD that the profile does not list (gap skills for the student to learn): "
                 + ", ".join(report["gap_skills"]))
    if report.get("rejected_skill_items"):
        L.append("- JD phrases the model proposed as skills items that the harness removed (expectations, not skills): "
                 + ", ".join(report["rejected_skill_items"]))
    unverified = {s['slot']: s['jd_terms_unverified'] for s in report['slots'] if s['jd_terms_unverified']}
    if unverified:
        L.append("- JD terms used inside bullets that the facts do not name (verify before relying on them): "
                 + "; ".join(f"{k}: {', '.join(v)}" for k, v in unverified.items()))
    for f in report["fallbacks"]:
        L.append(f"- ⚠️ Fallback: {f}")
    for w in report["warnings"]:
        L.append(f"- ⚠️ {w}")
    if report.get("project_drafts"):
        L.append("\n## Generated project drafts\n")
        L.append("These replacements are generated proposals, not verified completed work. Validate their implementation and measurements before relying on them.")
        for p in report["project_drafts"]:
            L.append(f"- **{p['title']}** replaces {p['replaces']}: " + "; ".join(p["details"]))
    review = report.get("requirement_review", {})
    if review.get("checks"):
        L.append("\n## Requirement evidence review\n")
        L.append(review["summary"] + "\n")
        L.append(review["note"] + "\n")
        if not review.get("complete", True):
            L.append("Review incomplete: some criteria lacked valid source quotes or final evidence.\n")
        for item in review.get("unverified", []):
            L.append(f"- Unverified review criterion: {item['requirement']} — {item['reason']}")
        for c in review["checks"]:
            refs = "; ".join(f"{e['slot']} ({e['source']}): {e['quote']}" for e in c["evidence"])
            L.append(f"- **{c['requirement']}** [{c['importance']}; {c['status']}]: {c['reason']} " + refs)
    L.append("\n## Keyword coverage\n")
    L.append("| keyword | weight | kind | found in |\n|---|---|---|---|")
    for k in sorted(cov["covered"], key=lambda k: -k["weight"]):
        L.append(f"| {k['term']} | {k['weight']} | {k['kind']} | {', '.join(k['found_in']) or '(heading/other)'} |")
    for k in sorted(cov["missing"], key=lambda k: -k["weight"]):
        L.append(f"| ~~{k['term']}~~ | {k['weight']} | {k['kind']} | missing{'' if k.get('counted') else ' (soft, not counted)'} |")
    L.append("\n## Technical skills rows\n")
    for r in report["skills"]:
        L.append(f"- **{r['label']}:** {', '.join(r['items'])}")
    L.append(f"\n**Coursework order:** {', '.join(report['coursework'])}\n")
    L.append(f"**Projects chosen:** {', '.join(report['projects_chosen'])}\n")
    L.append("## What changed, slot by slot\n")
    L.append("Lines = printed lines (target / actual); fill = how full the last printed line is.\n")
    for s in report["slots"]:
        flag = "" if s["lines"] == s["target_lines"] else "  ❌ LINE COUNT CHANGED"
        fill = f"{s['fill_last_line']:.0%}" if s["fill_last_line"] is not None else "?"
        L.append(f"### `{s['slot']}` ({s['kind']}) lines {s['target_lines']}/{s['lines']}, fill {fill}{flag}")
        if s["changed"]:
            L.append(f"- before: {s['before']}")
            L.append(f"- after:  {s['after']}")
        else:
            L.append(f"- unchanged: {s['after']}")
        L.append("")
    return "\n".join(L)


def write_report(report: dict, out_dir: Path) -> None:
    (out_dir / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    (out_dir / "report.md").write_text(_md(report), encoding="utf-8")
