"""Every tab-separated file ElectroTag writes reads back with one row per line and the same columns, whatever text a
value holds: tabs and line breaks in text become spaces (electrotag/app/io/tsv.py, tsv_cell)."""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pandas as pd

from electrotag.app.io.tsv import ROW_BREAKERS, tsv_cell, tsv_frame_text

#: Text with a tab and each kind of line break that Python or pandas would split a row on.
NASTY = "a\tb\nc\r\nd\re\vf\fg\x1ch\x1di\x1ej\x85k l m"


def _rows_read_back(text: str, n_columns: int, n_rows: int) -> None:
    """The text splits into the rows and columns written, by plain splitting, by the csv module and by pandas."""
    lines = text.rstrip("\n").split("\n")
    assert len(lines) == n_rows + 1
    assert all(len(line.split("\t")) == n_columns for line in lines)
    assert len(text.splitlines()) == n_rows + 1
    assert all(len(r) == n_columns for r in csv.reader(io.StringIO(text), delimiter="\t"))
    assert pd.read_csv(io.StringIO(text), sep="\t", dtype=str, keep_default_na=False).shape == (n_rows, n_columns)


def test_a_cell_never_holds_a_tab_or_a_line_break() -> None:
    assert tsv_cell(NASTY) == "a b c d e f g h i j k l m"
    assert not ROW_BREAKERS.search(tsv_cell(NASTY))
    assert tsv_cell(None) == "" and tsv_cell(3) == "3" and tsv_cell("plain text, kept") == "plain text, kept"
    # the two characters \t written as text (as JSON writes a tab inside a string) are text, and stay
    assert tsv_cell("a\\tb") == "a\\tb"


def test_tables_of_the_analyses_read_back_whole() -> None:
    df = pd.DataFrame({"recording": [NASTY, "sub-001.vhdr"], "kappa": [0.5, float("nan")], f"col{NASTY}": ["x", "y"]})
    text = tsv_frame_text(df, na_rep="n/a", float_format="%.6g")
    _rows_read_back(text, 3, 2)
    assert "a b c" in text and "n/a" in text


def test_the_activity_tables_read_back_whole(tmp_path: Path) -> None:
    from electrotag.activity.summary import write_tsv

    p = tmp_path / "events.tsv"
    write_tsv(p, [{"type": "status_message", "text": NASTY, "n": 3}, {"type": "key", "text": "Tab", "n": None}],
              ["type", "text", "n"])
    _rows_read_back(p.read_text(encoding="utf-8"), 3, 2)


def test_the_results_folders_tables_read_back_whole() -> None:
    from electrotag.web import feedback, tracking

    text = tracking._tsv(("id", "name", "note"), [{"id": "h-1", "name": NASTY, "note": None}]).decode("utf-8")
    _rows_read_back(text, 3, 1)
    text = feedback._tsv(("id", "reason", "channels"), [{"id": "p-1", "reason": NASTY, "channels": [NASTY, "Fz"]}]
                         ).decode("utf-8")
    _rows_read_back(text, 3, 1)


def test_the_failure_list_keeps_one_failure_per_line(tmp_path: Path) -> None:
    from electrotag.app.io.naming import OutputLayout
    from electrotag.app.session.failures import FailureLog

    layout = OutputLayout(tmp_path)
    FailureLog(layout).record(None, f"sub-01/{NASTY}.edf", "load_error", f"The file\nis damaged\t({NASTY})")
    lines = layout.failed_load_txt.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and len(lines[0].split("\t")) == 3
