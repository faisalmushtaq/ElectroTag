"""One interaction log per saved recording, beside the recording's result files.

The study keeps one interaction log per visit (``interaction_logs/annotator-<ID>/<time>_<mode>.jsonl``),
from signing in to signing out, whatever was opened in between; that whole-visit log stays, since it
holds everything, including what happened outside any recording and visits that ended in an error.
Beside each saved version of a recording, the study also keeps the part of those logs that belongs
to it: ``<output basename>_interaction_log.jsonl`` in the folder of the version's result files
(docs/file_formats.md, docs/activity_logs.md).

A saved version's log holds every **segment** (one recording opened in one browser window of a visit,
from its ``recording_opened`` to its ``recording_finished``, ``closed_without_saving`` or the end of
the visit; :func:`~electrotag.web.store.index_rows`) of that person on that recording, in that mode and
context, since the version before it was saved, up to and including the segment that saved it. Work
left as a draft in one visit and saved in a later one therefore comes together in one file, and so do
the times the recording was opened and closed without saving in between. Segments are matched to the
versions they saved by the session's ID, which the browser sends with its save (:func:`assign_attempts`).

The file is JSON Lines. Its first line is a header (``type`` ``"header"``, ``schema``
``"electrotag.recording_log"``) naming the annotator, recording, mode, context, version (``attempt``),
session and output basename, with the version's ``elapsed_s`` from the completion register, the
``segments`` (each with its visit, window, times, outcome, ``open_s`` and number of events) and, for each
visit, what its own header says about the browser, screen, settings and logging (``visits``). Every
other line is one of the segments' events exactly as in the visit's log, with the ``visit_id`` added, since
``seq`` and ``t`` count from the start of each visit.

The files are made from the logs and the register whenever they are needed, so making them again gives
the same bytes: the ElectroTag server writes them into the study folder as each segment ends and each
version is saved (:func:`refresh_files_store`), and ``electrotag web export`` and the results zip write
them for a study on Firebase (:func:`recording_log_files`). Nothing is written when the study keeps no
interaction logs.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from electrotag.app.io.naming import RECORDING_LOG_SUFFIX
from electrotag.web.store import attempt_of, index_rows

log = logging.getLogger(__name__)

SCHEMA = "electrotag.recording_log"
SCHEMA_VERSION = "1.0.0"
#: What a saved version's log keeps of each visit's header.
HEADER_FIELDS = ("started_at", "versions", "os", "screens", "settings_sha256", "filters", "logging", "client",
                 "browser")
#: How many of a person's visits are read when the files are made (all of them, in practice).
MAX_VISITS = 100_000
OUTCOMES = {"finished": "finished", "closed_without_saving": "closed_without_saving", "": "not_finished"}

#: One visit's log: its record (``visit_id``, ``annotator_id``, ``context_id``, ``started_at``), its header and
#: its numbered events.
VisitLog = tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]


def assign_attempts(segments: list[dict[str, Any]], entries: list[dict[str, Any]]) -> None:
    """Set each finished segment's ``attempt``: the version it saved, by the session's ID, and for logs from
    before the browser sent that ID with its save, in order (the n-th finished segment saved the n-th version).

    ``segments`` (oldest first) and ``entries`` (completed register rows) are of one person, recording, mode
    and context."""
    entries = sorted(entries, key=attempt_of)
    by_session = {str(e.get("session_id") or ""): attempt_of(e) for e in entries if e.get("session_id")}
    claimed: set[int] = set()
    for s in segments:
        s.setdefault("attempt", None)
        if s["outcome"] == "finished" and s["session_id"] in by_session:
            s["attempt"] = by_session[s["session_id"]]
            claimed.add(s["attempt"])
    free = [attempt_of(e) for e in entries if attempt_of(e) not in claimed]
    for s in segments:
        if s["outcome"] == "finished" and s["attempt"] is None and free:
            s["attempt"] = free.pop(0)


def segments_by_version(segments: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    """The segments that belong to each saved version (see the module docstring): those since the previous
    finished segment, up to and including the one that saved it. A finished segment matched to no version
    (its save is not in the register) closes the run before it without belonging to any version."""
    out: dict[int, list[dict[str, Any]]] = {}
    run: list[dict[str, Any]] = []
    for s in segments:
        run.append(s)
        if s["outcome"] != "finished":
            continue
        if s.get("attempt") is not None and s["attempt"] not in out:
            out[s["attempt"]] = run
        run = []
    return out


def _when(started_at: Any, offset_s: Any) -> str | None:
    try:
        return (datetime.fromisoformat(str(started_at)) + timedelta(seconds=float(offset_s or 0.0))).isoformat(
            timespec="milliseconds")
    except (TypeError, ValueError):
        return None


def _key(recording_id: str, mode: str, context_id: str) -> tuple[str, str, str]:
    mode = mode or "standard"
    return recording_id, mode, context_id if mode != "standard" else ""


recording_key = _key


def _segments(visits: list[VisitLog]) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
    """Each recording's segments (by recording, mode and context), oldest first, with their events."""
    out: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for record, header, events in sorted(visits, key=lambda v: str(v[0].get("started_at") or
                                                                  v[1].get("started_at") or "")):
        vid = str(record.get("visit_id") or header.get("visit_id") or "")
        started = header.get("started_at") or record.get("started_at")
        events = sorted((e for e in events if isinstance(e.get("seq"), int)), key=lambda e: e["seq"])
        for row in index_rows([], events, str(record.get("context_id") or header.get("context_id") or "")):
            if not row.get("recording_id") or row.get("window_no") is None:
                continue
            first, last = int(row["first_seq"]), row.get("last_seq")
            mine = [e for e in events if e["seq"] >= first and (last is None or e["seq"] <= int(last))
                    and e.get("window_no") == row["window_no"]]
            opened, ended = float(row.get("opened_t") or 0.0), row.get("ended_t")
            if ended is None and mine:  # a visit that stopped without closing: up to its last event
                ended = float(mine[-1].get("t") or opened)
            out.setdefault(_key(row["recording_id"], row.get("mode") or "standard", row.get("context_id") or ""),
                           []).append({
                "visit_id": vid, "window_no": row["window_no"], "session_id": str(row.get("session_id") or ""),
                "started_at": _when(started, opened), "ended_at": _when(started, ended) if ended is not None else None,
                "outcome": OUTCOMES.get(str(row.get("outcome") or ""), "not_finished"),
                "open_s": round(max(0.0, float(ended) - opened), 3) if ended is not None else None,
                "n_events": len(mine), "events": mine, "header": header})
    return out


