"""The documentation names things as they are now.

The project was called ElectroClean until 29 October 2026 and its Firebase functions were named
``ec_<operation>``; they are ``et_<operation>`` now. The only mentions of the old name left are the
branch ``claude/electroclean-web``, which exists, the CHANGELOG (versions released as ElectroClean
and the paragraph on the rename) and the handover notes' sentence on the rename.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
FUNCTIONS = REPO / "electrotag" / "web" / "firebase" / "functions" / "main.py"
NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
           "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
           "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven", "twenty-eight",
           "twenty-nine", "thirty"]
TEXT_SUFFIXES = {".md", ".py", ".js", ".mjs", ".html", ".css", ".yml", ".yaml", ".toml", ".txt", ".sh", ".json"}
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "fixtures", "example_output", "vendor"}


def text_files() -> list[Path]:
    out = []
    for p in REPO.rglob("*"):
        rel = p.relative_to(REPO)
        if (p.is_file() and p.suffix in TEXT_SUFFIXES and not SKIP_DIRS & set(rel.parts)
                and not any(part.endswith(".egg-info") for part in rel.parts)):
            out.append(p)
    return out


def docs() -> list[Path]:
    return [p for p in text_files() if p.suffix == ".md"]


def test_no_file_names_the_old_ec_functions():
    old = re.compile(r"(?<![A-Za-z0-9_])ec_[a-z<]")
    found = [f"{p.relative_to(REPO)}:{i}: {line.strip()}"
             for p in text_files() if p.name != "CHANGELOG.md" and p != Path(__file__)
             for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1) if old.search(line)]
    assert found == []


def test_the_old_name_remains_only_where_it_belongs():
    allowed = ("claude/electroclean-web", "was called ElectroClean until")
    # A study's own config.json (never committed) names its Firebase project, whatever it is called.
    own_config = REPO / "electrotag" / "web" / "static" / "config.json"
    found = []
    for p in text_files():
        if p.name == "CHANGELOG.md" or p == Path(__file__) or p == own_config:
            continue
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            rest = line
            for a in allowed:
                rest = rest.replace(a, "")
            if re.search(r"electroclean", rest, flags=re.IGNORECASE) or re.search(r"\bEC\b", rest):
                found.append(f"{p.relative_to(REPO)}:{i}: {line.strip()}")
    assert found == []


def test_the_firebase_guide_counts_the_functions_there_are():
    names = re.findall(r"^def (et_\w+)\(", FUNCTIONS.read_text(encoding="utf-8"), flags=re.MULTILINE)
    guide = (REPO / "docs" / "firebase.md").read_text(encoding="utf-8")
    said = re.search(r"lists ElectroTag's ([a-z-]+) functions, whose names start with `et_`", guide)
    assert said, "docs/firebase.md no longer says how many functions the console lists"
    assert said.group(1) == NUMBERS[len(names)], f"main.py defines {len(names)}: {', '.join(names)}"


@pytest.mark.parametrize("doc", ["README.md", "HANDOVER.md", "docs/developer_guide.md", "docs/testing_guide.md",
                                 "docs/server.md", "docs/firebase.md"])
def test_install_instructions_use_plain_pip_in_an_active_environment(doc):
    text = (REPO / doc).read_text(encoding="utf-8")
    assert "python -m pip install -r requirements" not in text
    assert "--no-deps -e ." not in text


def test_the_readme_says_where_the_package_comes_from_and_links_every_guide():
    text = (REPO / "README.md").read_text(encoding="utf-8")
    assert "not published on PyPI" in text
    assert 'pip install "electrotag @ git+https://github.com/faisalmushtaq/ElectroTag"' in text
    assert "source .venv/bin/activate" in text and ".venv\\Scripts\\activate" in text
    top = text[:text.index("## Trying it")]
    for guide in ("docs/using.md", "docs/admin_area.md", "docs/firebase.md", "docs/server.md",
                  "docs/developer_guide.md"):
        assert f"]({guide})" in top, f"the Documentation section near the top links {guide}"
    for target in re.findall(r"\]\((?!https?://|#)([^)#]+)", text):
        assert (REPO / target).exists(), target


def test_the_annotators_guide_says_who_it_is_for():
    first = (REPO / "docs" / "using.md").read_text(encoding="utf-8").split("\n\n")[1]
    assert first.startswith("This guide is for annotators.")


def test_every_long_guide_has_its_list_of_contents_up_to_date() -> None:
    """The lists of contents at the top of the long guides are made from their headings
    (scripts/docs_contents.py); after a heading changes, running the script brings them up to date."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("docs_contents", REPO / "scripts" / "docs_contents.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.main(["--check"]) == 0, "run python scripts/docs_contents.py"
    for path in module.guides():
        text = path.read_text(encoding="utf-8")
        anchors = {a for _, _, a in module.headings(text)}
        if module.START in text:
            listed = re.findall(r"\]\(#([^)]+)\)", text[text.index(module.START):text.index(module.END)])
            assert listed and set(listed) <= anchors, path


