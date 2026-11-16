from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field

from . import config
from .texttools import words


class Contact(BaseModel):
    location: str
    email: str
    phone: str
    linkedin_url: str
    linkedin_label: str
    github_url: str
    github_label: str


class Education(BaseModel):
    school: str
    degree: str
    date: str
    coursework_pool: list[str]


class Entry(BaseModel):
    id: str
    title: str
    org: str
    qualifier: str = ""
    dates: str
    bullets: list[str]
    details: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    def facts_text(self) -> str:
        return " ".join([self.title, self.org, self.qualifier, self.dates, *self.bullets, *self.details])


class Project(BaseModel):
    id: str
    title: str
    subtitle: str = ""
    dates: str
    bullets: list[str]
    # one-line versions of the bullets (about 90 characters) for the project slot whose bullets print on one line
    short_bullets: list[str] = Field(default_factory=list)
    details: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    def facts_text(self) -> str:
        return " ".join([self.title, self.subtitle, self.dates, *self.bullets, *self.short_bullets, *self.details])

    def bullets_for(self, line_pattern: list[int]) -> list[str]:
        """The pool text that fits a slot: short_bullets when every bullet of the slot prints on one line."""
        if line_pattern and all(n == 1 for n in line_pattern) and len(self.short_bullets) >= len(line_pattern):
            return list(self.short_bullets)
        return list(self.bullets)


class SkillRow(BaseModel):
    label: str
    items: list[str]


class Profile(BaseModel):
    name: str
    contact: Contact
    education: Education
    experience: list[Entry]
    projects_pool: list[Project]
    skills_pool: list[SkillRow]

    def all_skill_items(self) -> list[str]:
        return [i for r in self.skills_pool for i in r.items]

    def all_text(self) -> str:
        parts = [self.education.degree, " ".join(self.education.coursework_pool)]
        parts += [e.facts_text() for e in self.experience]
        parts += [p.facts_text() for p in self.projects_pool]
        parts += [f"{r.label} " + " ".join(r.items) for r in self.skills_pool]
        return " ".join(parts)

    def vocabulary(self) -> set[str]:
        """Lowercase word tokens (and sub-tokens split on / . - ( ) ,) of everything in the profile."""
        vocab = set()
        for w in words(self.all_text()):
            vocab.add(w.lower())
            for piece in w.replace("/", " ").replace("-", " ").replace(".", " ").replace("(", " ").replace(")", " ").split():
                vocab.add(piece.lower())
        return vocab

    def project(self, pid: str) -> Project:
        for p in self.projects_pool:
            if p.id == pid:
                return p
        raise KeyError(pid)


def load_profile(path: Path = config.PROFILE) -> Profile:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    # RESUMA_REAL_ONLY=1 (set by Iris, which sends the PDFs with real applications): only the candidate's own projects,
    # never the made-up ones marked "illustrative" for the website's example resumes
    if os.environ.get("RESUMA_REAL_ONLY") == "1":
        data["projects_pool"] = [p for p in data.get("projects_pool", []) if not p.get("illustrative")]
    return Profile.model_validate(data)