def _jsonl(obj: dict[str, Any]) -> str:
    from electrotag.app.session.interaction_log import _jsonable

    return json.dumps(_jsonable(obj), ensure_ascii=False, separators=(",", ":")) + "\n"


def log_text(entry: dict[str, Any], segments: list[dict[str, Any]]) -> str:
    """The log of one saved version (``entry``, its completion register row) from its ``segments``."""
    visits: dict[str, dict[str, Any]] = {}
    for s in segments:
        visits.setdefault(s["visit_id"], {k: s["header"][k] for k in HEADER_FIELDS if k in s["header"]})
    mode = entry.get("mode") or "standard"
    try:
        elapsed: float | None = float(entry.get("elapsed_s") or "")
    except ValueError:
        elapsed = None
    header = {
        "type": "header", "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
        "annotator_id": entry.get("annotator_id", ""), "recording_id": entry.get("recording_id", ""), "mode": mode,
        "context_id": entry.get("context", "") if mode != "standard" else "", "attempt": attempt_of(entry),
        "session_id": entry.get("session_id", ""), "output_basename": entry.get("output_basename", ""),
        "completed_at": entry.get("completed_at", ""), "elapsed_s": elapsed,
        "open_s": round(sum(s["open_s"] or 0.0 for s in segments), 3),
        "segments": [{k: s[k] for k in ("visit_id", "window_no", "session_id", "started_at", "ended_at", "outcome",
                                        "open_s", "n_events")} for s in segments],
        "visits": visits,
    }
    return _jsonl(header) + "".join(_jsonl({"visit_id": s["visit_id"], **e}) for s in segments for e in s["events"])


