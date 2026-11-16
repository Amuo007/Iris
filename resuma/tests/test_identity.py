from pathlib import Path

from resuma import config
from resuma.latex import compile_tex, pdf_words
from resuma.profile import load_profile
from resuma.render import identity_content, render_tex


def _original_pdf(tmp_path: Path) -> Path:
    res = compile_tex(config.ORIGINAL_TEX.read_text(encoding="utf-8"), tmp_path / "orig", "original")
    assert res.ok and res.pages == 1
    return res.pdf


def test_identity_render_matches_original_exactly(tmp_path):
    prof = load_profile()
    res = compile_tex(render_tex(prof, identity_content(prof)), tmp_path / "ident", "identity")
    assert res.ok and res.pages == 1 and not res.overfull
    a, b = pdf_words(_original_pdf(tmp_path)), pdf_words(res.pdf)
    assert [w[4] for w in a] == [w[4] for w in b]
    assert max(abs(x - y) for wa, wb in zip(a, b) for x, y in zip(wa[:4], wb[:4])) < 0.01
    assert len(res.measures) >= 30  # every slot reported its line count
