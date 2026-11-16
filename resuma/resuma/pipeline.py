"""The tailoring pipeline: analyze JD -> plan -> write -> compile & verify -> repair -> coverage boost -> outputs."""
from __future__ import annotations

import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from copy import deepcopy
from pathlib import Path

from . import config, prompts
from .config import FitConfig, LLMConfig
from .latex import CompileResult, compile_tex, render_png
from .llm import BaseLLM, LLMError
from .metrics import FontMetrics
from .profile import Profile, Project, load_profile
from .render import N_PROJECTS, N_SKILL_ROWS, Content, EntryContent, ProjectContent, SkillRowContent, render_tex
from .report import build_report, write_report
from .schemas import Analysis, BoostOut, BulletOut, BulletsOut, Guidance, Plan, PolishOut, ReviewOut, SkillsRowPlan
from .slots import COURSEWORK_LABEL, SlotBook, SlotEval
from .texttools import clean_llm_text, contains_term, is_tech_shaped, norm, number_tokens, proper_terms, same_root, words


def safe_name(s: str) -> str:
    s = re.sub(r"[^\w\s&+.-]", "", s or "").strip()
    return re.sub(r"\s+", " ", s) or "Company"


_ENGLISH: set[str] | None = None


def english_words() -> set[str]:
    global _ENGLISH
    if _ENGLISH is None:
        p = Path("/usr/share/dict/words")
        _ENGLISH = {w.strip().lower() for w in p.read_text(errors="ignore").splitlines()} if p.exists() else set()
    return _ENGLISH


def keyword_present(text, keyword):
    # A common noun must not accidentally count as a vendor ("streaming answer box" is not Box).
    terms = [keyword.term, *keyword.aliases]
    if keyword.kind == "tool" and keyword.term in {"Box", "Go", "R", "Swift", "Bun"}:
        return any(re.search(r"(?<![\w])" + re.escape(term) + r"(?![\w])", text) for term in terms if term)
    return any(contains_term(text, term) for term in terms if term)


class FactChecker:
    """Numbers must come from the entry's facts. Named technologies (tools, frameworks, platform features) must come
    from the current entry (including generated draft facts, when explicitly enabled). Keyword aliases and
    word forms may reframe supported concepts; another entry's tools and measurements cannot be borrowed."""

    def __init__(self, profile: Profile, jd_text: str, mode: str):
        self.jd = jd_text
        self.mode = mode
        self.keyword_kinds: dict[str, str] = {}
        self.keywords = []
        self.semantic_paraphrases = {}

    def set_keywords(self, keywords) -> None:
        self.keywords = list(keywords)
        for k in self.keywords:
            for t in [k.term, *k.aliases]:
                if t:
                    self.keyword_kinds[norm(t)] = k.kind

    def _kind(self, term: str) -> str | None:
        n = norm(term)
        if n in self.keyword_kinds:
            return self.keyword_kinds[n]
        for key, kind in self.keyword_kinds.items():
            if contains_term(key, term) or contains_term(term, key):
                return kind
        return None

    def supports(self, keyword, facts: str) -> bool:
        if keyword.kind in ("concept", "practice") and norm(keyword.term) in self.semantic_paraphrases.get(facts, set()):
            return True
        terms = [keyword.term, *keyword.aliases]
        if keyword_present(facts, keyword):
            return True
        if keyword.kind in ("tool", "domain", "soft"):
            return False
        fact_words = re.findall(r"[a-z][\w+#.-]*", facts.lower())
        for term in terms:
            content = [w for w in re.findall(r"[a-z][\w+#.-]*", term.lower()) if len(w) > 3]
            if content and all(any(w == f or same_root(w, f) for f in fact_words) for w in content):
                return True
        return False

    def check(self, text: str, facts: str) -> tuple[list[str], list[str]]:
        problems: list[str] = []
        jd_terms: list[str] = []
        allowed = number_tokens(facts)
        cores = {a.strip("~%+") for a in allowed}
        for n in sorted(number_tokens(text)):
            core = n.strip("~%+")
            if n in allowed or core in cores:
                continue
            problems.append(f'the number or version "{n}" does not appear in this entry\'s facts; remove it or use only numbers from the facts')
        eng = english_words()
        fact_tokens = {piece.lower() for token in words(facts)
                       for piece in re.split(r"[/.\-()+,:;]", token) if piece}
        for t in sorted(proper_terms(text)):
            pieces = [p for p in re.split(r"[/.\-()+,:;]", t) if p]
            if not pieces or all(piece.lower() in fact_tokens or contains_term(facts, piece) or any(
                    norm(piece) == norm(k.term) and self.supports(k, facts) for k in self.keywords)
                    for piece in pieces):
                continue
            tech = is_tech_shaped(t) or not all(p.lower() in eng for p in pieces)
            in_jd = contains_term(self.jd, t) or all(contains_term(self.jd, p) for p in pieces)
            kind = self._kind(t) if in_jd else None
            if in_jd and self.mode != "strict" and kind not in ("tool", "domain") and not tech:
                jd_terms.append(t)  # a JD concept/practice phrase; allowed, reported
                continue
            if in_jd and self.mode == "strict":
                problems.append(f'"{t}" is a job-description term that this entry\'s facts do not support; it is not allowed')
            else:
                problems.append(f'"{t}" is not in the candidate\'s facts; do not claim tools, platforms, frameworks or device '
                                f'features the candidate did not use, even if the job description asks for them')
        # Check even short/lowercase tools (Go, R, SQL); canonical spellings may be grounded by JD aliases.
        for k in self.keywords:
            if keyword_present(text, k) and not self.supports(k, facts):
                problems.append(f'"{k.term}" is not supported by this entry\'s facts; remove it (do not claim it)')
        return problems, jd_terms


@dataclass
class SlotMeta:
    facts: str
    keywords: list[str]
    angle: str
    entry_id: str
    original: str


@dataclass
class Coverage:
    ratio: float            # weighted coverage of every non-soft keyword (what the report shows)
    covered: list[dict]
    missing: list[dict]
    total_weight: int
    ratio_placeable: float  # same, restricted to short terms a resume can list
    ratio_body: float = 0.0  # all requirements asking for bullet evidence, skills excluded
    ratio_body_supported: float = 1.0  # achievable evidence from the selected entries
    body_missing: list[dict] = field(default_factory=list)


def placeable(k) -> bool:
    return k.kind != "soft" and len(k.term.split()) <= 3


def listable(k) -> bool:
    return k.is_listable()


LABEL_SPLIT = re.compile(r"\s*(?:&|/|,|\band\b)\s*")


