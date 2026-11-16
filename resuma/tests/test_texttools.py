from resuma.texttools import (clean_llm_text, contains_term, latex_tokens, number_tokens, plain_to_latex,
                              proper_terms, split_items)


def test_escapes_specials():
    assert plain_to_latex("A & B 100% $5 #1 a_b {x} ~ ^ \\") == \
        r"A \& B 100\% \$5 \#1 a\_b \{x\} \textasciitilde{} \textasciicircum{} \textbackslash{}"


def test_approx_tilde_and_unicode():
    assert plain_to_latex("cut usage ~98% (74 → 1) — done") == r"cut usage $\sim$98\% (74 $\rightarrow$ 1) --- done"
    assert plain_to_latex("Jan 2026 – Present") == "Jan 2026 -- Present"
    assert plain_to_latex("Open-Source · Team") == r"Open-Source $\cdot$ Team"


def test_quotes_and_leading_bracket():
    assert plain_to_latex('said "hi" twice') == "said ``hi'' twice"
    assert plain_to_latex("[x] y").startswith("{[}")


def test_drops_emoji_keeps_accents():
    assert plain_to_latex("café 🚀 ok") == "café  ok"


def test_tokens_match_escaper_semantics():
    toks = latex_tokens("~98% fi --- a")
    assert toks[0] == "tok:sim" and "tok:fi" in toks and "tok:emdash" in toks and toks[-1] == "c:a"


def test_split_items_respects_parens():
    assert split_items("iOS (UIKit, SwiftUI, ARKit), Unity (AR Foundation), Meta Quest 3") == \
        ["iOS (UIKit, SwiftUI, ARKit)", "Unity (AR Foundation)", "Meta Quest 3"]


def test_number_tokens():
    assert number_tokens("cut ~98% (74 → 1 call/hour), 100+ orders, 0.10s, OAuth 2.0, qwen2.5:0.5b") >= \
        {"98%", "74", "1", "100+", "0.10s", "2.0", "qwen2.5:0.5b"}


def test_proper_terms_skips_sentence_initial_word():
    terms = proper_terms("Built a Kubernetes cluster with FastAPI and plain words")
    assert "Kubernetes" in terms and "FastAPI" in terms and "Built" not in terms


def test_contains_term_variants():
    assert contains_term("ship apps with CI/CD pipelines", "CI/CD")
    assert contains_term("Objective-C code", "objective c")
    assert contains_term("REST APIs", "REST API")
    assert not contains_term("Swiftly done", "Swift")


def test_clean_llm_text():
    assert clean_llm_text('- **Built** a thing.\n') == "Built a thing"
    assert clean_llm_text('"Quoted bullet"') == "Quoted bullet"


def test_ascii_arrows_and_angle_brackets():
    assert plain_to_latex("chunk -> embed -> LLM") == r"chunk $\rightarrow$ embed $\rightarrow$ LLM"
    assert plain_to_latex("a < b > c | d") == r"a \textless{} b \textgreater{} c \textbar{} d"
    assert "tok:rightarrow" in latex_tokens("a -> b") and "tok:bar" in latex_tokens("a | b")
