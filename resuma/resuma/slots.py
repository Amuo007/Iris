"""Slots = the editable regions of the template, each with a fixed line budget measured from the original."""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config
from .config import FitConfig
from .latex import SlotMeasure, compile_tex
from .metrics import FontMetrics
from .profile import Profile
from .render import identity_content, render_tex

COURSEWORK_LABEL = "Relevant Coursework"


def slot_kind(slot_id: str) -> str:
    if slot_id.endswith(".head"):
        return "head"
    if slot_id.startswith("skills."):
        return "skills"
    if slot_id == "edu.coursework":
        return "coursework"
    if ".b" in slot_id:
        return "bullet"
    return "fixed"


@dataclass
class Slot:
    id: str
    kind: str
    target_lines: int
    linewidth_pt: float
    original: str
    orig_width_pt: float

    @property
    def editable(self) -> bool:
        return self.kind in ("bullet", "skills", "coursework")


@dataclass
class Budget:
    """Character/width budget for the TEXT of a slot (for rows: the items, excluding the bold label)."""

    slot: str
    target_lines: int
    min_width: float
    max_width: float
    target_width: float
    min_chars: int
    max_chars: int
    target_chars: int
    orig_chars: int

    def describe(self) -> str:
        s = "s" if self.target_lines > 1 else ""
        return (f"target {self.target_chars} characters (allowed {self.min_chars}-{self.max_chars}); "
                f"must fill exactly {self.target_lines} printed line{s}")


@dataclass
class SlotEval:
    slot: str
    ok: bool
    hard: bool            # a hard failure changes the page geometry (line count / overflow / page count)
    problems: list[str]
    lines: int | None
    est_lines: float
    fill_last: float
    source: str           # "predicted" | "compiled"


class SlotBook:
    def __init__(self, slots: dict[str, Slot], fm: FontMetrics, fit: FitConfig):
        self.slots = slots
        self.fm = fm
        self.fit = fit

    @classmethod
    def baseline(cls, profile: Profile, fm: FontMetrics, fit: FitConfig, force: bool = False,
                 cache: Path = config.SLOTS_FILE) -> "SlotBook":
        if cache.exists() and not force:
            raw = json.loads(cache.read_text())
            return cls({k: Slot(**v) for k, v in raw.items()}, fm, fit)
        content = identity_content(profile)
        res = compile_tex(render_tex(profile, content), config.BUILD / "baseline", "baseline")
        if not res.ok or res.pages != 1:
            raise RuntimeError(f"baseline compile failed (pages={res.pages}): {res.errors[:3]}")
        texts = content.slot_text()
        slots = {sid: Slot(sid, slot_kind(sid), m.lines, m.linewidth_pt, texts.get(sid, ""), m.width_pt)
                 for sid, m in res.measures.items()}
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({k: asdict(v) for k, v in slots.items()}, indent=1))
        return cls(slots, fm, fit)

    # ---- geometry helpers ----
    def label_width(self, slot: Slot, label: str | None) -> float:
        if slot.kind in ("skills", "coursework") and label:
            return self.fm.width(label.rstrip(":") + ":", bold=True) + self.fm.width(" ")
        return 0.0

    def min_fill(self, slot: Slot) -> float:
        if slot.kind == "skills":
            return self.fit.min_fill_skills
        return self.fit.min_fill_single if slot.target_lines == 1 else self.fit.min_fill_multi

    def margin(self, slot: Slot) -> float:
        return self.fit.overflow_margin_single if slot.target_lines == 1 else self.fit.overflow_margin_multi

    def budget(self, slot_id: str, label: str | None = None) -> Budget:
        slot = self.slots[slot_id]
        W, L = slot.linewidth_pt, slot.target_lines
        lab = self.label_width(slot, label)
        min_w = ((L - 1) + self.min_fill(slot)) * W - lab
        max_w = (L - self.margin(slot)) * W - lab
        tgt_w = ((L - 1) + self.fit.target_fill) * W - lab
        cpw = self.fm.avg_char_pt
        return Budget(slot_id, L, min_w, max_w, tgt_w, int(min_w / cpw), int(max_w / cpw), int(tgt_w / cpw),
                      len(slot.original))

    def bullet_line_pattern(self, prefix: str) -> list[int]:
        """e.g. prefix 'proj1' -> [2, 2, 2]"""
        ids = sorted((s for s in self.slots if s.startswith(prefix + ".b")), key=lambda s: int(s.split(".b")[1]))
        return [self.slots[s].target_lines for s in ids]

    def evaluate(self, slot_id: str, text: str, label: str | None = None, measure: SlotMeasure | None = None,
                 overfull_pt: float = 0.0) -> SlotEval:
        slot = self.slots[slot_id]
        b = self.budget(slot_id, label)
        cpw = self.fm.avg_char_pt
        W, L = slot.linewidth_pt, slot.target_lines
        advisory = slot.kind == "coursework"  # fixed pool, reorder only: fill is whatever it is
        problems: list[str] = []
        hard = False
        if measure is not None:
            lines, est_lines, fill = measure.lines, measure.est_lines, measure.last_line_fill
            if lines > L:
                over = measure.width_pt - (L - self.margin(slot)) * W
                cut = max(8, math.ceil(over / cpw) + 4)
                problems.append(f"it prints as {lines} lines but must be exactly {L}; shorten it by about {cut} characters")
                hard = True
            elif lines < L:
                need = ((L - 1) + self.min_fill(slot)) * W - measure.width_pt
                add = max(8, math.ceil(need / cpw) + 4)
                problems.append(f"it prints as only {lines} line(s) but must be exactly {L}; lengthen it by about {add} "
                                f"characters with a concrete detail from the facts")
                hard = True
            elif overfull_pt > 0.5:
                cut = max(4, math.ceil(overfull_pt / cpw) + 3)
                problems.append(f"its last word sticks {overfull_pt:.1f}pt into the margin; shorten it by about {cut} characters")
                hard = True
            elif fill < self.min_fill(slot) and not advisory:
                need = (self.min_fill(slot) - fill) * W
                add = max(6, math.ceil(need / cpw) + 3)
                problems.append(f"its last line is only {fill:.0%} full, which looks ragged; lengthen it by about {add} "
                                f"characters with a concrete detail from the facts")
            return SlotEval(slot_id, not problems, hard, problems, lines, est_lines, fill, "compiled")
        width = self.fm.width(text)
        est_lines = (width + self.label_width(slot, label)) / W
        fill = max(0.0, min(1.0, est_lines - (L - 1)))
        if width > b.max_width:
            cut = max(6, math.ceil((width - b.max_width) / cpw) + 3)
            problems.append(f"at {len(text)} characters it is too long for {L} printed line(s); shorten it by about {cut} characters")
            hard = True
        elif width < b.min_width and not advisory:
            add = max(6, math.ceil((b.min_width - width) / cpw) + 3)
            problems.append(f"at {len(text)} characters it is too short (its last line would be only {fill:.0%} full); "
                            f"lengthen it by about {add} characters with a concrete detail from the facts")
        return SlotEval(slot_id, not problems, hard, problems, None, est_lines, fill, "predicted")
