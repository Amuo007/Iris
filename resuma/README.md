# resuma

A harness that tailors **one fixed LaTeX resume template** to a job description with a **local LLM**, while keeping the
printed layout identical: one page, every bullet and skills row occupying exactly the same number of lines as the original.

It exists for an educational website: students pick a job description and see what an honest resume tailored to it looks
like, including a diff of what changed and which JD keywords were covered.

## How it works

1. `data/profile.json` holds the facts (contact, education, roles, a pool of projects, a pool of skills).
   `data/template/resume.tex.j2` holds the layout. The model never touches LaTeX; everything it writes is plain text that
   is escaped before rendering.
2. The template is instrumented with layout-neutral hooks: after each slot LaTeX writes `RESUMA|<slot>|lines=N|width=W|linewidth=L`
   to the log, so TeX itself reports how many lines every bullet took. The identity render of the profile reproduces the
   original PDF with a word-position deviation of 0.000pt (`tests/test_identity.py`).
3. A one-time font calibration measures every glyph, so the harness can predict a candidate bullet's width in microseconds
   and give the model precise character budgets per slot ("target 211 characters, allowed 168-227, exactly 2 lines").
4. Pipeline per JD: analyze JD → plan (projects, angles, skills rows, coursework order) → write each entry →
   fact check → predicted-fit check → compile → TeX ground truth → targeted repair prompts with exact deltas
   ("prints as 3 lines, shorten by about 24 characters") → keyword-coverage boost loop → skills polish →
   fallbacks to text that is known to fit → PDF + report.

## Truth rules the harness enforces (not just asks for)

- Every number in a bullet must appear in that entry's facts.
- Named technologies (CamelCase, acronyms, product names) must appear in the profile; JD-only tools and
  platforms are rejected from bullets even in `jd_aware` mode.
- Any JD keyword phrase used in a bullet must be grounded: its content words must occur in that entry's facts
  (word forms count: "encrypted" in the facts grounds "encryption"). "...for operational stability" bolted onto a
  bullet is rejected and repaired.
- Skills rows may carry JD additions (flagged as gap skills, capped at 50% of items); a real skill always wins over a
  JD addition when a row has to be trimmed, and a final polish pass sorts items into coherent categories.
- Only *listable* JD terms may become skills items: tools, platforms, products and standard practice names
  ("code review", "unit testing"). The JD analysis marks each keyword `listable` true/false; expectation phrases such
  as "operational stability", "release practices" or "responsible AI" are removed from rows and from row labels
  ("SDK Distribution & Release Practices" becomes "SDK Distribution"), and the report lists them under
  `rejected_skill_items`. Such phrases can only be covered by a bullet whose facts show that work.
- Coverage is reported two ways: all non-soft keywords, and "placeable" ones (terms of at most three words a resume
  can actually list). The boost loop only chases the placeable set, so long concept phrases never get stuffed in.

## Usage

```bash
.venv/bin/python -m resuma measure                      # calibrate fonts, print slot budgets
.venv/bin/python -m resuma tailor --jd data/jd/jpmorgan_ios.txt --company "JP Morgan"
.venv/bin/python -m resuma check output/JP\ Morgan/Amrinder_Singh_JP_Morgan.tex   # re-verify any .tex
.venv/bin/python -m pytest -q
```

Output goes to `output/<Company>/`: the PDF and `.tex`, `preview.png`, `report.md` / `report.json` (coverage table, gap
skills, every slot before/after with line counts and fill), `jd.txt`, and `llm_calls/` with every prompt and answer.

Options: `--mode strict` (skills only from the profile; default `jd_aware` lets the skills section add adjacent JD skills,
flagged as gap skills and capped at 50% of all skills items), `--coverage 0.9`, `--thinking off`.

## MCP server (for the website)

The harness is exposed over the Model Context Protocol, so the website backend (or Claude Desktop / Claude Code) can
analyze a JD, start a run, watch its progress and fetch the files.

```bash
.venv/bin/python -m resuma serve                                          # stdio: Claude Desktop / Claude Code
.venv/bin/python -m resuma serve --transport streamable-http --port 8765  # http://127.0.0.1:8765/mcp for the website
```

| tool | what it does |
|---|---|
| `get_profile` | the candidate profile: everything a tailored resume may claim |
| `analyze_jd(jd_text)` | company, role, seniority, emphasis and 18-35 weighted keywords (one LLM call, about a minute) |
| `tailor_resume(jd_text, company?, mode?, coverage_target?, thinking?, wait?)` | starts a run (5-10 min) and returns the job; `wait=true` blocks, streams progress notifications and returns the result |
| `get_job(job_id, log_tail?)` | `queued` (with `queue_position`), `running` (`phase`, `progress` 0-1, `log_tail`), `done` (`result`) or `failed` (`error`) |
| `list_jobs`, `cancel_job(job_id)` | jobs since the server started; cancelling works only while a job is still queued |
| `list_runs`, `get_run(run, include_slots?)` | finished runs on disk; the full result with the JD analysis, skills rows, coursework, coverage table and every slot before/after |