class Tailor:
    def __init__(self, jd_text: str, llm: BaseLLM, *, profile: Profile | None = None, fit: FitConfig | None = None,
                 fm: FontMetrics | None = None, slotbook: SlotBook | None = None, log=None):
        self.jd = jd_text.strip()
        self.llm = llm
        self.profile = (profile or load_profile()).model_copy(deep=True)
        self.fit = fit or FitConfig()
        self.fm = fm or FontMetrics.load_or_calibrate()
        self.book = slotbook or SlotBook.baseline(self.profile, self.fm, self.fit)
        self.log = log or (lambda m: print(m, file=sys.stderr, flush=True))
        self.checker = FactChecker(self.profile, self.jd, self.fit.mode)
        self.vocab = self.profile.vocabulary()
        self.analysis: Analysis | None = None
        cfg = getattr(llm, "cfg", None) or LLMConfig()
        self.cfg = cfg
        self.temp_write, self.temp_analyze = cfg.temperature_write, cfg.temperature_analyze
        self.warnings: list[str] = []
        self.fallbacks: list[str] = []
        self.jd_terms_in_bullets: dict[str, list[str]] = {}
        self.soft_issues: dict[str, list[str]] = {}
        self._dropped_items: set[str] = set()
        self.generated_projects: list[dict] = []
        self.requirement_review: dict = {}
        self.compiles = 0
        self.workdir = config.BUILD / f"run_{os.getpid()}_{id(self) % 10000}"
        self.t0 = time.time()

    def _log(self, msg: str) -> None:
        self.log(f"[{time.time() - self.t0:6.1f}s] {msg}")

    # ------------------------------------------------------------------ run
    def run(self, company: str | None = None, out_root: Path = config.OUTPUT) -> dict:
        self.t0 = time.time()
        self._log("analyzing the job description")
        analysis = self.llm.chat_json(prompts.SYSTEM, prompts.analyze_jd(self.jd), Analysis,
                                      temperature=self.temp_analyze, tag="analyze",
                                      max_tokens=self.cfg.tokens_analyze, thinking=False)
        self.checker.set_keywords(analysis.keywords)
        self.analysis = analysis
        company = safe_name(company or analysis.company or "Company")
        self._log(f"company={company!r} role={analysis.role_title!r} keywords={len(analysis.keywords)}")
        plan = self.make_plan(analysis)
        self.prepare_projects(plan)
        content, meta = self.build_content(plan)
        self.write_entries(content, meta, plan, analysis)
        res = self.verify_and_repair(content, meta)
        cov = self.coverage(content, analysis)
        self._log(f"keyword coverage {cov.ratio:.0%} (placeable {cov.ratio_placeable:.0%}, target {self.fit.coverage_target:.0%})")
        rounds = 0
        while (cov.ratio < self.fit.coverage_target or cov.ratio_body_supported < self.fit.coverage_target) and rounds < self.fit.max_coverage_rounds:
            rounds += 1
            self._log(f"coverage boost {rounds}: missing {[m['term'] for m in cov.missing if m.get('placeable')][:12]}")
            previous = (content.model_copy(deep=True), deepcopy(meta), res, cov)
            if not self.boost(content, meta, analysis, cov, rounds):
                break
            res = self.verify_and_repair(content, meta)
            before, cov = cov, self.coverage(content, analysis)
            self._log(f"keyword coverage now {cov.ratio:.0%} (placeable {cov.ratio_placeable:.0%})")
            if cov.ratio < before.ratio or cov.ratio_body_supported < before.ratio_body_supported:
                content, meta, res, cov = previous
                self.warnings.append("coverage edits lost existing evidence; kept the previous resume")
                break
            if cov.ratio <= before.ratio and cov.ratio_body_supported <= before.ratio_body_supported:
                self._log("  this round gained nothing; what is left needs facts the profile does not have")
                break
        keep = (content.model_copy(deep=True), res, cov)
        if self.polish_skills(content):
            res = self.verify_and_repair(content, meta)
            cov = self.coverage(content, analysis)
            self._log(f"after skills polish: coverage {cov.ratio:.0%} (placeable {cov.ratio_placeable:.0%})")
            if cov.ratio < keep[2].ratio or cov.ratio_body_supported < keep[2].ratio_body_supported:
                # the polish is cosmetic; it must not cost keywords the boost loop just placed
                self._log(f"  polish dropped coverage from {keep[2].ratio_placeable:.0%}; keeping the rows from before it")
                self.warnings.append("skills polish lowered keyword coverage and was discarded")
                content, res, cov = keep
                self.soft_issues = {}
        if self.fit.semantic_review:
            content, meta, res, cov = self.review_content(content, meta, res, cov, analysis)
        return self.finalize(company, out_root, analysis, plan, content, meta, res, cov)

    # ------------------------------------------------------------------ plan
    def make_plan(self, analysis: Analysis) -> Plan:
        P = self.profile
        summary = {
            "experience": [{"id": e.id, "title": e.title, "org": e.org, "dates": e.dates, "bullets": e.bullets,
                            "details": e.details, "tags": e.tags} for e in P.experience],
            "projects_pool": [{"id": p.id, "title": p.title, "dates": p.dates, "bullets": p.bullets,
                               "bullet_lengths": [len(b) for b in p.bullets],
                               "has_one_line_versions": bool(p.short_bullets), "details": p.details, "tags": p.tags}
                              for p in P.projects_pool],
            "skills_pool": [{"label": r.label, "items": r.items} for r in P.skills_pool],
            "coursework_pool": P.education.coursework_pool,
        }
        pattern = [self.book.bullet_line_pattern(f"proj{i}") for i in range(1, N_PROJECTS + 1)]
        row_budgets = []
        for k in range(1, N_SKILL_ROWS + 1):
            label = P.skills_pool[k - 1].label if k - 1 < len(P.skills_pool) else "Skills"
            b = self.book.budget(f"skills.{k}", label)
            row_budgets.append((b.min_chars, b.max_chars))
        self._log("planning projects, angles and skills rows")
        plan_system = prompts.SYSTEM
        if self.fit.project_strategy == "adaptive":
            plan_system += ("\nEXCEPTION FOR THE PLANNING RESPONSE'S project_drafts ONLY: the user has requested "
                            "hypothetical project replacements when existing projects do not fit the JD. You may "
                            "design new project scopes and plausible assumed benchmark numbers in project_drafts. "
                            "These are generated proposals, labelled for verification in the report, not claims about "
                            "completed work. All experience and existing-project truth rules remain in force.")
        plan_prompt = prompts.plan(summary, analysis, N_PROJECTS, pattern, row_budgets,
                                                                self.fit.mode, self.fit.project_strategy,
                                                                [[self.book.budget(f"proj{i}.b{j}").describe()
                                                                  for j in range(1, len(pattern[i - 1]) + 1)]
                                                                 for i in range(1, N_PROJECTS + 1)], self.fit.coverage_target)
        plan = self.llm.chat_json(plan_system, plan_prompt, Plan, temperature=self.temp_analyze, tag="plan",
                                 max_tokens=self.cfg.tokens_plan, thinking=self.cfg.think_plan)
        candidates = {p.id: p for p in [*P.projects_pool, *plan.project_drafts]}
        selected = [candidates[pid].facts_text() for pid in plan.projects if pid in candidates]
        core_gaps = [k.term for k in analysis.hard_keywords() if k.kind == "tool" and k.weight == 3
                     and k.where != "skills" and not any(self.checker.supports(k, facts) for facts in selected)]
        if self.fit.project_strategy == "adaptive" and len(core_gaps) >= 2:
            self._log("strengthening project plan for core gaps: " + ", ".join(core_gaps))
            plan = self.llm.chat_json(plan_system, plan_prompt + "\nThe first plan leaves these core technologies "
                "without project achievement evidence: " + ", ".join(core_gaps) +
                ". Return a revised complete plan. Use one or two coherent generated project DRAFTS to demonstrate "
                "these responsibilities together, replacing the least relevant or redundant existing projects. "
                "Name the language and core technologies in each draft's actual facts, not just tags or skills. "
                "Put the principal draft in a full-size slot. Include at least two quantitative benchmark outcomes "
                "and their measurement assumptions. Do not change real employment facts.",
                Plan, temperature=self.temp_analyze, tag="plan_refine", max_tokens=self.cfg.tokens_plan, thinking=False)
        return plan

    def prepare_projects(self, plan: Plan) -> None:
        """Drafts are per-run only; the real profile and measured template are never overwritten."""
        if self.fit.project_strategy != "adaptive":
            if plan.project_drafts:
                self.warnings.append("ignored generated projects because project_strategy is existing")
            plan.project_drafts = []
            return
        existing = {p.id for p in self.profile.projects_pool}
        replacements = {}
        for draft in plan.project_drafts[:N_PROJECTS]:
            if draft.replaces not in existing or draft.replaces in replacements or not draft.title.strip():
                self.warnings.append(f"ignored invalid project draft {draft.id!r}")
                continue
            if len(draft.bullets) != 3 or len(draft.short_bullets) != 3:
                self.warnings.append(f"ignored project draft {draft.id!r}: needs three full and short bullets")
                continue
            if not draft.details or sum(bool(number_tokens(b)) for b in draft.bullets) < 2:
                self.warnings.append(f"ignored project draft {draft.id!r}: needs measurement assumptions and quantitative bullets")
                continue
            pid = "generated-" + re.sub(r"[^a-z0-9]+", "-", draft.id.lower()).strip("-")
            if pid == "generated-" or pid in {p.id for p in self.profile.projects_pool}:
                continue
            project = Project.model_validate(dict(draft.model_dump(), id=pid, dates=""))
            self.profile.projects_pool.append(project)
            replacements[draft.replaces] = pid
            plan.projects = [pid if p == draft.id else p for p in plan.projects]
            if draft.id in plan.project_guidance:
                plan.project_guidance[pid] = plan.project_guidance[draft.id]
            self.generated_projects.append(dict(project.model_dump(), replaces=draft.replaces,
                                                source="generated_draft", needs_verification=True))
        plan.projects = [replacements.get(p, p) for p in plan.projects]

    # ------------------------------------------------------------------ content skeleton
    def head_fits(self, slot_id: str, title: str, subtitle: str, dates: str) -> bool:
        w = self.fm.width(title, bold=True) + (self.fm.width(", " + subtitle) if subtitle else 0.0) \
            + self.fm.width("  ") + self.fm.width(dates, bold=True)
        return w <= self.book.slots[slot_id].linewidth_pt * 0.97

    @staticmethod
    def ordered_facts(bullets: list[str], guidance: Guidance, count: int) -> list[str]:
        indexes = []
        for i in guidance.fact_order:
            if 1 <= i <= len(bullets) and i not in indexes:
                indexes.append(i)
        indexes += [i for i in range(1, len(bullets) + 1) if i not in indexes]
        return ([bullets[i - 1] for i in indexes] + [""] * count)[:count]

    def build_content(self, plan: Plan) -> tuple[Content, dict[str, SlotMeta]]:
        P = self.profile
        pool_ids = [p.id for p in P.projects_pool]
        chosen: list[str] = []
        for pid in plan.projects:
            pid = (pid or "").strip()
            if pid in pool_ids and pid not in chosen:
                chosen.append(pid)
        for pid in pool_ids:
            if len(chosen) >= N_PROJECTS:
                break
            if pid not in chosen:
                chosen.append(pid)
        chosen = chosen[:N_PROJECTS]
        # Place core role evidence in the largest slots, regardless of the planner's incidental ID ordering.
        if self.analysis and self.fit.project_strategy == "adaptive":
            def relevance(pid):
                facts = P.project(pid).facts_text()
                return sum(k.weight * (3 if k.weight == 3 else 1) for k in self.analysis.hard_keywords()
                           if self.checker.supports(k, facts))
            ranked = sorted(chosen, key=relevance, reverse=True)
            capacity = sorted(range(len(chosen)), key=lambda i: -sum(self.book.bullet_line_pattern(f"proj{i + 1}")))
            arranged = list(chosen)
            for index, pid in zip(capacity, ranked):
                arranged[index] = pid
            chosen = arranged
        spare = [pid for pid in pool_ids if pid not in chosen]
        projects: list[ProjectContent] = []
        for i, pid in enumerate(chosen, 1):
            p = P.project(pid)
            while True:
                subtitle = p.subtitle
                while subtitle and not self.head_fits(f"proj{i}.head", p.title, subtitle, p.dates):
                    subtitle = subtitle.rsplit(",", 1)[0].strip() if "," in subtitle else ""
                if self.head_fits(f"proj{i}.head", p.title, subtitle, p.dates):
                    if subtitle != p.subtitle:
                        self.warnings.append(f"shortened project '{p.title}' subtitle to keep its heading on one line")
                        p = p.model_copy(update={"subtitle": subtitle})
                    break
                if not spare:
                    break
                self.warnings.append(f"project '{p.title}' heading does not fit on one line in slot {i}; swapped out")
                p = P.project(spare.pop(0))
            pattern = self.book.bullet_line_pattern(f"proj{i}")
            n = len(pattern)
            src = p.bullets_for(pattern)
            if len(src) < n:
                self.warnings.append(f"project '{p.title}' has {len(src)} bullets but slot {i} needs {n}")
            projects.append(ProjectContent(id=p.id, title=p.title, subtitle=p.subtitle, dates=p.dates,
                                           bullets=self.ordered_facts(src, plan.project_guidance.get(p.id, Guidance()), n)))
        pool_cw = P.education.coursework_pool
        ordered: list[str] = []
        for c in plan.coursework:
            match = next((pc for pc in pool_cw if norm(pc) == norm(c)), None)
            if match and match not in ordered:
                ordered.append(match)
        ordered += [c for c in pool_cw if c not in ordered]
        skills = self.fit_skill_rows(plan.skills_rows)
        experience = []
        for i, e in enumerate(P.experience, 1):
            n = len(self.book.bullet_line_pattern(f"exp{i}"))
            experience.append(EntryContent(id=e.id, title=e.title, org=e.org, qualifier=e.qualifier, dates=e.dates,
                                           bullets=self.ordered_facts(e.bullets, plan.experience_guidance.get(e.id, Guidance()), n)))
        content = Content(coursework=ordered, experience=experience, projects=projects, skills=skills)
        meta: dict[str, SlotMeta] = {}
        for i, e in enumerate(P.experience, 1):
            g = plan.experience_guidance.get(e.id, Guidance())
            for j, b in enumerate(experience[i - 1].bullets, 1):
                meta[f"exp{i}.b{j}"] = SlotMeta(e.facts_text(), list(g.keywords), g.angle, e.id, b)
        for i, pc in enumerate(projects, 1):
            p = P.project(pc.id)
            g = plan.project_guidance.get(p.id, Guidance())
            for j, b in enumerate(pc.bullets, 1):
                meta[f"proj{i}.b{j}"] = SlotMeta(p.facts_text(), list(g.keywords), g.angle, p.id, b)
        return content, meta

    # ------------------------------------------------------------------ skills rows (deterministic fitting)
    @staticmethod
    def _dup(item: str, used: list[str]) -> bool:
        return any(norm(u) == norm(item) or contains_term(u, item) or contains_term(item, u) for u in used)

    def _in_pool(self, item: str) -> bool:
        """Backed by the profile: a pooled skill, part of one, or made only of words the profile already uses."""
        if any(norm(p) == norm(item) or contains_term(p, item) for p in self.profile.all_skill_items()):
            return True
        ws = [w.lower() for w in re.findall(r"[A-Za-z][\w+#.-]*", item) if len(w) > 1]
        return bool(ws) and all(w in self.vocab or w.rstrip("s") in self.vocab for w in ws)

    def _matching_keywords(self, item: str) -> list[tuple[int, int, object]]:
        """JD keywords the skills item names, best match first: exact spelling, then the longest term inside the item,
        then terms that contain the item. Each entry is (rank, -len(term), keyword)."""
        found: dict[int, tuple[int, int, object]] = {}
        for k in (self.analysis.keywords if self.analysis else []):
            for t in [k.term, *k.aliases]:
                if not t:
                    continue
                if norm(t) == norm(item):
                    rank = 0
                elif contains_term(item, t):
                    rank = 1
                elif contains_term(t, item):
                    rank = 2
                else:
                    continue
                cand = (rank, -len(t), k)
                if id(k) not in found or cand < found[id(k)]:
                    found[id(k)] = cand
        return sorted(found.values(), key=lambda c: c[:2])

    def _keyword_for(self, item: str, *, within: bool = True):
        """The JD keyword an item names. By default only exact matches or terms inside the item count: a label part
        "Security" is not "mobile application security"."""
        m = [c for c in self._matching_keywords(item) if c[0] <= (1 if within else 2)]
        return m[0][2] if m else None

    def _relevance(self, item: str) -> int:
        """Highest weight of any JD keyword the skills item matches (0 = not asked for by the JD)."""
        return max([k.weight for _, _, k in self._matching_keywords(item) if k.kind != "soft"], default=0)

    def _pooled(self, item: str) -> bool:
        """The item is one of the profile's own skills items (or part of one), not merely made of profile words."""
        return any(norm(p) == norm(item) or contains_term(p, item) for p in self.profile.all_skill_items())

    def _listable(self, item: str) -> bool:
        """May the item sit in a skills row? The candidate's own skills always. A JD term only when a recruiter would
        scan for it (see listable()). Anything else (an expectation phrase, a soft skill, an invented item) never."""
        if self._pooled(item):
            return True
        k = self._keyword_for(item)
        if k is not None:
            return listable(k)
        return self._in_pool(item)   # a re-spelling of profile content ("Git/GitHub"); a pure invention is dropped

    def _clean_label(self, label: str, fallback: str | None) -> str:
        """Drop the parts of a row label that quote a JD phrase which is not a skills-list term ("SDK Distribution &
        Release Practices" -> "SDK Distribution"); if nothing honest is left, use the matching pool label."""
        parts = [x.strip() for x in LABEL_SPLIT.split(label) if x and x.strip()]
        if len(parts) <= 1:
            k = self._keyword_for(label)
            bad = k is not None and not listable(k) and not self._pooled(label)
            return (fallback or label) if bad else label
        keep = []
        for part in parts:
            k = self._keyword_for(part)
            if k is not None and not listable(k) and not self._pooled(part):
                continue
            keep.append(part)
        if not keep:
            return fallback or label
        if keep == parts:
            return label
        return " & ".join(keep)

    def _item_score(self, item: str) -> int:
        """Keep-priority of a skills item: JD relevance matters, but a real skill always beats a JD addition of equal weight."""
        return 2 * self._relevance(item) + (2 if self._in_pool(item) else 0)

    def _trim_row(self, items: list[str], used: list[str], limit: float) -> None:
        """Drop items until the row fits: lowest keep-priority first, later position first among equals."""
        while items and self.fm.width(", ".join(items)) > limit:
            victim = min(range(len(items)), key=lambda i: (self._item_score(items[i]), -i))
            it = items.pop(victim)
            if it in used:
                used.remove(it)

    def _pool_row_for(self, label: str):
        """The profile skills row whose label best matches (exact, else most shared words); None if nothing overlaps."""
        best, best_score = None, 0
        want = {w for w in re.findall(r"[a-z]+", norm(label)) if w not in ("and", "or")}
        for pr in self.profile.skills_pool:
            if norm(pr.label) == norm(label):
                return pr
            have = {w for w in re.findall(r"[a-z]+", norm(pr.label)) if w not in ("and", "or")}
            score = len(want & have)
            if score > best_score:
                best, best_score = pr, score
        return best

    def fit_skill_rows(self, rows_plan: list[SkillsRowPlan]) -> list[SkillRowContent]:
        P = self.profile
        rows = [SkillsRowPlan(label=r.label.strip().rstrip(":"), items=[i.strip() for i in r.items if i and i.strip()])
                for r in rows_plan if r.label and r.label.strip()][:N_SKILL_ROWS]
        for k, r in enumerate(rows):
            pool_row = self._pool_row_for(r.label) or (P.skills_pool[k] if k < len(P.skills_pool) else None)
            r.label = self._clean_label(r.label, pool_row.label if pool_row else None)
        labels = {norm(r.label) for r in rows}
        for pr in P.skills_pool:
            if len(rows) >= N_SKILL_ROWS:
                break
            if norm(pr.label) not in labels:
                rows.append(SkillsRowPlan(label=pr.label, items=list(pr.items)))
                labels.add(norm(pr.label))
        used: list[str] = []
        out: list[SkillRowContent] = []
        for k, r in enumerate(rows, 1):
            sid = f"skills.{k}"
            items: list[str] = []
            for it in r.items:
                if self._dup(it, used):
                    continue
                if self.fit.mode == "strict" and not self._in_pool(it):
                    continue
                if not self._listable(it):   # a JD expectation phrase, a soft skill or an invention: never a skills item
                    self._dropped_items.add(it)
                    continue
                items.append(it)
                used.append(it)
            b = self.book.budget(sid, r.label)
            self._trim_row(items, used, b.max_width)
            if self.fm.width(", ".join(items)) < b.min_width:
                pool_row = self._pool_row_for(r.label)
                candidates = list(pool_row.items) if pool_row else []
                for cand in candidates:
                    if self.fm.width(", ".join(items)) >= b.min_width:
                        break
                    if self._dup(cand, used):
                        continue
                    if self.fm.width(", ".join(items + [cand])) <= b.max_width:
                        items.append(cand)
                        used.append(cand)
            out.append(SkillRowContent(label=r.label, items=items))
        self._cap_gap_skills(out)
        return out

    def _cap_gap_skills(self, rows: list[SkillRowContent]) -> None:
        """Keep JD-only additions below max_gap_fraction of all items; drop the lowest-priority ones (row ends first)."""
        def gaps(r):
            return [i for i in r.items if not self._in_pool(i)]
        total = sum(len(r.items) for r in rows)
        n_gap = sum(len(gaps(r)) for r in rows)
        while total and n_gap / total > self.fit.max_gap_fraction:
            all_gaps = [(self._relevance(i), -k, i, r) for k, r in enumerate(rows) for i in gaps(r)]
            if not all_gaps:
                break
            _, _, item, row = min(all_gaps)
            row.items.remove(item)
            total -= 1
            n_gap -= 1
        for k, r in enumerate(rows, 1):  # refill rows that got short from the matching pool category
            b = self.book.budget(f"skills.{k}", r.label)
            used = [i for rr in rows for i in rr.items]
            pool_row = self._pool_row_for(r.label)
            for cand in (list(pool_row.items) if pool_row else []):
                if self.fm.width(", ".join(r.items)) >= b.min_width:
                    break
                if not self._dup(cand, used) and self.fm.width(", ".join(r.items + [cand])) <= b.max_width:
                    r.items.append(cand)
                    used.append(cand)

    # ------------------------------------------------------------------ writing
    @staticmethod
    def _present(text: str, terms: list[str]) -> bool:
        return any(contains_term(text, t) for t in terms if t)

    def covered_terms(self, content: Content, analysis: Analysis) -> list[str]:
        text = content.full_text()
        return [k.term for k in analysis.keywords if self._present(text, [k.term, *k.aliases])]

    def pick_keywords(self, analysis: Analysis, guidance: Guidance, covered: list[str],
                      facts: str, limit: int = 5) -> list[str]:
        # Guidance is a preference, not permission to attribute another project's tools to this entry.
        supported = [k for k in analysis.hard_keywords() if k.where != "skills" and self.checker.supports(k, facts)]
        supported.sort(key=lambda k: (-k.weight, k.term in covered, k.term not in guidance.keywords))
        return [k.term for k in supported[:limit]]

    def write_entries(self, content: Content, meta: dict[str, SlotMeta], plan: Plan, analysis: Analysis) -> None:
        P = self.profile
        covered = []
        jobs = [("experience", f"exp{i}", e) for i, e in enumerate(content.experience, 1)] + \
               [("project", f"proj{i}", p) for i, p in enumerate(content.projects, 1)]
        for kind, prefix, ent in jobs:
            src = next(e for e in P.experience if e.id == ent.id) if kind == "experience" else P.project(ent.id)
            guidance = (plan.experience_guidance if kind == "experience" else plan.project_guidance).get(ent.id, Guidance())
            slot_ids = [f"{prefix}.b{j}" for j in range(1, len(ent.bullets) + 1)]
            budgets = [self.book.budget(s) for s in slot_ids]
            kws = self.pick_keywords(analysis, guidance, covered, src.facts_text())
            org = getattr(src, "org", getattr(src, "subtitle", ""))
            self._log(f"writing {prefix} ({src.title}) with keywords {kws}")
            out = self.llm.chat_json(prompts.SYSTEM, prompts.write_entry(kind, src.title, org, src.dates, ent.bullets,
                                                                          src.details, guidance, kws, covered, budgets,
                                                                          analysis), BulletsOut,
                                     temperature=self.temp_write, tag=f"write_{prefix}",
                                     max_tokens=self.cfg.tokens_write, thinking=self.cfg.think_write)
            bullets = [clean_llm_text(b) for b in out.bullets][:len(slot_ids)]
            while len(bullets) < len(slot_ids):
                bullets.append(meta[slot_ids[len(bullets)]].original)
            for sid, text in zip(slot_ids, bullets):
                m = meta[sid]
                m.keywords = list(kws)
                fixed = self.precompile_repair(sid, text or m.original, m, fallback=m.original)
                content.set_slot(sid, fixed)
            body = " ".join(text for sid, text in content.slot_text().items() if sid in meta)
            covered = [k.term for k in analysis.keywords if self._present(body, [k.term, *k.aliases])]

    def precompile_repair(self, sid: str, text: str, m: SlotMeta, fallback: str) -> str:
        for attempt in range(self.fit.max_rounds_precompile + 1):
            problems, jd_terms = self.checker.check(text, m.facts)
            ev = self.book.evaluate(sid, text)
            all_problems = problems + ev.problems
            if not all_problems:
                if jd_terms:
                    self.jd_terms_in_bullets[sid] = sorted(set(jd_terms))
                return text
            if attempt == self.fit.max_rounds_precompile:
                break
            self._log(f"  {sid}: {'; '.join(p[:110] for p in all_problems)} -> repair {attempt + 1}")
            out = self.llm.chat_json(prompts.SYSTEM, prompts.repair_bullet(text, all_problems, m.facts, m.keywords,
                                                                            self.book.budget(sid)), BulletOut,
                                     temperature=self.temp_write, tag=f"repair_{sid}",
                                     max_tokens=self.cfg.tokens_repair, thinking=self.cfg.think_write)
            candidate = self.pick_candidate(sid, out.candidates(), m.facts) or text
            if norm(candidate) == norm(text):
                self._log(f"  {sid}: repair repeated the same text; proceeding to compile verification")
                break
            text = candidate
        problems, jd_terms = self.checker.check(text, m.facts)
        if problems:
            self._log(f"  {sid}: facts still wrong after retries -> keeping fallback text")
            self.fallbacks.append(f"{sid}: kept previous text because the rewrite failed the fact check ({problems[0][:90]})")
            return fallback
        if jd_terms:
            self.jd_terms_in_bullets[sid] = sorted(set(jd_terms))
        return text  # length may still be off; the compile loop is the judge

    # ------------------------------------------------------------------ compile & verify
    def compile(self, content: Content) -> CompileResult:
        self.compiles += 1
        res = compile_tex(render_tex(self.profile, content), self.workdir, f"run{self.compiles:02d}")
        if not res.ok:
            raise RuntimeError(f"LaTeX failed: {res.errors[:3]}\n{res.log[-1500:]}")
        return res

    @staticmethod
    def _slot_line_index(tex: str) -> list[tuple[int, str]]:
        idx = []
        for n, line in enumerate(tex.splitlines(), 1):
            m = re.search(r"\\resuma(?:Item|Row)\{([^}]+)\}", line)
            if m:
                idx.append((n, m.group(1)))
        return idx

    def evaluate_compiled(self, content: Content, res: CompileResult) -> dict[str, SlotEval]:
        labels = {f"skills.{k}": r.label for k, r in enumerate(content.skills, 1)}
        labels["edu.coursework"] = COURSEWORK_LABEL
        texts = content.slot_text()
        idx = self._slot_line_index(res.tex.read_text(encoding="utf-8"))
        over: dict[str, float] = {}
        for pt, a, _b in res.overfull:
            sid = None
            for ln, s in idx:
                if ln <= a:
                    sid = s
                else:
                    break
            if sid:
                over[sid] = max(over.get(sid, 0.0), pt)
        out: dict[str, SlotEval] = {}
        for sid, slot in self.book.slots.items():
            m = res.measures.get(sid)
            if m is None or slot.kind == "fixed":
                continue
            if slot.kind == "head":
                if m.lines != slot.target_lines or over.get(sid, 0.0) > 0.5:
                    out[sid] = SlotEval(sid, False, True, [f"heading prints as {m.lines} line(s)"], m.lines, m.est_lines,
                                        m.last_line_fill, "compiled")
                continue
            ev = self.book.evaluate(sid, texts.get(sid, ""), labels.get(sid), measure=m, overfull_pt=over.get(sid, 0.0))
            if not ev.ok:
                out[sid] = ev
        return out

    def verify_and_repair(self, content: Content, meta: dict[str, SlotMeta]) -> CompileResult:
        res = self.compile(content)
        for rnd in range(self.fit.max_rounds_compile + 1):
            failing = self.evaluate_compiled(content, res)
            self._log(f"compile #{self.compiles}: pages={res.pages}, slot issues={len(failing)}"
                      + (f" {sorted(failing)}" if failing else ""))
            if res.pages == 1 and not failing:
                self.soft_issues = {}
                return res
            if rnd == self.fit.max_rounds_compile:
                break
            texts = content.slot_text()
            before = content.model_dump_json()
            for sid, ev in failing.items():
                slot = self.book.slots[sid]
                if slot.kind == "bullet":
                    content.set_slot(sid, self.repair_from_compile(sid, texts[sid], ev, meta[sid]))
                elif slot.kind == "skills":
                    self.fix_row(content, sid, ev, res)
                elif slot.kind == "coursework":
                    content.coursework = list(self.profile.education.coursework_pool)
                elif slot.kind == "head":
                    self.revert_projects(content, meta, f"{sid} does not fit on one line", prefix=sid.split(".")[0])
            if content.model_dump_json() == before:
                self._log("  no repair changed anything; stopping the compile loop")
                break
            res = self.compile(content)
        # ---- last resort: hard failures fall back to text that is known to fit. Two tiers: first each slot's own
        # safe text; if TeX still disagrees, the whole projects section goes back to the original projects.
        for tier in (1, 2):
            failing = self.evaluate_compiled(content, res)
            hard = {s: e for s, e in failing.items() if e.hard}
            if res.pages == 1 and not hard:
                break
            texts = content.slot_text()
            reverted = False
            for sid, ev in hard.items():
                slot = self.book.slots[sid]
                if slot.kind == "bullet" and sid.startswith("exp"):
                    content.set_slot(sid, slot.original)
                    self.fallbacks.append(f"{sid}: reverted to the original bullet ({ev.problems[0]})")
                elif slot.kind == "bullet":
                    # the project's own pool bullet is acceptable as long as it has no predicted hard problem (a slightly
                    # under-filled last line beats throwing away the tailored projects section)
                    own = meta[sid].original
                    if tier == 1 and own and own != texts[sid] and not self.book.evaluate(sid, own).hard:
                        content.set_slot(sid, own)
                        self.fallbacks.append(f"{sid}: reverted to the project's own original bullet ({ev.problems[0]})")
                    elif not reverted:
                        self.revert_projects(content, meta, f"{sid}: {ev.problems[0]}", prefix=sid.split(".")[0])
                        reverted = True
                elif slot.kind == "skills":
                    self.fix_row(content, sid, ev, res, aggressive=True)
                elif slot.kind == "coursework":
                    content.coursework = list(self.profile.education.coursework_pool)
                elif slot.kind == "head" and not reverted:
                    self.revert_projects(content, meta, f"{sid} does not fit on one line", prefix=sid.split(".")[0])
                    reverted = True
            res = self.compile(content)
        failing = self.evaluate_compiled(content, res)
        hard = {s: e for s, e in failing.items() if e.hard}
        self._log(f"compile #{self.compiles}: pages={res.pages}, hard issues={len(hard)}, soft issues={len(failing) - len(hard)}")
        if res.pages != 1 or hard:
            raise RuntimeError(f"could not fit the page even after fallbacks: pages={res.pages}, hard={sorted(hard)}")
        self.soft_issues = {s: e.problems for s, e in failing.items()}
        return res

    def repair_from_compile(self, sid: str, text: str, ev: SlotEval, m: SlotMeta) -> str:
        problems = list(ev.problems)
        cur = text
        for attempt in range(2):
            self._log(f"  {sid}: {problems[0][:110]} -> fix {attempt + 1}")
            out = self.llm.chat_json(prompts.SYSTEM, prompts.repair_bullet(cur, problems, m.facts, m.keywords,
                                                                            self.book.budget(sid)), BulletOut,
                                     temperature=self.temp_write, tag=f"fix_{sid}",
                                     max_tokens=self.cfg.tokens_repair, thinking=self.cfg.think_write)
            new = self.pick_candidate(sid, out.candidates(), m.facts) or cur
            if norm(new) == norm(cur):
                break
            fp, jd_terms = self.checker.check(new, m.facts)
            pe = self.book.evaluate(sid, new)
            if not fp and not pe.problems:
                if jd_terms:
                    self.jd_terms_in_bullets[sid] = sorted(set(jd_terms))
                return new
            problems = fp + pe.problems
            if not fp:
                cur = new
        return cur

    def pick_candidate(self, sid: str, cands: list[str], facts: str) -> str:
        """The model may answer with up to three versions (bullet, shorter, shortest): take the first that passes the
        fact check and the predicted fit; otherwise the fact-clean one closest to the budget, so retries converge."""
        target = self.book.budget(sid).target_chars
        best, best_key = "", None
        for c in cands:
            c = clean_llm_text(c)
            if not c:
                continue
            fp, _ = self.checker.check(c, facts)
            ev = self.book.evaluate(sid, c)
            if not fp and not ev.problems:
                return c
            key = (len(fp) > 0, abs(len(c) - target))
            if best_key is None or key < best_key:
                best, best_key = c, key
        return best

    def fix_row(self, content: Content, sid: str, ev: SlotEval, res: CompileResult, aggressive: bool = False) -> None:
        k = int(sid.split(".")[1])
        row = content.skills[k - 1]
        b = self.book.budget(sid, row.label)
        if ev.hard:
            m = res.measures.get(sid)
            measured = (m.width_pt - self.book.label_width(self.book.slots[sid], row.label)) if m else 0.0
            err = max(0.0, measured - self.fm.width(", ".join(row.items)))
            limit = b.max_width * (0.96 if aggressive else 1.0) - err
            self._trim_row(row.items, [], limit)
        else:
            used = [i for r in content.skills for i in r.items]
            pool_row = self._pool_row_for(row.label)
            candidates = list(pool_row.items) if pool_row else []
            for cand in candidates:
                if self.fm.width(", ".join(row.items)) >= b.min_width:
                    break
                if self._dup(cand, used):
                    continue
                if self.fm.width(", ".join(row.items + [cand])) <= b.max_width:
                    row.items.append(cand)
                    used.append(cand)

    def revert_projects(self, content: Content, meta: dict[str, SlotMeta], why: str, prefix: str | None = None) -> None:
        P = self.profile
        indexes = [int(prefix[4:])] if prefix and re.fullmatch(r"proj[1-3]", prefix) else range(1, N_PROJECTS + 1)
        for i in indexes:
            p = P.projects_pool[i - 1]
            pattern = self.book.bullet_line_pattern(f"proj{i}")
            n = len(pattern)
            src = p.bullets_for(pattern)
            content.projects[i - 1] = ProjectContent(id=p.id, title=p.title, subtitle=p.subtitle, dates=p.dates,
                                                     bullets=(src + [""] * n)[:n])
            for j in range(1, n + 1):
                meta[f"proj{i}.b{j}"] = SlotMeta(p.facts_text(), [], "", p.id, src[j - 1] if j <= len(src) else "")
        self.fallbacks.append(f"{prefix or 'projects section'} reverted to the original project content ({why})")

    # ------------------------------------------------------------------ coverage
    def coverage(self, content: Content, analysis: Analysis) -> Coverage:
        slot_texts = content.slot_text()
        full = content.full_text()
        covered, missing, tw, cw, tpw, cpw = [], [], 0, 0, 0, 0
        for k in analysis.keywords:
            terms = [t for t in [k.term, *k.aliases] if t]
            where = [sid for sid, t in slot_texts.items() if keyword_present(t, k)]
            hit = bool(where) or keyword_present(full, k)
            entry = {"term": k.term, "weight": k.weight, "kind": k.kind, "where": k.where, "found_in": where,
                     "counted": k.kind != "soft", "placeable": placeable(k), "listable": listable(k)}
            if k.kind != "soft":
                tw += k.weight
                cw += k.weight if hit else 0
            if placeable(k):
                tpw += k.weight
                cpw += k.weight if hit else 0
            (covered if hit else missing).append(entry)
        entries = [*content.experience, *content.projects]
        facts = [next(e for e in self.profile.experience if e.id == ent.id).facts_text()
                 if isinstance(ent, EntryContent) else self.profile.project(ent.id).facts_text() for ent in entries]
        body_texts = {sid: text for sid, text in slot_texts.items() if sid.startswith(("exp", "proj"))}
        bw = bh = sw = sh = 0
        body_missing = []
        for k in analysis.hard_keywords():
            if k.where == "skills":
                continue
            hit = any(keyword_present(t, k) for t in body_texts.values())
            supported = any(self.checker.supports(k, f) for f in facts)
            bw += k.weight
            bh += k.weight if hit else 0
            if supported:
                sw += k.weight
                sh += k.weight if hit else 0
            if not hit:
                body_missing.append({"term": k.term, "weight": k.weight, "kind": k.kind, "where": k.where,
                                     "listable": listable(k), "supported": supported})
        return Coverage(cw / tw if tw else 1.0, covered, missing, tw, cpw / tpw if tpw else 1.0,
                        bh / bw if bw else 1.0, sh / sw if sw else 1.0, body_missing)

    def boost(self, content: Content, meta: dict[str, SlotMeta], analysis: Analysis, cov: Coverage, rnd: int) -> bool:
        candidates = {m["term"]: dict(m) for m in cov.missing if m.get("placeable")}
        for m in cov.body_missing:
            if m["supported"]:
                candidates[m["term"]] = dict(m, evidence_needed=True)
        missing = []
        for term, item in candidates.items():
            keyword = next(k for k in analysis.keywords if k.term == term)
            eligible = [sid for sid, m in meta.items() if self.checker.supports(keyword, m.facts)]
            route = "concrete experience/project achievement" if item.get("evidence_needed") else (
                "a skills row or a grounded achievement" if item.get("listable") else "ONLY a grounded achievement")
            missing.append(dict(item, route=route, eligible_slots=eligible))
        missing.sort(key=lambda m: (not m.get("evidence_needed", False), -m["weight"]))
        if not missing:
            return False
        rows = [{"index": k, "label": r.label, "items": r.items,
                 "max_chars": self.book.budget(f"skills.{k}", r.label).max_chars, "chars": len(", ".join(r.items))}
                for k, r in enumerate(content.skills, 1)]
        texts = content.slot_text()
        bullets = [{"id": sid, "text": texts[sid], "budget": self.book.budget(sid).describe(), "facts": meta[sid].facts}
                   for sid in meta]
        out = self.llm.chat_json(prompts.SYSTEM, prompts.boost(missing, rows, bullets, self.fit.mode), BoostOut,
                                 temperature=self.temp_write, tag=f"boost{rnd}",
                                 max_tokens=self.cfg.tokens_boost, thinking=False)
        changed = False
        if out.skills_rows:
            new_rows = self.fit_skill_rows(out.skills_rows)
            if [(r.label, r.items) for r in new_rows] != [(r.label, r.items) for r in content.skills]:
                content.skills = new_rows
                changed = True
        for sid, new in (out.bullet_edits or {}).items():
            if sid not in meta:
                continue
            new = clean_llm_text(new)
            if not new or new == texts[sid]:
                continue
            fixed = self.precompile_repair(sid, new, meta[sid], fallback=texts[sid])
            if fixed != texts[sid]:
                content.set_slot(sid, fixed)
                changed = True
        return changed

    def polish_skills(self, content: Content) -> bool:
        """One pass that sorts every skills item into the row it belongs to and keeps labels honest."""
        rows = [{"label": r.label, "items": r.items,
                 "max_chars": self.book.budget(f"skills.{k}", r.label).max_chars} for k, r in enumerate(content.skills, 1)]
        self._log("polishing skills rows")
        terms = [t for k in (self.analysis.keywords if self.analysis else []) for t in (k.term, *k.aliases)]
        keep = [i for r in content.skills for i in r.items if any(contains_term(i, t) for t in terms)]
        out = self.llm.chat_json(prompts.SYSTEM, prompts.polish_skills(rows, keep), PolishOut, temperature=self.temp_analyze,
                                 tag="polish_skills", max_tokens=self.cfg.tokens_plan, thinking=False)
        if not out.skills_rows:
            return False
        new_rows = self.fit_skill_rows(out.skills_rows)
        if [(r.label, r.items) for r in new_rows] == [(r.label, r.items) for r in content.skills]:
            return False
        content.skills = new_rows
        return True

    def review_slots(self, content, meta):
        generated = {p["id"] for p in self.generated_projects}
        rows = [{"slot": sid, "text": text, "facts": meta[sid].facts,
                 "source": "generated_draft" if meta[sid].entry_id in generated else "career_profile",
                 "budget": self.book.budget(sid).describe()} for sid, text in content.slot_text().items() if sid in meta]
        for i, e in enumerate(content.experience, 1):
            rows.append({"slot": f"exp{i}.head", "text": " | ".join([e.title, e.org, e.dates]),
                         "source": "career_profile", "editable": False})
        ed = self.profile.education
        rows.append({"slot": "edu.head", "text": " | ".join([ed.school, ed.degree, ed.date]),
                     "source": "career_profile", "editable": False})
        return rows

    def checked_review(self, review, content, meta):
        """The review must quote both the real posting and the final PDF text, with valid source references."""
        rows = {r["slot"]: r for r in self.review_slots(content, meta)}
        texts = {sid: r["text"] for sid, r in rows.items()}
        checks = []
        unverified = []
        for item in review.requirements:
            if not item.posting_quote.strip() or norm(item.posting_quote) not in norm(self.jd):
                unverified.append({"requirement": item.requirement, "reason": "review did not supply a verbatim posting quote"})
                continue
            evidence = []
            for ref in item.evidence:
                if ref.slot in rows and ref.quote.strip() and norm(ref.quote) in norm(texts.get(ref.slot, "")):
                    evidence.append({"slot": ref.slot, "quote": ref.quote,
                                     "source": rows[ref.slot]["source"]})
            status = item.status if item.status in ("direct", "transferable") and evidence else "missing"
            checks.append({"requirement": item.requirement, "posting_quote": item.posting_quote,
                           "importance": "preferred" if item.importance == "preferred" else "required",
                           "status": status, "evidence": evidence, "reason": item.reason})
        return {"summary": review.summary, "checks": checks, "unverified": unverified, "complete": not unverified,
                "direct": sum(c["status"] == "direct" for c in checks),
                "transferable": sum(c["status"] == "transferable" for c in checks),
                "missing": sum(c["status"] == "missing" for c in checks),
                "note": "AI content review, not an employer ATS rating; generated drafts are unverified proposals"}

    def review_content(self, content, meta, res, cov, analysis):
        self._log("reviewing requirement evidence and relevance")
        before = (content.model_copy(deep=True), deepcopy(meta), res, cov)
        try:
            review = self.llm.chat_json(prompts.SYSTEM, prompts.review_resume(self.jd, self.review_slots(content, meta),
                                            concepts=[k.term for k in analysis.keywords if k.kind in ("concept", "practice")]),
                                        ReviewOut, tag="review", max_tokens=self.cfg.tokens_plan,
                                        temperature=self.temp_analyze, thinking=False)
            initial = self.checked_review(review, content, meta)
            if not initial["checks"]:
                self.warnings.append("content review returned no valid requirement/evidence references")
                return before
            # The model may recognize an equivalent practice phrased differently in the source. Accept only
            # concepts/practices with an exact source quote; named tools, metrics and other entries stay protected.
            paraphrases = []
            for item in review.paraphrases:
                k = next((k for k in analysis.keywords if norm(k.term) == norm(item.term)), None)
                if k and k.kind in ("concept", "practice") and item.slot in meta and len(item.facts_quote.strip()) >= 20 \
                        and norm(item.facts_quote) in norm(meta[item.slot].facts):
                    self.checker.semantic_paraphrases.setdefault(meta[item.slot].facts, set()).add(norm(k.term))
                    paraphrases.append(item.model_dump())
            changed = False
            for sid, text in list(review.bullet_edits.items())[:4]:
                if sid not in meta or not text.strip():
                    continue
                old = content.slot_text()[sid]
                fixed = self.precompile_repair(sid, clean_llm_text(text), meta[sid], fallback=old)
                if fixed != old:
                    content.set_slot(sid, fixed)
                    changed = True
            if changed:
                res = self.verify_and_repair(content, meta)
                cov = self.coverage(content, analysis)
                if cov.ratio < before[3].ratio - 0.02 or cov.ratio_body_supported < before[3].ratio_body_supported:
                    content, meta, res, cov = before
                    self.warnings.append("content edits lost existing evidence; kept the previous resume")
                    self.requirement_review = initial
                else:
                    criteria = [{k: c[k] for k in ("requirement", "posting_quote", "importance")} for c in initial["checks"]]
                    final = self.llm.chat_json(prompts.SYSTEM, prompts.review_resume(self.jd, self.review_slots(content, meta),
                                                allow_edits=False, criteria=criteria,
                                                concepts=[k.term for k in analysis.keywords if k.kind in ("concept", "practice")]), ReviewOut, tag="review_final",
                                                max_tokens=self.cfg.tokens_plan, temperature=self.temp_analyze, thinking=False)
                    self.requirement_review = self.checked_review(final, content, meta)
                    checked = {norm(c["requirement"]) for c in self.requirement_review["checks"]}
                    for criterion in criteria:
                        if norm(criterion["requirement"]) not in checked:
                            self.requirement_review["checks"].append(dict(criterion, status="missing", evidence=[],
                                reason="Final review did not retain verified evidence for this original criterion"))
                            self.requirement_review["missing"] += 1
                            self.requirement_review["complete"] = False
            else:
                self.requirement_review = initial
            self.requirement_review["paraphrases"] = [p for p in paraphrases
                if contains_term(content.slot_text().get(p["slot"], ""), p["term"])]
            return content, meta, res, cov
        except (LLMError, ValueError, RuntimeError) as exc:
            self.warnings.append("content review unavailable; kept the working resume: " + str(exc)[:180])
            self.requirement_review = {}
            return before

    # ------------------------------------------------------------------ outputs
    def finalize(self, company: str, out_root: Path, analysis: Analysis, plan: Plan, content: Content,
                 meta: dict[str, SlotMeta], res: CompileResult, cov: Coverage) -> dict:
        out_dir = out_root / company
        out_dir.mkdir(parents=True, exist_ok=True)
        base = f"{safe_name(self.profile.name).replace(' ', '_')}_{company.replace(' ', '_')}"
        pdf = out_dir / f"{base}.pdf"
        shutil.copy(res.pdf, pdf)
        (out_dir / f"{base}.tex").write_text(res.tex.read_text(encoding="utf-8"), encoding="utf-8")
        render_png(pdf, out_dir / "preview.png")
        (out_dir / "jd.txt").write_text(self.jd, encoding="utf-8")
        self.llm.dump_calls(out_dir / "llm_calls")
        report = build_report(profile=self.profile, book=self.book, content=content, meta=meta, analysis=analysis,
                              plan=plan, res=res, cov=cov, jd_terms=self.jd_terms_in_bullets, fallbacks=self.fallbacks,
                              warnings=self.warnings, soft_issues=self.soft_issues, usage=self.llm.total_usage(),
                              seconds=time.time() - self.t0, company=company, pdf=pdf, mode=self.fit.mode,
                              compiles=self.compiles, model=getattr(getattr(self.llm, "cfg", None), "model", "mock"),
                              gaps=[i for r in content.skills for i in r.items if not self._in_pool(i)],
                              rejected=sorted(self._dropped_items, key=norm), coverage_target=self.fit.coverage_target,
                              requirement_review=self.requirement_review,
                              project_drafts=[p for p in self.generated_projects
                                              if p["id"] in {entry.id for entry in content.projects}])
        write_report(report, out_dir)
        self._log(f"done -> {pdf}")
        return report