def recording_log_texts(entries: Iterable[dict[str, Any]], visits: list[VisitLog]) -> dict[str, str]:
    """``{relative path: text}``: the log of each completed register row in ``entries`` that has segments in
    ``visits``, at ``<output_dir>/<output_basename>_interaction_log.jsonl`` below the results folder."""
    by_person: dict[str, list[VisitLog]] = {}
    for v in visits:
        aid = str(v[0].get("annotator_id") or v[1].get("annotator_id") or "")
        by_person.setdefault(aid, []).append(v)
    wanted: dict[str, dict[tuple[str, str, str], list[dict[str, Any]]]] = {}
    for e in entries:
        if e.get("status") != "completed" or not e.get("output_dir") or not e.get("output_basename"):
            continue
        key = _key(str(e.get("recording_id") or ""), str(e.get("mode") or "standard"), str(e.get("context") or ""))
        wanted.setdefault(str(e.get("annotator_id") or ""), {}).setdefault(key, []).append(e)
    out: dict[str, str] = {}
    for aid, keys in wanted.items():
        segs = _segments(by_person.get(aid, []))
        for key, rows in keys.items():
            mine = segs.get(key, [])
            if not mine:
                continue
            assign_attempts(mine, rows)
            versions = segments_by_version(mine)
            for e in rows:
                run = versions.get(attempt_of(e))
                if not run:
                    continue
                rel = PurePosixPath(str(e["output_dir"])) / f"{e['output_basename']}{RECORDING_LOG_SUFFIX}"
                out[rel.as_posix()] = log_text(e, run)
    return out


Key = tuple[str, str, str]


def visit_keys(rows: Iterable[dict[str, Any]]) -> set[Key]:
    """The recordings (recording, mode and context) of a visit's index rows."""
    return {_key(str(r.get("recording_id") or ""), str(r.get("mode") or "standard"), str(r.get("context_id") or ""))
            for r in rows if r.get("recording_id")}


def store_visit_logs(store: Any, annotator_id: str | None = None, keys: set[Key] | None = None) -> list[VisitLog]:
    """The visit logs of ``annotator_id`` (or of everyone) as a store keeps them: every one, or with ``keys`` only
    those that opened one of those recordings (found from the visits' indexes, without reading the logs)."""
    out: list[VisitLog] = []
    for record in store.visit_records(annotator_id, limit=MAX_VISITS):
        if keys is not None and not visit_keys(store.visit_index(record["visit_id"])) & keys:
            continue
        page = store.visit_log(record["visit_id"], from_seq=0, limit=10**9)
        out.append((record, page.get("header") or {}, page.get("events") or []))
    return out


def recording_log_files(store: Any, annotator_id: str | None = None, visits: list[VisitLog] | None = None,
                        keys: set[Key] | None = None) -> dict[str, bytes]:
    """``{relative path: bytes}``: the saved versions' logs of a study (see :func:`recording_log_texts`), from its
    completion register and its visit logs (``visits``, when the caller has read them already), of every
    recording or of those in ``keys``."""
    if visits is None:
        visits = store_visit_logs(store, annotator_id, keys)
    entries = [e for e in store.completion_entries(annotator_id) if keys is None or _key(
        str(e.get("recording_id") or ""), str(e.get("mode") or "standard"), str(e.get("context") or "")) in keys]
    return {rel: text.encode("utf-8") for rel, text in recording_log_texts(entries, visits).items()}


def write_files(root: Path, files: dict[str, bytes]) -> int:
    """Write ``files`` below ``root`` (the results folder), replacing a file only when its contents differ;
    returns how many were written."""
    from electrotag.app.io.atomic import atomic_write_bytes
    from electrotag.web.export import safe_path

    n = 0
    for rel, data in sorted(files.items()):
        path = safe_path(root, rel)
        try:
            if path.read_bytes() == data:
                continue
        except OSError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, data)
        n += 1
    return n


def refresh_files_store(store: Any, annotator_id: str | None = None, keys: set[Key] | None = None) -> int:
    """Bring the saved versions' logs in an ElectroTag server's study folder up to date (of one person, or of
    everyone; of every recording, or of those in ``keys``); a study on Firebase keeps none of its own (they are
    written when it is exported). Never raises: the logs are made again the next time."""
    if getattr(store, "kind", "") != "files" or keys == set():
        return 0
    try:
        return write_files(store.layout.root, recording_log_files(store, annotator_id, keys=keys))
    except Exception:  # noqa: BLE001 - the visit logs and the results are kept; these files are made again later
        log.exception("The recordings' interaction logs could not be written")
        return 0


__all__ = ["HEADER_FIELDS", "SCHEMA", "SCHEMA_VERSION", "assign_attempts", "log_text", "recording_key",
           "recording_log_files", "recording_log_texts", "refresh_files_store", "segments_by_version",
           "store_visit_logs", "visit_keys", "write_files"]
