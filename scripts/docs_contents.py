"""Write a list of contents, with a link to each section, at the top of every long guide.

    python scripts/docs_contents.py           # brings every list up to date
    python scripts/docs_contents.py --check   # says which lists are out of date, and fails (the test-suite runs it)

A guide with at least MIN_SECTIONS sections (``##`` headings) gets a list of them, with the ``###``
headings of each nested under it, just before its first section. The list sits between the markers
``<!-- contents -->`` and ``<!-- /contents -->`` and is made again from the headings each time, so it is
never edited by hand: change a heading, then run this script. The links use the anchors GitHub gives
headings (lower case, punctuation left out, spaces as hyphens, ``-1``, ``-2`` after a repeated heading),
which are also what the application's links into the guides use (``js/ui/docs.js``).
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
#: The guides that get a list of contents when they are long enough.
GUIDES = ("README.md", "HANDOVER.md", "docs/*.md", "docs/web/*.md")
#: Fewer sections than this need no list.
MIN_SECTIONS = 5
START = "<!-- contents: made by scripts/docs_contents.py from the headings; run it after changing them -->"
END = "<!-- /contents -->"
BLOCK = re.compile(r"\n?<!-- contents[^\n]*-->\n.*?<!-- /contents -->\n\n?", re.S)
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def heading_text(raw: str) -> str:
    """A heading as it reads on the page: links as their text, code as it is written (``<set>`` in code is text),
    emphasis and HTML tags outside code left out."""
    parts = raw.split("`")
    for i in range(0, len(parts), 2):  # outside code spans
        part = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", parts[i])
        part = re.sub(r"<[^>]+>", "", part)
        parts[i] = part.replace("**", "").replace("__", "")
    return "".join(parts)


def list_text(raw: str) -> str:
    """A heading as the list shows it: links as their text, code kept as code."""
    return re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", raw).strip()


def slug(text: str) -> str:
    """GitHub's anchor of a heading (github-slugger): lower case, only letters, digits, marks, ``_``, ``-`` and
    spaces kept, each space a hyphen."""
    kept = []
    for ch in text.lower():
        cat = unicodedata.category(ch)
        if ch in "-_ " or cat[0] in "LNM":
            kept.append(ch)
    return "".join(kept).replace(" ", "-")


def headings(text: str) -> list[tuple[int, str, str]]:
    """Every heading outside code blocks: (level, text, anchor), anchors made unique as GitHub makes them."""
    out: list[tuple[int, str, str]] = []
    seen: dict[str, int] = {}
    fenced = False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
            continue
        m = None if fenced else HEADING.match(line)
        if not m:
            continue
        base = slug(heading_text(m.group(2)))
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.append((len(m.group(1)), list_text(m.group(2)), base if n == 0 else f"{base}-{n}"))
    return out


def contents_block(text: str) -> str:
    """The list of contents for a guide's text (without any list already in it), or "" when it needs none."""
    found = [h for h in headings(text) if h[0] in (2, 3)]
    if sum(1 for level, _, _ in found if level == 2) < MIN_SECTIONS:
        return ""
    lines = [START, "**Contents**", ""]
    under_section = False
    for level, shown, anchor in found:
        if level == 2:
            under_section = True
            lines.append(f"- [{shown}](#{anchor})")
        elif under_section:  # a ### before the first ## stays out of the list
            lines.append(f"  - [{shown}](#{anchor})")
    lines += [END, ""]
    return "\n".join(lines) + "\n"


def with_contents(text: str) -> str:
    """The guide's text with its list of contents brought up to date, just before its first section."""
    bare = BLOCK.sub("\n", text)
    block = contents_block(bare)
    if not block:
        return bare
    fenced = False
    lines = bare.split("\n")
    for i, line in enumerate(lines):
        if FENCE.match(line):
            fenced = not fenced
        elif not fenced and line.startswith("## "):
            before = "\n".join(lines[:i]).rstrip("\n")
            return f"{before}\n\n{block}" + "\n".join(lines[i:])
    return bare


def guides() -> list[Path]:
    return sorted({p for pattern in GUIDES for p in REPO.glob(pattern) if p.is_file()})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write or check the lists of contents of the long guides.")
    parser.add_argument("--check", action="store_true", help="only say which lists are out of date")
    args = parser.parse_args(argv)
    stale = []
    for path in guides():
        text = path.read_text(encoding="utf-8")
        new = with_contents(text)
        if new != text:
            stale.append(path.relative_to(REPO).as_posix())
            if not args.check:
                path.write_text(new, encoding="utf-8")
    if args.check and stale:
        print("These lists of contents are out of date; run python scripts/docs_contents.py: " + ", ".join(stale),
              file=sys.stderr)
        return 1
    if not args.check:
        print(f"Brought up to date: {', '.join(stale) or 'nothing (every list was)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
