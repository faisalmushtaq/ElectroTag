"""Downloading the interaction logs from the admin area (docs/admin_area.md, "Results"; docs/api.md, ``logs_zip``).

``logs_zip`` gives the visits' interaction logs as one zip file, all of them or those chosen by person, by kind
of session (mode), by the day the visit started and by the recordings it opened. Each visit's log is the whole
JSON Lines file of docs/interaction_logs.md, laid out as ``electrotag web export`` lays it out
(``interaction_logs/annotator-<ID>/<YYYYMMDDTHHMMSS>_<mode>.jsonl``), with ``interaction_logs/visits.tsv``, one
row a visit, and a ``README.txt`` that records what was chosen. A visit chosen for a recording keeps every event
of that visit, so that the log stays complete; each saved version's own share of the logs is in the results zip.

The logs are read through the store's visits (``visit_records``, ``visit_index`` and ``visit_log``), which both
stores implement, so nothing else of the study is read. The download changes nothing in the study, and it is
written to the audit log with what was chosen, as the results zip is.
"""

from __future__ import annotations

import base64
import csv
import io
import re
import zipfile
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.export import visit_log_text
from electrotag.web.store import MODES

if TYPE_CHECKING:
    from electrotag.web.service import StudyService
    from electrotag.web.store import User

READS = ("logs_zip",)
#: The largest zip of logs returned in one answer, as for the results zip.
MAX_ZIP_BYTES = 25_000_000
#: Every visit the store lists (a study keeps far fewer).
ALL_VISITS = 10_000_000
#: The events of a visit read in one page.
PAGE = 20_000
#: The columns of ``interaction_logs/visits.tsv``.
VISIT_COLUMNS = ("visit_id", "annotator_id", "mode", "context_id", "started_at", "closed_at", "n_events",
                 "recordings", "file")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _bad(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def _list(body: dict[str, Any], key: str, *, upper: bool = False) -> list[str] | None:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value) or len(value) > 5000:
        raise _bad(f"{key} must be a list of names")
    out = [x.strip().upper() if upper else x.strip() for x in value]
    return out or None


