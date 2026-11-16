"""Font metrics: measure every glyph once with TeX, then predict line usage of plain text instantly."""
from __future__ import annotations

import json
from pathlib import Path

from . import config
from .latex import compile_tex, parse_calibration
from .texttools import ESCAPES, NAMED_TOKENS, latex_tokens, plain_to_latex


def _preamble() -> str:
    src = config.TEMPLATE.read_text(encoding="utf-8")
    return src.split(r"\begin{document}", 1)[0]


def calibration_tex() -> str:
    lines = [_preamble(), r"\newlength{\resumaCW}",
             r"\newcommand{\resumaCal}[3]{\settowidth{\resumaCW}{#3}\typeout{RESUMA-CAL|#1|#2|\the\resumaCW}}",
             r"\begin{document}"]
    items: list[tuple[str, str]] = []
    for o in range(32, 127):
        ch = chr(o)
        tex = r"\ " if ch == " " else (ESCAPES.get(ch) or ('``' if ch == '"' else ch))
        items.append((f"c:{ch}" if ch != " " else "tok:space", tex))
    for name, tex in NAMED_TOKENS.items():
        if name == "space":
            continue
        items.append((f"tok:{name}", tex))
    for key, tex in items:
        safe_key = key.replace("\\", "BS").replace("%", "PCT").replace("#", "HASH").replace("{", "LB").replace("}", "RB")
        lines.append(rf"\resumaCal{{regular}}{{{safe_key}}}{{{tex}}}")
        lines.append(rf"\resumaCal{{bold}}{{{safe_key}}}{{\textbf{{{tex}}}}}")
    lines.append(r"\end{document}")
    return "\n".join(lines)


def _unsafe(key: str) -> str:
    return key.replace("BS", "\\").replace("PCT", "%").replace("HASH", "#").replace("LB", "{").replace("RB", "}") \
        if key.startswith("c:") and len(key) > 3 else key


class FontMetrics:
    def __init__(self, table: dict[str, dict[str, float]]):
        self.table = table
        self.avg_char_pt = self._avg()

    def _avg(self) -> float:
        reg = self.table["regular"]
        letters = [reg.get(f"c:{c}", 0) for c in "etaoinshrdlucmfwypvbgkjqxz"]
        return (sum(letters) / len(letters) + reg.get("tok:space", 3.3)) / 2 * 1.08

    @classmethod
    def load_or_calibrate(cls, path: Path = config.METRICS_FILE, force: bool = False) -> "FontMetrics":
        if path.exists() and not force:
            return cls(json.loads(path.read_text()))
        res = compile_tex(calibration_tex(), config.BUILD / "calibrate", "calibrate")
        if not res.ok and not res.log:
            raise RuntimeError("font calibration compile failed")
        raw = parse_calibration(res.log)
        table = {face: {_unsafe(k): v for k, v in vals.items()} for face, vals in raw.items()}
        if len(table.get("regular", {})) < 90:
            raise RuntimeError(f"calibration incomplete: {len(table.get('regular', {}))} glyphs; log:\n{res.log[-2000:]}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(table, indent=1))
        return cls(table)

    def width(self, plain: str, bold: bool = False) -> float:
        face = self.table["bold" if bold else "regular"]
        fallback = face.get("c:n", 5.0)
        total = 0.0
        for key in latex_tokens(plain):
            w = face.get(key)
            if w is None:
                if key.startswith("c:") and not key[2:].isascii():
                    w = face.get("c:" + _ascii_fallback(key[2:]), fallback)
                else:
                    w = fallback
            total += w
        return total

    def chars_for_width(self, width_pt: float) -> int:
        return int(width_pt / self.avg_char_pt)


def _ascii_fallback(ch: str) -> str:
    import unicodedata

    base = unicodedata.normalize("NFKD", ch)
    for c in base:
        if c.isascii():
            return c
    return "n"


__all__ = ["FontMetrics", "calibration_tex", "plain_to_latex"]
