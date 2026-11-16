"""Content model (what the LLM is allowed to change) and the Jinja render into .tex."""
from __future__ import annotations

from jinja2 import Environment, FileSystemLoader
from pydantic import BaseModel, Field

from . import config
from .profile import Profile
from .texttools import plain_to_latex, split_items

N_EXPERIENCE = 3
N_PROJECTS = 3
N_SKILL_ROWS = 6


class EntryContent(BaseModel):
    id: str
    title: str
    org: str
    qualifier: str = ""
    dates: str
    bullets: list[str]


class ProjectContent(BaseModel):
    id: str
    title: str
    subtitle: str = ""
    dates: str
    bullets: list[str]


class SkillRowContent(BaseModel):
    label: str
    items: list[str]


class Content(BaseModel):
    coursework: list[str]
    experience: list[EntryContent]
    projects: list[ProjectContent]
    skills: list[SkillRowContent]

    def slot_text(self) -> dict[str, str]:
        """Plain text of every LLM-editable slot, keyed by slot id."""
        out = {"edu.coursework": ", ".join(self.coursework)}
        for i, e in enumerate(self.experience, 1):
            for j, b in enumerate(e.bullets, 1):
                out[f"exp{i}.b{j}"] = b
        for i, p in enumerate(self.projects, 1):
            for j, b in enumerate(p.bullets, 1):
                out[f"proj{i}.b{j}"] = b
        for k, r in enumerate(self.skills, 1):
            out[f"skills.{k}"] = ", ".join(r.items)
        return out

    def set_slot(self, slot: str, text: str) -> None:
        kind, _, rest = slot.partition(".")
        if kind.startswith("exp"):
            self.experience[int(kind[3:]) - 1].bullets[int(rest[1:]) - 1] = text
        elif kind.startswith("proj"):
            self.projects[int(kind[4:]) - 1].bullets[int(rest[1:]) - 1] = text
        elif kind == "skills":
            self.skills[int(rest) - 1].items = split_items(text)
        elif slot == "edu.coursework":
            self.coursework = split_items(text)
        else:
            raise KeyError(slot)

    def full_text(self) -> str:
        parts = [", ".join(self.coursework)]
        for e in self.experience:
            parts += [e.title, e.org, *e.bullets]
        for p in self.projects:
            parts += [p.title, p.subtitle, *p.bullets]
        for r in self.skills:
            parts += [r.label, ", ".join(r.items)]
        return "\n".join(parts)


def identity_content(profile: Profile) -> Content:
    return Content(
        coursework=list(profile.education.coursework_pool),
        experience=[EntryContent(id=e.id, title=e.title, org=e.org, qualifier=e.qualifier, dates=e.dates,
                                 bullets=list(e.bullets)) for e in profile.experience],
        projects=[ProjectContent(id=p.id, title=p.title, subtitle=p.subtitle, dates=p.dates, bullets=list(p.bullets))
                  for p in profile.projects_pool[:N_PROJECTS]],
        skills=[SkillRowContent(label=r.label, items=list(r.items)) for r in profile.skills_pool],
    )


def _env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(config.TEMPLATE.parent)),
        variable_start_string="<<", variable_end_string=">>",
        block_start_string="<%", block_end_string="%>",
        comment_start_string="<#", comment_end_string="#>",
        trim_blocks=True, lstrip_blocks=True, autoescape=False, keep_trailing_newline=True,
    )


def render_tex(profile: Profile, content: Content) -> str:
    L = plain_to_latex
    ctx = {
        "name": L(profile.name),
        "contact": {k: (v if k.endswith("_url") or k == "email" else L(v)) for k, v in profile.contact.model_dump().items()},
        "education": {"school": L(profile.education.school), "degree": L(profile.education.degree),
                      "date": L(profile.education.date)},
        "coursework": L(", ".join(content.coursework)),
        "experience": [{"title": L(e.title), "org": L(e.org), "qualifier": L(e.qualifier), "dates": L(e.dates),
                        "bullets": [L(b) for b in e.bullets]} for e in content.experience],
        "projects": [{"title": L(p.title), "subtitle": L(p.subtitle), "dates": L(p.dates),
                      "bullets": [L(b) for b in p.bullets]} for p in content.projects],
        "skills": [{"label": L(r.label), "itemstr": L(", ".join(r.items))} for r in content.skills],
    }
    return _env().get_template(config.TEMPLATE.name).render(**ctx)
