"""Plain text <-> LaTeX, plus small text utilities shared by the pipeline.

The LLM only ever sees and writes plain text (unicode). Everything that goes into the
.tex file passes through plain_to_latex(), so the model can never inject LaTeX.
"""
from __future__ import annotations

import re
import unicodedata

# unicode char -> (token name, tex). Token names are what the font calibration measures.
UNICODE_TOKENS: dict[str, tuple[str, str]] = {
    "—": ("emdash", "---"),
    "–": ("endash", "--"),
    "−": ("endash", "--"),  # minus sign
    "→": ("rightarrow", r"$\rightarrow$"),
    "←": ("leftarrow", r"$\leftarrow$"),
    "≈": ("approx", r"$\approx$"),
    "×": ("times", r"$\times$"),
    "≥": ("geq", r"$\geq$"),
    "≤": ("leq", r"$\leq$"),
    "·": ("cdot", r"$\cdot$"),
    "•": ("cdot", r"$\cdot$"),
    "…": ("ldots", r"\ldots{}"),
    "“": ("lquote", "``"),
    "”": ("rquote", "''"),
    "‘": ("lsquote", "`"),
    "’": ("rsquote", "'"),
    " ": ("space", "~"),
}
# every named token and the TeX that produces it (used by the calibration document)
NAMED_TOKENS: dict[str, str] = {name: tex for name, tex in UNICODE_TOKENS.values()}
NAMED_TOKENS.update({"sim": r"$\sim$", "space": r"\ ", "ff": "ff", "fi": "fi", "fl": "fl", "ffi": "ffi", "ffl": "ffl",
                     "less": r"\textless{}", "greater": r"\textgreater{}", "bar": r"\textbar{}"})

ESCAPES: dict[str, str] = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "$": r"\$",
    "&": r"\&",
    "#": r"\#",
    "%": r"\%",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "<": r"\textless{}",
    ">": r"\textgreater{}",
    "|": r"\textbar{}",
}

ASCII_ARROWS = {"->": "\u2192", "<-": "\u2190", "=>": "\u2192", "-->": "\u2192"}


def normalize_arrows(s: str) -> str:
    return s.replace("-->", "\u2192").replace("->", "\u2192").replace("<-", "\u2190").replace("=>", "\u2192")

_WS = re.compile(r"\s+")


def clean_llm_text(s: str) -> str:
    """Normalize a bullet/phrase the model wrote: strip markdown, list markers, quotes, trailing period."""
    s = unicodedata.normalize("NFC", s or "")
    s = s.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    s = _WS.sub(" ", s).strip()
    s = re.sub(r"^(?:[-*•·]\s+|\d+[.)]\s+)", "", s)  # leading list markers
    s = s.replace("**", "").replace("__", "")
    if len(s) >= 2 and s[0] in "\"'“‘" and s[-1] in "\"'”’":
        s = s[1:-1].strip()
    s = re.sub(r"(?<![.])\.$", "", s)  # single trailing period (keep "etc.." no, keep '...')
    return s.strip()


def plain_to_latex(s: str) -> str:
    """Escape plain text for LaTeX. Idempotent on already-plain text only; never feed LaTeX in."""
    s = normalize_arrows(s)
    out: list[str] = []
    dq_open = True
    n = len(s)
    i = 0
    while i < n:
        ch = s[i]
        if ch == "~" and i + 1 < n and s[i + 1].isdigit():
            out.append(r"$\sim$")  # "~98%" means approximately
        elif ch == '"':
            out.append("``" if dq_open else "''")
            dq_open = not dq_open
        elif ch in UNICODE_TOKENS:
            out.append(UNICODE_TOKENS[ch][1])
        elif ch in ESCAPES:
            out.append(ESCAPES[ch])
        else:
            cat = unicodedata.category(ch)
            if cat.startswith("C") and ch not in " ":
                pass  # drop control chars
            elif cat in ("So", "Sk") or ord(ch) > 0x2FFF:
                pass  # drop emoji / symbols the fonts cannot render
            else:
                out.append(ch)
        i += 1
    tex = "".join(out)
    if tex.startswith("["):
        tex = "{[}" + tex[1:]
    return tex