def _contents_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("docs_contents_links", REPO / "scripts" / "docs_contents.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _anchors(path: Path, cache: dict[Path, set[str]]) -> set[str]:
    if path not in cache:
        cache[path] = {a for _, _, a in _contents_module().headings(path.read_text(encoding="utf-8"))}
    return cache[path]


def _outside_code(text: str) -> str:
    """The text without fenced code blocks and inline code, where a "link" is only an example."""
    text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1", "", text)
    return re.sub(r"`[^`\n]*`", "", text)


def test_every_link_in_the_guides_reaches_its_page_and_heading():
    """Every relative link in every Markdown file leads to a file of the repository, and every #anchor to a heading
    of the page it names (with GitHub's anchors, scripts/docs_contents.py)."""
    cache: dict[Path, set[str]] = {}
    broken = []
    for doc in docs():
        for target, anchor in re.findall(r"\]\(([^)\s#]*)(?:#([^)\s]+))?\)", _outside_code(doc.read_text(encoding="utf-8"))):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("/"):
                continue
            page = (doc.parent / target).resolve() if target else doc
            if not page.exists():
                broken.append(f"{doc.relative_to(REPO)}: {target} does not exist")
            elif anchor and page.suffix == ".md" and anchor not in _anchors(page, cache):
                broken.append(f"{doc.relative_to(REPO)}: {target or doc.name}#{anchor} names no heading")
    assert not broken, "\n".join(broken)


def test_every_guide_named_in_the_repository_exists():
    """A guide named by its path anywhere (code, comments, workflows, guides: docs/….md) is there, and so is a
    page of this repository linked by its address on GitHub."""
    missing = set()
    for p in text_files():
        text = p.read_text(encoding="utf-8", errors="replace")
        for name in re.findall(r"(?<![\w/.-])docs/[\w./-]+\.md", text):
            if not (REPO / name).is_file():
                missing.add(f"{p.relative_to(REPO)}: {name}")
        for name in re.findall(r"ElectroTag/(?:blob|tree)/main/([\w./-]+)", text):
            if not (REPO / name.rstrip("/")).exists():
                missing.add(f"{p.relative_to(REPO)}: {name}")
    if (REPO / "CHANGELOG.md").exists():  # earlier versions' paragraphs may name guides as they were then
        missing = {m for m in missing if not m.startswith("CHANGELOG.md:")}
    assert not missing, "\n".join(sorted(missing))


def test_the_applications_links_into_the_guides_reach_their_headings():
    """docsUrl and docsLink in the application name guides under docs/ (js/ui/docs.js), with anchors that exist."""
    base = (REPO / "electrotag" / "web" / "static" / "js" / "ui" / "docs.js").read_text(encoding="utf-8")
    assert "github.com/faisalmushtaq/ElectroTag/blob/main/docs/'" in base
    cache: dict[Path, set[str]] = {}
    seen = 0
    for p in (REPO / "electrotag" / "web" / "static" / "js").rglob("*.js"):
        text = p.read_text(encoding="utf-8")
        for path, anchor in re.findall(r"docs(?:Url|Link)\((?:[^,()]*, )?'([\w./-]+\.md)'(?:, '([\w-]+)')?", text):
            seen += 1
            page = REPO / "docs" / path
            assert page.is_file(), f"{p.relative_to(REPO)} links to docs/{path}, which does not exist"
            if anchor:
                assert anchor in _anchors(page, cache), f"{p.relative_to(REPO)}: docs/{path}#{anchor} names no heading"
    assert seen >= 4
