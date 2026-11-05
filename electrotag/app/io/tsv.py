"""Exact reading and writing of BIDS-style tab-separated files.

Values are kept as the original strings. Nothing is parsed to numbers and
re-formatted, so original event rows are reproduced byte-for-byte in exports
(apart from line endings, which are normalised to ``\\n``).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

#: Characters that would break a row of a tab-separated file when read back: the tab, and every character that
#: Python's ``str.splitlines`` or pandas treats as the end of a line.
ROW_BREAKERS = re.compile("[\t\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]+")


class TSVError(ValueError):
    """Raised for malformed TSV files or values that cannot be written safely."""


def parse_tsv_text(text: str, source: str = "<text>") -> tuple[list[str], list[list[str]]]:
    if text.startswith("﻿"):
        text = text[1:]
    # Split on line feeds only (str.splitlines would also split on form feeds,
    # Unicode separators etc. that may legitimately appear inside a value).
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
    # Drop blank lines at the end, but keep rows whose cells are all empty (they contain tabs).
    while lines and "\t" not in lines[-1] and lines[-1].strip() == "":
        lines.pop()
    if not lines:
        raise TSVError(f"{source} is empty (no header row)")
    header = lines[0].split("\t")
    if any(h.strip() == "" for h in header):
        raise TSVError(f"{source} has an empty column name in its header")
    if len(set(header)) != len(header):
        raise TSVError(f"{source} has duplicate column names: {header}")
    rows = []
    for n, line in enumerate(lines[1:], start=2):
        cells = line.split("\t")
        if len(cells) != len(header):
            raise TSVError(
                f"{source} line {n} has {len(cells)} fields but the header has {len(header)}"
            )
        rows.append(cells)
    return header, rows


def read_tsv(path: Path | str) -> tuple[list[str], list[list[str]]]:
    p = Path(path)
    try:
        raw = p.read_bytes()
    except OSError as exc:
        raise TSVError(f"Cannot read {p}: {exc}") from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    return parse_tsv_text(text, str(p))


def tsv_bytes(columns: list[str], rows: list[list[str]]) -> bytes:
    for name in columns:
        _check_cell(name)
    out = ["\t".join(columns)]
    for i, row in enumerate(rows):
        if len(row) != len(columns):
            raise TSVError(f"Row {i} has {len(row)} values for {len(columns)} columns")
        for cell in row:
            _check_cell(cell)
        out.append("\t".join(row))
    return ("\n".join(out) + "\n").encode("utf-8")


def _check_cell(value: str) -> None:
    if not isinstance(value, str):
        raise TSVError(f"TSV cells must be strings, got {type(value).__name__}")
    if any(ch in value for ch in "\t\n\r"):
        raise TSVError(f"TSV cell contains a tab or line break: {value!r}")


def tsv_cell(value: Any) -> str:
    """A value as one cell of a tab-separated file: as text, with every tab and line break (``ROW_BREAKERS``)
    replaced by a space, so that a row always reads back as one row with its columns, whether it is split on
    tabs or read with pandas or the csv module."""
    return ROW_BREAKERS.sub(" ", "" if value is None else str(value))


def tsv_frame_text(df: Any, **to_csv: Any) -> str:
    """A pandas table as tab-separated text, its text columns cleaned with :func:`tsv_cell` first."""
    from pandas.api.types import is_numeric_dtype

    clean = df.copy()
    for column in clean.columns:
        if not is_numeric_dtype(clean[column].dtype):  # text, whether object or pandas' own string type
            clean[column] = clean[column].map(lambda v: tsv_cell(v) if isinstance(v, str) else v)
    clean.columns = [tsv_cell(c) for c in clean.columns]
    return clean.to_csv(sep="\t", index=False, **to_csv)


def rows_as_dicts(columns: list[str], rows: list[list[str]]) -> list[dict[str, str]]:
    return [dict(zip(columns, row)) for row in rows]
