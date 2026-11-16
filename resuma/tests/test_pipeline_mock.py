import json
import re
from pathlib import Path

from resuma.config import FitConfig
from resuma.llm import MockLLM
from resuma.pipeline import Tailor
from resuma.profile import load_profile

PROFILE = load_profile()


def _analysis():
    return {"company": "Mock Co", "role_title": "Backend Engineer", "seniority": "new_grad", "summary": "Builds APIs.",
            "keywords": [{"term": "Python", "weight": 3, "kind": "tool", "where": "both"},
                         {"term": "REST APIs", "aliases": ["REST API"], "weight": 3, "kind": "concept", "where": "both"},
                         {"term": "OAuth 2.0", "aliases": ["OAuth"], "weight": 2, "kind": "tool", "where": "both"},
                         {"term": "Elixir", "weight": 1, "kind": "tool", "where": "skills"},
                         {"term": "code review", "weight": 2, "kind": "practice", "where": "bullets", "listable": True},
                         {"term": "operational stability", "weight": 3, "kind": "concept", "where": "bullets"},
                         {"term": "release practices", "weight": 2, "kind": "practice", "where": "bullets",
                          "listable": "false"},
                         {"term": "communication", "weight": 1, "kind": "soft", "where": "bullets"}],
            "emphasis": ["backend"]}


def _plan():
    return {"projects": [p.id for p in PROFILE.projects_pool],
            "experience_guidance": {e.id: {"angle": "backend", "keywords": ["Python"]} for e in PROFILE.experience},
            "project_guidance": {p.id: {"angle": "backend", "keywords": ["REST APIs"]} for p in PROFILE.projects_pool},
            "coursework": list(reversed(PROFILE.education.coursework_pool)),
            "skills_rows": [{"label": r.label, "items": r.items} for r in PROFILE.skills_pool]}


def handler(tag, system, user):
    if tag.startswith("analyze"):
        return _analysis()
    if tag.startswith("plan"):
        return _plan()
    if tag.startswith("write_"):
        prefix = tag.split("_", 1)[1]
        if prefix.startswith("exp"):
            ent = PROFILE.experience[int(prefix[3:]) - 1]
        else:
            ent = PROFILE.projects_pool[int(prefix[4:]) - 1]
        bullets = list(ent.bullets)
        if prefix == "exp1":  # deliberately overflow bullet 1 and invent a number in bullet 2
            bullets[0] = bullets[0] + " while also coordinating a long extra clause that pushes this well past budget"
            bullets[1] = bullets[1] + " for 400 users"
        return {"bullets": bullets}
    if tag.startswith("repair_") or tag.startswith("fix_"):
        sid = re.sub(r"^(repair|fix)_", "", tag).split("_retry")[0]
        kind, _, rest = sid.partition(".")
        ent = PROFILE.experience[int(kind[3:]) - 1] if kind.startswith("exp") else PROFILE.projects_pool[int(kind[4:]) - 1]
        return {"bullet": ent.bullets[int(rest[1:]) - 1]}
    if tag.startswith("review"):
        return {"requirements": [], "bullet_edits": {}}
    if tag.startswith("polish"):
        return {"skills_rows": []}
    if tag.startswith("boost"):
        rows = [{"label": r.label, "items": list(r.items)} for r in PROFILE.skills_pool]
        rows[4]["items"].insert(0, "Elixir")
        # a listable practice, two expectation phrases, a soft skill and an invention; a label quoting an expectation
        rows[5]["label"] = "Tools, APIs & Release Practices"
        rows[4]["label"] = "Release Practices"                   # a label that is nothing but an expectation phrase
        rows[5]["items"] = ["code review", "operational stability", "release practices", "communication", "Erlang"] + rows[5]["items"]
        return {"skills_rows": rows, "bullet_edits": {}}
    raise AssertionError(tag)


