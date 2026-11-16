"""The MCP server end to end, in process, with the mock LLM from the pipeline test."""
import asyncio
import base64
import json
import time

import pytest
from mcp import Client

from resuma.llm import MockLLM
from resuma.mcp_server import build_server
from test_pipeline_mock import handler

JD = ("We need Python and REST APIs and Kubernetes. OAuth 2.0 helpful. "
      "You will build backend services and integrate third-party APIs for Mock Co.")


def payload(result):
    """Structured content when the server publishes one, else the JSON text block."""
    assert not result.is_error, result.content
    if result.structured_content is not None:
        sc = result.structured_content
        return sc["result"] if set(sc) == {"result"} else sc
    return json.loads(result.content[0].text)


@pytest.fixture
def server(tmp_path):
    return build_server(out_root=tmp_path, llm_factory=lambda thinking: MockLLM(handler))


def run(coro):
    return asyncio.run(coro)


def test_tools_and_resources_are_listed(server):
    async def go():
        async with Client(server) as c:
            tools = {t.name: t for t in (await c.list_tools()).tools}
            templates = {t.uri_template for t in (await c.list_resource_templates()).resource_templates}
            statics = {str(r.uri) for r in (await c.list_resources()).resources}
            return tools, templates, statics

    tools, templates, statics = run(go())
    assert {"analyze_jd", "tailor_resume", "get_job", "list_jobs", "cancel_job", "list_runs", "get_run",
            "get_profile"} <= set(tools)
    props = tools["tailor_resume"].input_schema["properties"]
    assert set(props) == {"jd_text", "company", "mode", "project_strategy", "coverage_target", "thinking", "wait"}   # ctx is not exposed
    assert "resuma://runs/{run}/pdf" in templates and "resuma://runs/{run}/report.json" in templates
    assert {"resuma://profile", "resuma://runs"} <= statics


def test_tailor_wait_then_read_resources(server, tmp_path):
    progress = []

    async def on_progress(p, total, message):
        progress.append((p, message))

    async def go():
        async with Client(server) as c:
            r = payload(await c.call_tool("tailor_resume", {"jd_text": JD, "company": "Mock Co", "wait": True},
                                          progress_callback=on_progress, read_timeout_seconds=600))
            pdf = (await c.read_resource("resuma://runs/mock-co/pdf")).contents[0]
            png = (await c.read_resource("resuma://runs/Mock%20Co/preview.png")).contents[0]
            rep = (await c.read_resource("resuma://runs/Mock Co/report.json")).contents[0]
            md = (await c.read_resource("resuma://runs/mock-co/report.md")).contents[0]
            runs = payload(await c.call_tool("list_runs", {}))
            full = payload(await c.call_tool("get_run", {"run": "mock-co"}))
            brief = payload(await c.call_tool("get_run", {"run": "Mock Co", "include_slots": False}))
            missing = await c.call_tool("get_run", {"run": "nope"})
            return r, pdf, png, rep, md, runs, full, brief, missing

    r, pdf, png, rep, md, runs, full, brief, missing = run(go())
    assert r["status"] == "done" and r["progress"] == 1.0 and r["company"] == "Mock Co"
    res = r["result"]
    assert res["pages"] == 1 and res["layout_ok"] and res["run"] == "mock-co"
    assert res["resources"]["pdf"] == "resuma://runs/mock-co/pdf"
    assert (tmp_path / "Mock Co" / "job.json").exists()
    assert progress and progress[-1][0] <= 1.0 and all(a <= b for (a, _), (b, _) in zip(progress, progress[1:]))
    assert base64.b64decode(pdf.blob).startswith(b"%PDF") and pdf.mime_type == "application/pdf"
    assert base64.b64decode(png.blob).startswith(b"\x89PNG")
    assert json.loads(rep.text)["company"] == "Mock Co" and md.text.startswith("# Tailored resume: Mock Co")
    assert [x["run"] for x in runs["runs"]] == ["mock-co"]
    assert "slots" in full and full["skills"] and full["keyword_coverage"]["covered"]
    assert "slots" not in brief and brief["analysis"]["role_title"] == "Backend Engineer"
    assert missing.is_error and "list_runs" in missing.content[0].text


def test_tailor_poll_cancel_and_errors(server):
    async def go():
        async with Client(server) as c:
            short = await c.call_tool("tailor_resume", {"jd_text": "too short"})
            first = payload(await c.call_tool("tailor_resume", {"jd_text": JD, "company": "First"}))
            second = payload(await c.call_tool("tailor_resume", {"jd_text": JD, "company": "Second"}))
            cancelled = payload(await c.call_tool("cancel_job", {"job_id": second["job_id"]}))
            listed = payload(await c.call_tool("list_jobs", {}))
            unknown = await c.call_tool("get_job", {"job_id": "nope"})
            deadline = time.time() + 300
            while True:
                st = payload(await c.call_tool("get_job", {"job_id": first["job_id"], "log_tail": 3}))
                if st["status"] in ("done", "failed") or time.time() > deadline:
                    break
                await asyncio.sleep(0.5)
            return short, first, second, cancelled, listed, unknown, st

    short, first, second, cancelled, listed, unknown, st = run(go())
    assert short.is_error and "too short" in short.content[0].text
    assert first["status"] in ("queued", "running") and first["job_id"] != second["job_id"]
    assert second["queue_position"] == 1 and cancelled["cancelled"] and cancelled["status"] == "cancelled"
    assert {j["job_id"] for j in listed["jobs"]} == {first["job_id"], second["job_id"]}
    assert unknown.is_error
    assert st["status"] == "done" and st["result"]["company"] == "First" and len(st["log_tail"]) == 3
    assert st["elapsed_seconds"] > 0 and st["finished_at"]


def test_analyze_and_profile(server):
    async def go():
        async with Client(server) as c:
            a = payload(await c.call_tool("analyze_jd", {"jd_text": JD}))
            p = payload(await c.call_tool("get_profile", {}))
            pr = (await c.read_resource("resuma://profile")).contents[0]
            return a, p, pr

    a, p, pr = run(go())
    assert a["role_title"] == "Backend Engineer" and {k["term"] for k in a["keywords"]} >= {"Python", "Elixir"}
    assert p["name"] and p["skills_pool"] and json.loads(pr.text)["name"] == p["name"]