def latex_tokens(s: str) -> list[str]:
    """Tokenize PLAIN text into width-lookup keys (same mapping plain_to_latex uses).

    Keys are 'c:<char>' for literal characters or 'tok:<name>' for named tokens/ligatures.
    """
    s = normalize_arrows(s)
    toks: list[str] = []
    dq_open = True
    n = len(s)
    i = 0
    while i < n:
        ch = s[i]
        if ch in "<>|":
            toks.append({"<": "tok:less", ">": "tok:greater", "|": "tok:bar"}[ch]); i += 1; continue
        if ch == "-" and s.startswith("---", i):
            toks.append("tok:emdash"); i += 3; continue
        if ch == "-" and s.startswith("--", i):
            toks.append("tok:endash"); i += 2; continue
        if ch == "f":
            for lig in ("ffi", "ffl", "ff", "fi", "fl"):
                if s.startswith(lig, i):
                    toks.append("tok:" + lig); i += len(lig); break
            else:
                toks.append("c:f"); i += 1
            continue
        if ch == "~" and i + 1 < n and s[i + 1].isdigit():
            toks.append("tok:sim")
        elif ch == '"':
            toks.append("tok:lquote" if dq_open else "tok:rquote"); dq_open = not dq_open
        elif ch in UNICODE_TOKENS:
            toks.append("tok:" + UNICODE_TOKENS[ch][0])
        elif ch == " ":
            toks.append("tok:space")
        else:
            toks.append("c:" + ch)
        i += 1
    return toks


_NUM_TOKEN = re.compile(r"[A-Za-z]*\d[\w.:/+%-]*")


def number_tokens(text: str) -> set[str]:
    """Every digit-bearing token, normalized (lowercase, trailing punctuation stripped)."""
    found = set()
    for m in _NUM_TOKEN.finditer(text):
        t = m.group(0).lower().rstrip(".,;:)")
        found.add(t)
    return found


_WORD = re.compile(r"[A-Za-z][\w+#./-]*")


def words(text: str) -> list[str]:
    return _WORD.findall(text)


def same_root(a: str, b: str) -> bool:
    """Do two words look like forms of one root (encryption/encrypted, operational/operations, diagnostics/diagnosed)?
    They must share a prefix of at least five letters that covers all but the last three letters of the shorter word,
    so release/relevant (4 shared) and stable/stability (4 shared) do not count."""
    a, b = a.lower(), b.lower()
    k = 0
    for x, y in zip(a, b):
        if x != y:
            break
        k += 1
    return k >= 5 and k >= min(len(a), len(b)) - 3


def norm(text: str) -> str:
    return _WS.sub(" ", text.lower().replace("–", "-").replace("—", "-")).strip()


COMMON_CAPS = {
    # words that are legitimately capitalized in resume prose and are NOT technology claims
    "built", "designed", "engineered", "developed", "led", "implemented", "created", "integrated", "delivered",
    "reduced", "improved", "architected", "deployed", "contributed", "researching", "evaluating", "shipped",
    "automated", "optimized", "owned", "drove", "mentored", "collaborated", "partnered", "validated", "secured",
    "api", "apis", "ai", "ml", "ui", "ux", "rest", "http", "https", "json", "sql", "pdf", "qr", "sse", "gpu", "cpu",
    "ram", "os", "db", "id", "ttl", "us", "usa", "uk", "english",
}


def proper_terms(text: str) -> set[str]:
    """Tokens that look like named technologies/products: contain an uppercase letter after position 0,
    or are all-caps/CamelCase, or start with uppercase mid-sentence. First word is skipped."""
    out = set()
    ws = words(text)
    for idx, w in enumerate(ws):
        core = w.strip(".,;:()")
        if not core or core.lower() in COMMON_CAPS:
            continue
        has_upper = any(c.isupper() for c in core)
        if not has_upper:
            continue
        if idx == 0 and core[0].isupper() and core[1:].islower():
            continue  # sentence-initial ordinary word
        out.add(core)
    return out


def contains_term(text: str, term: str) -> bool:
    """Case-insensitive whole-word match tolerant of simple plurals and hyphen/space variants."""
    t = norm(term)
    body = norm(text)
    variants = {t, t.replace("-", " "), t.replace(" ", "-"), t.replace("-", "")}
    for v in list(variants):
        if v and not v.endswith("s"):
            variants.add(v + "s")
    for v in variants:
        if not v:
            continue
        pat = r"(?<![\w])" + re.escape(v) + r"(?![\w])"
        if re.search(pat, body):
            return True
    return False


def split_items(text: str) -> list[str]:
    """Split a comma-separated list, ignoring commas inside parentheses."""
    items: list[str] = []
    depth = 0
    cur: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            items.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        items.append(tail)
    return [i for i in items if i]


def is_tech_shaped(term: str) -> bool:
    """CamelCase, ALL-CAPS acronyms, digits or non-dictionary words: things that name a specific technology."""
    import unicodedata  # noqa: F401  (kept local; cheap)
    pieces = [p for p in re.split(r"[/.\-()+,:;\s]", term) if p]
    for p in pieces:
        if any(c.isdigit() for c in p):
            return True
        if len(p) >= 2 and p.isupper() and p.lower() not in COMMON_CAPS:
            return True
        if p.lower() in COMMON_CAPS:
            continue
        if not p.isupper() and any(c.isupper() for c in p[1:]):
            return True
    return False