def _day(body: dict[str, Any], key: str) -> date | None:
    value = body.get(key)
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not _DAY.fullmatch(value):
        raise _bad(f"{key} must be a date written as YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise _bad(f"{key} must be a date written as YYYY-MM-DD") from exc


def _started_day(started_at: Any) -> date | None:
    """The day a visit started, in the local time it was written in."""
    text = str(started_at or "")
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _stem(visit: dict[str, Any]) -> str:
    """``<YYYYMMDDTHHMMSS>_<mode>``, the name the server and ``electrotag web export`` give a visit's log."""
    try:
        when = datetime.fromisoformat(str(visit.get("started_at") or "")).strftime("%Y%m%dT%H%M%S")
    except ValueError:
        when = str(visit.get("visit_id"))
    return f"{when}_{visit.get('mode') or 'standard'}"


class LogDownload:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def _choice(self, body: dict[str, Any]) -> dict[str, Any]:
        """What the request chose, checked: ``annotator_ids``, ``modes``, ``from``, ``to``, ``recording_ids``."""
        annotators = _list(body, "annotator_ids", upper=True)
        modes = _list(body, "modes")
        if modes and any(m not in MODES for m in modes):
            raise _bad(f"modes must be some of {', '.join(MODES)}")
        start, end = _day(body, "from"), _day(body, "to")
        if start and end and start > end:
            raise _bad("from must be on or before to")
        return {"annotator_ids": annotators, "modes": modes, "from": start, "to": end,
                "recording_ids": _list(body, "recording_ids")}

    def _visits(self, choice: dict[str, Any]) -> list[tuple[dict[str, Any], list[str]]]:
        """The visits chosen, oldest first, each with the recordings it opened."""
        people = choice["annotator_ids"]
        if people and len(people) == 1:
            rows = self.store.visit_records(people[0], ALL_VISITS)
        else:
            rows = self.store.visit_records(None, ALL_VISITS)
        wanted = set(choice["recording_ids"] or ())
        out = []
        for v in sorted(rows, key=lambda r: (str(r.get("started_at") or ""), str(r.get("visit_id")))):
            if people and str(v.get("annotator_id", "")).upper() not in people:
                continue
            if choice["modes"] and v.get("mode") not in choice["modes"]:
                continue
            day = _started_day(v.get("started_at"))
            if (choice["from"] and (day is None or day < choice["from"])) or \
                    (choice["to"] and (day is None or day > choice["to"])):
                continue
            opened = [str(r.get("recording_id")) for r in self.store.visit_index(str(v["visit_id"]))
                      if r.get("recording_id")]
            if wanted and not wanted.intersection(opened):
                continue
            out.append((v, list(dict.fromkeys(opened))))
        return out

    def _log(self, visit_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """A visit's header and every event, page by page."""
        header: dict[str, Any] = {}
        events: list[dict[str, Any]] = []
        nxt: int | None = 0
        while nxt is not None:
            page = self.store.visit_log(visit_id, from_seq=nxt, limit=PAGE)
            header = page.get("header") or header
            events.extend(page.get("events") or [])
            nxt = page.get("next_seq")
        return header, events

    def op_logs_zip(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        choice = self._choice(body)
        visits = self._visits(choice)
        if not visits:
            raise ApiError(422, "no_logs", "No interaction logs match what was chosen. Logs are kept when the study "
                           "records interactions and people have used ElectroTag; choose fewer filters to see more.")
        buf = io.BytesIO()
        index = io.StringIO()
        writer = csv.writer(index, delimiter="\t", lineterminator="\n")
        writer.writerow(VISIT_COLUMNS)
        names: set[str] = set()
        n_events = 0
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for v, opened in visits:
                header, events = self._log(str(v["visit_id"]))
                folder = f"interaction_logs/annotator-{v['annotator_id']}"
                stem, n = _stem(v), 2
                name = f"{folder}/{stem}.jsonl"
                while name in names:  # two visits begun in the same second
                    name, n = f"{folder}/{stem}-{n}.jsonl", n + 1
                names.add(name)
                zf.writestr(name, visit_log_text(header, events))
                n_events += len(events)
                writer.writerow([v["visit_id"], v["annotator_id"], v.get("mode", ""), v.get("context_id", ""),
                                 v.get("started_at") or "", v.get("closed_at") or "", len(events), ";".join(opened),
                                 name])
            zf.writestr("interaction_logs/visits.tsv", index.getvalue())
            zf.writestr("README.txt", self._readme(choice, len(visits), n_events))
        size = buf.tell()
        if size > MAX_ZIP_BYTES:
            raise ApiError(413, "too_large", f"These logs are {size / 1e6:.0f} MB, more than the "
                           f"{MAX_ZIP_BYTES // 1_000_000} MB the admin area downloads. Choose fewer people, sessions "
                           "or days, or export the whole study with 'electrotag-web export'.", size_bytes=size)
        details = {k: (v.isoformat() if isinstance(v, date) else v) for k, v in choice.items() if v}
        audit.record(self.store, user.annotator_id, "logs_zip",
                     f"Downloaded the interaction logs of {audit.count(len(visits), 'visit')} (zip)",
                     {**details, "visits": len(visits)})
        return {"file_name": f"{self.store.study_id}_interaction_logs.zip",
                "base64": base64.b64encode(buf.getvalue()).decode("ascii"), "size_bytes": size,
                "visits": len(visits), "events": n_events}

    def _readme(self, choice: dict[str, Any], n_visits: int, n_events: int) -> str:
        def said(key: str, words: str) -> str:
            v = choice[key]
            if not v:
                return f"{words}: all\n"
            return f"{words}: {v.isoformat() if isinstance(v, date) else ', '.join(v)}\n"

        return (f"Interaction logs of the ElectroTag study {self.store.study_id}, downloaded {now_local_iso()}.\n\n"
                f"{n_visits} visits, {n_events} events.\n"
                + said("annotator_ids", "People") + said("modes", "Sessions") + said("from", "Visits begun from")
                + said("to", "Visits begun up to") + said("recording_ids", "Visits that opened")
                + "\ninteraction_logs/annotator-<ID>/<YYYYMMDDTHHMMSS>_<mode>.jsonl holds one visit's log, from "
                  "signing in to signing out, as JSON Lines: a header, then one event a line "
                  "(docs/interaction_logs.md, \"File format\"). A visit chosen for a recording keeps all its "
                  "events. interaction_logs/visits.tsv lists the visits with the recordings each opened. 'electrotag activity interaction_logs' makes the "
                  "activity tables and report from these files.\n")


__all__ = ["MAX_ZIP_BYTES", "READS", "VISIT_COLUMNS", "LogDownload"]
