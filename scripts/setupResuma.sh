#!/bin/bash
# scripts/setupResuma.sh — set up the resume service (resuma/) that Iris starts for each job: a Python 3.11+ virtual
# environment with resuma's dependencies, a .env from .env.example, and a check that LaTeX is there. Run it once after
# cloning (npm run setupResuma); running it again only updates the dependencies.
set -e
R=$(cd "$(dirname "$0")/../resuma" && pwd)

PY=""
for c in python3.14 python3.13 python3.12 python3.11 python3 /opt/homebrew/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY=$(command -v "$c"); break
  fi
done
[ -z "$PY" ] && { echo "resuma needs Python 3.11 or newer (brew install python)"; exit 1; }

cd "$R"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -e '.[dev]'
[ -f .env ] || cp .env.example .env

if ! command -v pdflatex >/dev/null 2>&1 && [ ! -x /Library/TeX/texbin/pdflatex ]; then
  echo "LaTeX is not installed: resuma needs pdflatex to build PDFs (brew install --cask mactex-no-gui)"
fi
if [ ! -f data/profile.json ] || [ ! -f data/original.tex ]; then
  echo "data/profile.json and data/original.tex are your own career profile and resume: they are not in the repository."
  echo "Copy yours in, or import your LaTeX resume in Iris (Settings > Jobs) and fill the career profile there."
fi
echo "resuma is set up at $R ($(.venv/bin/python --version)). Iris uses it when ~/Desktop/Projects/resuma is not there."