def test_mock_pipeline_repairs_and_fits(tmp_path):
    llm = MockLLM(handler)
    t = Tailor("We need Python and REST APIs and Elixir. OAuth 2.0 helpful.", llm, fit=FitConfig(), log=lambda m: None)
    report = t.run(company="Mock Co", out_root=tmp_path)
    assert report["pages"] == 1 and report["layout_ok"]
    tags = [c["tag"] for c in llm.calls]
    assert any(tg.startswith("repair_exp1.b1") for tg in tags), tags      # overflow was caught before compiling
    assert any(tg.startswith("repair_exp1.b2") for tg in tags), tags      # invented number was caught
    assert any(tg.startswith("boost") for tg in tags)                     # coverage loop ran
    assert "Elixir" in report["gap_skills"] and "code review" in report["gap_skills"]
    flat = [i for r in report["skills"] for i in r["items"]]
    for bad in ("operational stability", "release practices", "communication", "Erlang"):
        assert bad not in flat, flat                                       # expectations, soft skills, inventions dropped
    assert set(report["rejected_skill_items"]) == {"operational stability", "release practices", "communication", "Erlang"}
    assert report["skills"][5]["label"] == "Tools & APIs", report["skills"][5]["label"]   # stuffed label part stripped
    assert report["skills"][4]["label"] == PROFILE.skills_pool[4].label                  # whole stuffed label -> pool label
    missing = {m["term"] for m in report["coverage"]["missing"]}
    assert missing == {"operational stability", "release practices"}, missing   # only coverable by a grounded bullet
    assert all(not m["listable"] for m in report["coverage"]["missing"])
    out = tmp_path / "Mock Co"
    assert (out / "Amrinder_Singh_Mock_Co.pdf").exists() and (out / "report.md").exists() and (out / "preview.png").exists()
    data = json.loads((out / "report.json").read_text())
    assert all(s["lines"] == s["target_lines"] for s in data["slots"])
    assert data["coursework"] == list(reversed(PROFILE.education.coursework_pool))


def test_strict_mode_drops_unknown_skills(tmp_path):
    llm = MockLLM(handler)
    fit = FitConfig(mode="strict", coverage_target=0.5)
    t = Tailor("Python REST APIs Elixir", llm, fit=fit, log=lambda m: None)
    report = t.run(company="Strict Co", out_root=tmp_path)
    assert report["layout_ok"] and report["gap_skills"] == []


def test_one_line_slot_uses_short_bullets_and_candidate_picking():
    from resuma.schemas import BulletOut

    llm = MockLLM(handler)
    t = Tailor("Python REST APIs", llm, fit=FitConfig(), log=lambda m: None)
    proj = next(p for p in PROFILE.projects_pool if p.short_bullets)
    assert proj.bullets_for([1, 1, 1]) == proj.short_bullets and proj.bullets_for([2, 2, 2]) == proj.bullets
    assert all(t.book.evaluate("proj3.b1", b).ok for b in proj.short_bullets), "short bullets must fit a one-line slot"
    long, short = proj.bullets[0], proj.short_bullets[0]
    out = BulletOut(bullet=long + " plus an extra clause that cannot fit", shorter=long, shortest=short)
    assert t.pick_candidate("proj3.b1", out.candidates(), proj.facts_text()) == short      # first that fits
    assert t.pick_candidate("proj3.b1", [long + " with 999 invented users", long], proj.facts_text()) == long  # fact-clean beats shorter


def test_grounding_accepts_word_forms_but_not_expectation_phrases():
    from resuma.texttools import same_root

    assert same_root("encryption", "encrypted") and same_root("operational", "operations")
    assert not same_root("release", "relevant") and not same_root("stability", "stable")
    llm = MockLLM(handler)
    jd = "We value encryption, operational stability and code review. Python REST APIs."
    t = Tailor(jd, llm, fit=FitConfig(), log=lambda m: None)
    from resuma.schemas import Analysis
    t.checker.set_keywords(Analysis(keywords=[
        {"term": "encryption", "kind": "concept", "where": "bullets"},
        {"term": "operational stability", "kind": "concept", "where": "bullets", "listable": False}]).keywords)
    vault = PROFILE.project("vaultkey")
    assert "encryption" not in vault.facts_text().lower().split() and "encrypted" in vault.facts_text().lower()
    ok, _ = t.checker.check("Added AES-256-GCM encryption for local storage with CryptoKit", vault.facts_text())
    assert ok == [], ok                                                   # "encrypted" in the facts grounds "encryption"
    bad, _ = t.checker.check("Added AES-256-GCM encrypted storage with CryptoKit for operational stability", vault.facts_text())
    assert any("operational stability" in p for p in bad), bad           # the expectation phrase is still stuffing