A `result` carries file paths, `pages`, `layout_ok`, `coverage`, `missing_keywords`, `gap_skills`,
`rejected_skill_items` and resource URIs.
Resources: `resuma://profile`, `resuma://runs` and, per run, `resuma://runs/<run>/pdf`, `preview.png`, `tex`,
`report.md`, `report.json`, `jd.txt`, where `<run>` is the id from `list_runs` (`jp-morgan`) or the folder name.

Runs are serialized on one worker (the local model halves its throughput when two requests overlap); `get_job` reports
the queue position. Jobs live in memory; finished runs are on disk under `output/<Company>/` together with a `job.json`.

Python client (the backend side of the website, or any script):

```python
import asyncio
from mcp import Client

async def main(jd: str):
    async with Client("http://127.0.0.1:8765/mcp") as c:
        job = (await c.call_tool("tailor_resume", {"jd_text": jd, "company": "JP Morgan"})).structured_content
        while True:
            st = (await c.call_tool("get_job", {"job_id": job["job_id"]})).structured_content
            if st["status"] in ("done", "failed"):
                break
            await asyncio.sleep(15)
        pdf = (await c.read_resource(st["result"]["resources"]["pdf"])).contents[0].blob   # base64
```

Claude Desktop / Claude Code (stdio):

```json
{"mcpServers": {"resuma": {"command": "/path/to/resuma/.venv/bin/python", "args": ["-m", "resuma", "serve"],
                           "cwd": "/path/to/resuma"}}}
```

Binding beyond localhost: `--host 0.0.0.0 --allowed-host 192.168.1.10:8765` keeps DNS-rebinding protection on for that
Host header; `--no-dns-rebinding-protection` only behind your own reverse proxy. The browser should never talk to the
MCP server directly: the website backend does, and serves the PDF/PNG to the page itself. Env defaults:
`RESUMA_MCP_TRANSPORT`, `RESUMA_MCP_HOST`, `RESUMA_MCP_PORT`, `RESUMA_MCP_PATH`.

## Configuration

`.env` (see `.env.example`): `RESUMA_BASE_URL`, `RESUMA_MODEL`, `RESUMA_API_KEY` (any text if the server needs none),
`RESUMA_MAX_TOKENS`, `RESUMA_TIMEOUT`. Any OpenAI-compatible `/v1/chat/completions` endpoint works (Halogen, vLLM,
Ollama, LM Studio). Thresholds live in `resuma/config.py` (`FitConfig`: minimum last-line fill, overflow margins,
retry rounds, coverage target) and per-call token budgets in `LLMConfig`.

## Extending the profile

- Add more projects to `projects_pool`; the planner picks the three that fit the JD and the slot line patterns.
  The pool currently holds the three real projects plus eight marked `"illustrative": true`: made-up examples
  (iOS, mobile SDK, backend/cloud, ML, security, web, Android) so the website can show what a resume for each
  kind of job looks like. Remove them for a resume meant for real applications.
- Add `details` to any role/project: extra true facts the model may draw on when it needs to lengthen a bullet.
- Each pooled project needs at least three bullets (the template has three bullets per project slot). Give it
  `short_bullets` too (three one-line versions, about 90 characters): the third project slot prints one line per
  bullet, and a project without them can only land there if its bullets are already that short.

## Layout guarantees

- Page count must be 1 and every slot's line count must equal the baseline, or the run fails loudly.
- Ragged last lines (below 55% for two-line bullets, 70% for one-line bullets) are repaired; any left over are listed
  in the report as soft issues.
- Fonts, spacing and margins are never changed to make text fit; only the text is.


## Whole-resume tailoring from Iris

Iris passes company and role context, `coverage_target=0.90`, and
`project_strategy="adaptive"`. The default strategy for other MCP clients remains
`existing`. Adaptive mode first reframes existing projects; when their relevance is
weak it may propose project replacements with quantitative draft outcomes. Each
replacement must supply three full and three short bullets plus measurement
assumptions. They use the original template's measured slots. The real profile is
never changed. Reports and MCP results expose `project_drafts` with
`source="generated_draft"` and `needs_verification=true`.

Planning ranks each entry's facts with `fact_order` (one-based indexes). Experience
receives only modest rewording; its tools and metrics remain grounded in its own
facts. Keyword aliases and word forms are supported, but tools cannot migrate
between entries. Coverage improvement checks achievements separately from skills,
so listing a tool cannot satisfy a missing achievement. Overall keyword coverage,
achievement evidence, missing terms and whether the target was met are reported
separately. This is a keyword measure, not an ATS or recruiter score guarantee.


### Focused tailoring and latency controls

Planning now aims for 90% literal keyword coverage, gives the strongest role evidence
full-size project slots, and makes one bounded plan revision if multiple core tools
lack project evidence. Long stack subtitles are shortened before a relevant project
is discarded; layout fallback resets only the failing project. A final content
review checks the employer's requirements against source-backed, quoted resume
evidence and distinguishes direct, transferable and missing support. The review
is not a prediction of an employer's ATS rating. Missing or invalid review quotes
are recorded as unverified rather than silently inflating the result. Generated
project drafts remain labelled as proposals in the reports.

Latency controls disable long model thinking passes for structured planning,
bullet writing and cosmetic polish, stop identical repair retries, and cap content
review edits to four. PDF compilation, exact one-page checks, measured line counts,
source-number/tool validation and fallbacks remain enabled.
