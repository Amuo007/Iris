from resuma.config import FitConfig
from resuma.llm import MockLLM
from resuma.pipeline import Tailor, keyword_present
from resuma.schemas import Analysis, Keyword, Plan, ReviewOut
from test_pipeline_mock import PROFILE, _plan, handler
from test_tailoring import draft


def test_main_role_project_gets_a_large_slot_not_the_short_tail_slot():
    t = Tailor("Next.js NestJS GraphQL", MockLLM(handler), fit=FitConfig(project_strategy="adaptive"), log=lambda _: None)
    t.analysis = Analysis(keywords=[{"term": term, "weight": 3, "kind": "tool"} for term in ["Next.js", "NestJS", "GraphQL"]])
    t.checker.set_keywords(t.analysis.keywords)
    plan = Plan.model_validate(_plan())
    d = draft().model_copy(update={"title": "Advisor Dashboard", "subtitle": "Next.js, NestJS, GraphQL"})
    plan.project_drafts = [d]
    plan.projects = [PROFILE.projects_pool[1].id, PROFILE.projects_pool[0].id, d.id]
    t.prepare_projects(plan)
    content, meta = t.build_content(plan)
    assert content.projects[0].id.startswith("generated-")
    assert sum(t.book.bullet_line_pattern("proj1")) > sum(t.book.bullet_line_pattern("proj3"))
    # A bad supporting slot must not throw away the main targeted project.
    chosen = content.projects[0].model_dump_json()
    t.revert_projects(content, meta, "test overflow", prefix="proj3")
    assert content.projects[0].model_dump_json() == chosen


def test_vendor_names_do_not_match_ordinary_nouns():
    box = Keyword(term="Box", kind="tool")
    assert not keyword_present("Built a streaming answer box", box)
    assert keyword_present("Integrated Box for document storage", box)
    assert not Tailor("Box", MockLLM(handler), log=lambda _: None).checker.supports(box, "streaming answer box")


def test_requirement_review_rejects_invented_quotes_and_tracks_generated_provenance():
    jd = "Build GraphQL APIs. Integrate financial data."
    t = Tailor(jd, MockLLM(handler), fit=FitConfig(project_strategy="adaptive"), log=lambda _: None)
    plan = Plan.model_validate(_plan());plan.project_drafts = [draft()];plan.projects[0] = draft().id
    t.prepare_projects(plan)
    content, meta = t.build_content(plan)
    q = content.projects[0].bullets[0][:40]
    review = ReviewOut.model_validate({"requirements": [
        {"requirement": "Real criterion", "posting_quote": "Integrate financial data", "status": "transferable",
         "evidence": [{"slot": "proj1.b1", "quote": q}]},
        {"requirement": "Hallucinated evidence", "posting_quote": "Build GraphQL APIs", "status": "direct",
         "evidence": [{"slot": "exp1.b1", "quote": "Built GraphQL services for 10000 users"}]},
        {"requirement": "Invented criterion", "posting_quote": "Needs ten years of Rust", "status": "direct",
         "evidence": [{"slot": "proj1.b1", "quote": q}]}]})
    result = t.checked_review(review, content, meta)
    assert len(result["checks"]) == 2
    assert result["checks"][0]["evidence"][0]["source"] == "generated_draft"
    assert result["checks"][1]["status"] == "missing"
    assert result["direct"] == 0 and result["transferable"] == 1 and result["missing"] == 1


def test_review_assesses_the_final_pdf_after_its_edits(tmp_path):
    jd = "Build a full-stack production system."
    first = PROFILE.experience[0].bullets[0]
    rewritten = first.replace("Built and shipped", "Developed and shipped")
    def h(tag, system, user):
        if tag.startswith("review"):
            assert "ACTUAL RESUME" in user
            final = tag == "review_final"
            return {"summary": "Concrete full-stack evidence", "requirements": [
                {"requirement": "Full-stack features", "posting_quote": "Build a full-stack production system",
                 "status": "direct", "evidence": [{"slot": "exp1.b1", "quote": rewritten if final else first}]}],
                "bullet_edits": {} if final else {"exp1.b1": rewritten}}
        return handler(tag, system, user)
    llm = MockLLM(h)
    t = Tailor(jd, llm, fit=FitConfig(coverage_target=.90), log=lambda _: None)
    report = t.run("Focused Review", tmp_path)
    assert report["layout_ok"]
    assert any(c["tag"] == "review_final" for c in llm.calls)
    assert report["requirement_review"]["checks"][0]["evidence"][0]["quote"] == rewritten
    assert "Requirement evidence review" in (tmp_path / "Focused Review" / "report.md").read_text()


def test_long_stack_header_is_shortened_without_discarding_targeted_project():
    t = Tailor("Next.js", MockLLM(handler), fit=FitConfig(project_strategy="adaptive"), log=lambda _: None)
    plan = Plan.model_validate(_plan())
    d = draft().model_copy(update={"subtitle": ", ".join(["Next.js"] * 30)})
    plan.project_drafts = [d];plan.projects[0] = d.id
    t.prepare_projects(plan)
    content, _ = t.build_content(plan)
    assert content.projects[0].id.startswith("generated-")
    assert len(content.projects[0].subtitle) < len(d.subtitle)
    assert t.head_fits("proj1.head", content.projects[0].title, content.projects[0].subtitle, "")


def test_identical_repair_is_not_retried_over_and_over():
    long = PROFILE.experience[0].bullets[0] + " with additional work " * 15
    llm = MockLLM(lambda tag, system, user: {"bullet": long})
    t = Tailor("React", llm, log=lambda _: None)
    content, meta = t.build_content(Plan.model_validate(_plan()))
    t.precompile_repair("exp1.b1", long, meta["exp1.b1"], fallback=content.experience[0].bullets[0])
    assert len(llm.calls) == 1
