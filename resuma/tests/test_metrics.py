from resuma import config
from resuma.config import FitConfig
from resuma.latex import compile_tex
from resuma.metrics import FontMetrics
from resuma.profile import load_profile
from resuma.render import identity_content, render_tex
from resuma.slots import SlotBook


def test_predicted_width_close_to_tex(tmp_path):
    prof = load_profile()
    fm = FontMetrics.load_or_calibrate()
    content = identity_content(prof)
    res = compile_tex(render_tex(prof, content), tmp_path / "m", "m")
    texts = content.slot_text()
    for sid, text in texts.items():
        if ".b" not in sid:
            continue
        m = res.measures[sid]
        assert abs(fm.width(text) - m.width_pt) / m.width_pt < 0.012, sid


def test_budgets_accept_original_bullets():
    prof = load_profile()
    fm = FontMetrics.load_or_calibrate()
    book = SlotBook.baseline(prof, fm, FitConfig())
    texts = identity_content(prof).slot_text()
    for sid, slot in book.slots.items():
        if slot.kind != "bullet":
            continue
        ev = book.evaluate(sid, texts[sid])
        # the original never overflows; a few original bullets are ragged (soft issue) and that is allowed
        assert not ev.hard, (sid, ev.problems)
