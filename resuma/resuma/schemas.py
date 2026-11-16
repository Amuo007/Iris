"""JSON shapes the LLM must return (validated with pydantic)."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .profile import Project


class Keyword(BaseModel):
    term: str
    aliases: list[str] = Field(default_factory=list)
    weight: int = 2
    kind: str = "tool"
    where: str = "both"
    # would a recruiter expect this exact term as an item in a Technical Skills list? None = not stated by the
    # analysis; the pipeline then falls back to kind/where (tools and domains yes, "bullets"-only phrases no)
    listable: bool | None = None

    @field_validator("weight", mode="before")
    @classmethod
    def _w(cls, v):
        try:
            return max(1, min(3, int(v)))
        except Exception:
            return 2

    @field_validator("listable", mode="before")
    @classmethod
    def _listable(cls, v):
        if isinstance(v, str):
            return {"true": True, "yes": True, "false": False, "no": False}.get(v.strip().lower())
        return v

    def is_listable(self) -> bool:
        """May this keyword be an item in a skills row? Tools and domains always; concepts and practices only when the
        analysis says a recruiter would scan for the term ("code review", "unit testing"), not for expectations that
        only make sense inside a sentence ("operational stability", "release practices"); soft skills never."""
        if self.kind == "soft":
            return False
        if self.listable is not None:
            return self.listable
        if self.kind in ("tool", "domain"):
            return True
        return self.where != "bullets"


class Analysis(BaseModel):
    company: str | None = None
    role_title: str = ""
    seniority: str = "unknown"
    summary: str = ""
    keywords: list[Keyword]
    emphasis: list[str] = Field(default_factory=list)

    def hard_keywords(self) -> list[Keyword]:
        return [k for k in self.keywords if k.kind != "soft"]


class Guidance(BaseModel):
    angle: str = ""
    keywords: list[str] = Field(default_factory=list)
    # One-based indexes into this entry's own bullets, most relevant first.
    fact_order: list[int] = Field(default_factory=list)


class SkillsRowPlan(BaseModel):
    label: str
    items: list[str]


class ProjectDraft(Project):
    replaces: str


class Plan(BaseModel):
    projects: list[str] = Field(default_factory=list)
    project_drafts: list[ProjectDraft] = Field(default_factory=list)
    experience_guidance: dict[str, Guidance] = Field(default_factory=dict)
    project_guidance: dict[str, Guidance] = Field(default_factory=dict)
    coursework: list[str] = Field(default_factory=list)
    skills_rows: list[SkillsRowPlan] = Field(default_factory=list)

    @field_validator("experience_guidance", "project_guidance", mode="before")
    @classmethod
    def _coerce_guidance(cls, v):
        # tolerate a list of {"id":..., "angle":..., "keywords": [...]}
        if isinstance(v, list):
            out = {}
            for item in v:
                if isinstance(item, dict) and "id" in item:
                    out[item["id"]] = {k: val for k, val in item.items() if k != "id"}
            return out
        return v or {}


class BulletsOut(BaseModel):
    bullets: list[str]


class BulletOut(BaseModel):
    bullet: str
    shorter: str | None = None
    shortest: str | None = None

    def candidates(self) -> list[str]:
        return [c for c in (self.bullet, self.shorter, self.shortest) if c]


class BoostOut(BaseModel):
    skills_rows: list[SkillsRowPlan] | None = None
    bullet_edits: dict[str, str] = Field(default_factory=dict)


class EvidenceQuote(BaseModel):
    slot: str
    quote: str


class RequirementCheck(BaseModel):
    requirement: str
    posting_quote: str
    importance: str = "required"
    status: str = "missing"
    evidence: list[EvidenceQuote] = Field(default_factory=list)
    reason: str = ""


class GroundedParaphrase(BaseModel):
    slot: str
    term: str
    facts_quote: str


class ReviewOut(BaseModel):
    summary: str = ""
    paraphrases: list[GroundedParaphrase] = Field(default_factory=list)
    requirements: list[RequirementCheck] = Field(default_factory=list)
    bullet_edits: dict[str, str] = Field(default_factory=dict)


class PolishOut(BaseModel):
    skills_rows: list[SkillsRowPlan] = Field(default_factory=list)
