"""Regressions for adapting the whole resume, including opt-in generated project drafts."""
import json

from resuma.config import FitConfig
from resuma.llm import MockLLM
from resuma.pipeline import FactChecker, Tailor
from resuma.profile import load_profile
from resuma.schemas import Analysis, Guidance, Plan, ProjectDraft
from test_pipeline_mock import PROFILE, _plan, handler


def draft():
    src = PROFILE.projects_pool[0]
    return ProjectDraft(**dict(src.model_dump(), id="search-benchmark", title="Search Relevance Benchmark",
                               replaces=src.id, dates="", short_bullets=PROFILE.projects_pool[2].bullets,
                               details=["Generated benchmark proposal; verify latency, cache hit rate and scale"]))


def test_fact_order_is_entry_local_and_recovers_invalid_indexes():
    assert Tailor.ordered_facts(["A", "B", "C", "D"], Guidance(fact_order=[3, 3, 99, 0, 1]), 3) == ["C", "A", "B"]
    t = Tailor("Backend APIs", MockLLM(handler), log=lambda _: None)
    plan = Plan.model_validate(_plan())
    plan.experience_guidance[PROFILE.experience[0].id].fact_order = [2, 1, 3]
    content, meta = t.build_content(plan)
    assert content.experience[0].bullets[0] == PROFILE.experience[0].bullets[1]
    assert meta["exp1.b1"].original == PROFILE.experience[0].bullets[1]


def test_core_keywords_still_target_bullets_when_skills_already_covers_them():
    analysis = Analysis(keywords=[{"term": "FastAPI", "weight": 3, "kind": "tool", "where": "both"},
                                  {"term": "Go", "weight": 3, "kind": "tool", "where": "both"}])
    t = Tailor("FastAPI Go", MockLLM(handler), log=lambda _: None)
    assert t.pick_keywords(analysis, Guidance(keywords=["Go"]), ["FastAPI"], "Built FastAPI endpoints") == ["FastAPI"]


def test_grounding_does_not_borrow_tools_from_another_job_or_allow_short_tools():
    checker = FactChecker(PROFILE, "FastAPI Go R SQL", "jd_aware")
    checker.set_keywords(Analysis(keywords=[{"term": term, "kind": "tool"} for term in ["FastAPI", "Go", "R", "SQL"]]).keywords)
    facts = PROFILE.experience[0].facts_text()
    for term in ["FastAPI", "Go", "R", "SQL"]:
        bad, _ = checker.check(f"Built the service using {term}", facts)
        assert bad, term
    assert checker.check("Handled 4 orders", "Handled 74 orders")[0]
    aliases = Analysis(keywords=[{"term": "JavaScript", "aliases": ["JS"], "kind": "tool"}])
    checker.set_keywords(aliases.keywords)
    assert checker.check("Built JavaScript services", "Built JS services")[0] == []


def test_boost_runs_for_body_evidence_even_at_100_percent_overall(tmp_path):
    def evidence_handler(tag, system, user):
        if tag == "analyze":
            return {"company": "Backend Co", "keywords": [{"term": "FastAPI", "kind": "tool", "weight": 3, "where": "both"}]}
        if tag == "plan":
            plan = _plan()
            plan["skills_rows"][0]["items"].insert(0, "FastAPI")
            return plan
        if tag.startswith("write_"):
            prefix = tag.split("_", 1)[1]
            entry = PROFILE.experience[int(prefix[3:]) - 1] if prefix.startswith("exp") else PROFILE.projects_pool[int(prefix[4:]) - 1]
            return {"bullets": [b.replace("FastAPI", "HTTP") + (" for offline search" if "FastAPI" in b else "") for b in entry.bullets]}
        if tag.startswith("boost"):
            assert "FastAPI" in user and "eligible bullet slots" in user
            assert "exp2.b3" in user
            return {"bullet_edits": {"exp2.b3": PROFILE.experience[1].bullets[2] + " for offline search"}}
        return handler(tag, system, user)
    llm = MockLLM(evidence_handler)
    t = Tailor("FastAPI backend development", llm, fit=FitConfig(coverage_target=0.85), log=lambda _: None)
    report = t.run("Evidence Regression", tmp_path)
    assert any(c["tag"].startswith("boost") for c in llm.calls)
    assert report["coverage"]["ratio"] == 1
    assert report["coverage"]["ratio_body"] == 1
    assert report["coverage"]["body_target_met"]
    assert report["layout_ok"]


def test_adaptive_draft_is_per_run_and_keeps_exact_layout(tmp_path):
    def adaptive_handler(tag, system, user):
        if tag == "plan":
            assert "hypothetical project replacements" in system
            assert "ADAPTIVE PROJECTS" in user and "character budgets" in user
            plan = _plan()
            plan["project_drafts"] = [draft().model_dump()]
            plan["projects"][0] = draft().id
            return plan
        return handler(tag, system, user)
    original = load_profile()
    original_json = original.model_dump_json()
    t = Tailor("Python backend APIs", MockLLM(adaptive_handler), profile=original,
               fit=FitConfig(project_strategy="adaptive", coverage_target=0.85), log=lambda _: None)
    report = t.run("Adaptive Regression", tmp_path)
    assert original.model_dump_json() == original_json
    assert "generated-search-benchmark" in report["projects_chosen"]
    assert len(report["project_drafts"]) == 1
    assert report["project_drafts"][0]["needs_verification"]
    assert report["project_drafts"][0]["source"] == "generated_draft"
    assert report["pages"] == 1 and report["layout_ok"]
    assert all(s["lines"] == s["target_lines"] for s in report["slots"])
    markdown = (tmp_path / "Adaptive Regression" / "report.md").read_text()
    assert "Generated project drafts" in markdown and "not verified completed work" in markdown
    assert json.loads((tmp_path / "Adaptive Regression" / "report.json").read_text())["project_drafts"]


def test_drafts_are_ignored_without_opt_in_and_invalid_drafts_cannot_replace_real_projects():
    plan = Plan.model_validate(_plan())
    plan.project_drafts = [draft()]
    t = Tailor("Python", MockLLM(handler), log=lambda _: None)
    t.prepare_projects(plan)
    assert not t.generated_projects and not plan.project_drafts
    t = Tailor("Python", MockLLM(handler), fit=FitConfig(project_strategy="adaptive"), log=lambda _: None)
    plan.project_drafts = [draft().model_copy(update={"replaces": "not-a-real-id"}),
                           draft().model_copy(update={"bullets": ["Made an app"]})]
    t.prepare_projects(plan)
    assert not t.generated_projects
    assert len(t.warnings) == 2
