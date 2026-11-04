"""Each saved version's own interaction log, made from the visits' logs (electrotag/web/recording_logs.py).

These tests give the logs and the completion register directly; tests/test_web_recording_logs.py has the
ElectroTag server write them as a browser's visits and saves arrive."""

from __future__ import annotations

import json
from typing import Any

from electrotag.app.io.naming import RECORDING_LOG_SUFFIX, next_free_attempt, output_basename
from electrotag.web.recording_logs import SCHEMA, recording_log_texts

R = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
BASE = "sub-001_task-rest_eeg_annotator-A01"
FOLDER = "annotator-A01/sub-001/eeg"


def visit(vid: str, started: str, events: list[dict[str, Any]], aid: str = "A01") -> tuple[dict, dict, list]:
    numbered = [{"seq": i + 1, "wall": started, **e} for i, e in enumerate(events)]
    header = {"type": "header", "visit_id": vid, "annotator_id": aid, "started_at": started,
              "versions": {"electrotag": "test"}, "screens": [{"width": 1920}], "logging": {"pointer_hz": 5},
              "client": "web", "dataset_root": ""}
    return {"visit_id": vid, "annotator_id": aid, "context_id": "", "started_at": started}, header, numbered


def win(n: int, rid: str = R) -> dict[str, Any]:
    return {"recording": rid, "window_no": n}


def entry(session_id: str, attempt: int = 1, rid: str = R, elapsed: str = "61.5") -> dict[str, str]:
    base = BASE if attempt == 1 else f"{BASE}_attempt-{attempt:02d}"
    return {"recording_id": rid, "annotator_id": "A01", "mode": "standard", "context": "", "status": "completed",
            "session_id": session_id, "completed_at": "2026-11-04T11:02:00+00:00", "elapsed_s": elapsed,
            "output_dir": FOLDER, "output_basename": base}


def lines(text: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in text.splitlines()]


V1 = visit("a" * 32, "2026-11-04T10:00:00+00:00", [
    {"t": 0.0, "type": "visit_started"},
    {"t": 1.0, "type": "recording_opened", **win(1), "session_id": "s1", "mode": "standard"},
    {"t": 5.0, "type": "key", **win(1), "key": "1"},
    {"t": 6.0, "type": "key", "key": "B"},  # on the home page: no recording's
    {"t": 61.0, "type": "closed_without_saving", **win(1), "kept": True},
    {"t": 70.0, "type": "log_closed", "reason": "sign_out"},
])
V2 = visit("b" * 32, "2026-11-04T11:00:00+00:00", [
    {"t": 0.0, "type": "visit_started"},
    {"t": 2.0, "type": "recording_opened", **win(1), "session_id": "s2", "mode": "standard"},
    {"t": 3.0, "type": "view", **win(1)},
    {"t": 100.0, "type": "recording_finished", **win(1), "session_id": "s2"},
    {"t": 110.0, "type": "recording_opened", **win(2), "session_id": "s3", "mode": "standard"},
    {"t": 120.0, "type": "recording_finished", **win(2), "session_id": "s3"},
    {"t": 130.0, "type": "recording_opened", **win(3), "session_id": "s4", "mode": "standard"},  # not saved yet
])


def test_a_saved_version_gets_its_segments_from_every_visit_since_the_last_save() -> None:
    out = recording_log_texts([entry("s2"), entry("s3", 2, elapsed="10")], [V2, V1])
    first, second = f"{FOLDER}/{BASE}{RECORDING_LOG_SUFFIX}", f"{FOLDER}/{BASE}_attempt-02{RECORDING_LOG_SUFFIX}"
    assert sorted(out) == sorted([first, second])
    head, *events = lines(out[first])
    assert head["type"] == "header" and head["schema"] == SCHEMA and head["attempt"] == 1
    assert (head["annotator_id"], head["recording_id"], head["session_id"], head["output_basename"]) == (
        "A01", R, "s2", BASE)
    assert head["elapsed_s"] == 61.5 and head["open_s"] == 158.0
    assert [(s["visit_id"], s["window_no"], s["outcome"], s["open_s"], s["n_events"]) for s in head["segments"]] == [
        ("a" * 32, 1, "closed_without_saving", 60.0, 3), ("b" * 32, 1, "finished", 98.0, 3)]
    assert head["segments"][0]["started_at"] == "2026-11-04T10:00:01.000+00:00"
    assert sorted(head["visits"]) == ["a" * 32, "b" * 32] and "dataset_root" not in head["visits"]["a" * 32]
    assert [(e["visit_id"][0], e["seq"], e["type"]) for e in events] == [
        ("a", 2, "recording_opened"), ("a", 3, "key"), ("a", 5, "closed_without_saving"),
        ("b", 2, "recording_opened"), ("b", 3, "view"), ("b", 4, "recording_finished")]
    head2, *events2 = lines(out[second])
    assert head2["attempt"] == 2 and [e["type"] for e in events2] == ["recording_opened", "recording_finished"]


def test_the_files_are_the_same_whatever_order_the_logs_come_in() -> None:
    entries = [entry("s2"), entry("s3", 2)]
    assert recording_log_texts(entries, [V1, V2]) == recording_log_texts(list(reversed(entries)), [V2, V1])


def test_nothing_without_logs_or_a_saved_version() -> None:
    assert recording_log_texts([entry("s2")], []) == {}
    assert recording_log_texts([], [V1, V2]) == {}
    assert recording_log_texts([{**entry("s2"), "status": "failed"}], [V1, V2]) == {}
    other = visit("c" * 32, "2026-11-04T12:00:00+00:00", V2[2], aid="A02")[0], V2[1], V2[2]
    assert recording_log_texts([entry("s2")], [other]) == {}, "another person's visit"


def test_older_logs_without_the_session_id_are_matched_in_order() -> None:
    plain = visit("d" * 32, "2026-11-04T09:00:00+00:00", [
        {"t": 1.0, "type": "recording_opened", **win(1), "mode": "standard"},
        {"t": 9.0, "type": "recording_finished", **win(1)},
        {"t": 10.0, "type": "log_closed"}])
    out = recording_log_texts([entry("")], [plain])
    assert [s["window_no"] for s in lines(out[f"{FOLDER}/{BASE}{RECORDING_LOG_SUFFIX}"])[0]["segments"]] == [1]


def test_a_visit_that_stopped_without_closing_ends_at_its_last_event() -> None:
    cut = visit("e" * 32, "2026-11-04T09:00:00+00:00", [
        {"t": 1.0, "type": "recording_opened", **win(4), "session_id": "s9", "mode": "standard"},
        {"t": 40.0, "type": "pointer", **win(4)}])
    later = visit("f" * 32, "2026-11-04T10:00:00+00:00", [
        {"t": 1.0, "type": "recording_opened", **win(1), "session_id": "s10", "mode": "standard"},
        {"t": 5.0, "type": "recording_finished", **win(1), "session_id": "s10"}])
    head = lines(recording_log_texts([entry("s10")], [later, cut])[f"{FOLDER}/{BASE}{RECORDING_LOG_SUFFIX}"])[0]
    assert [(s["outcome"], s["open_s"], s["ended_at"]) for s in head["segments"]] == [
        ("not_finished", 39.0, "2026-11-04T09:00:40.000+00:00"), ("finished", 4.0, "2026-11-04T10:00:05.000+00:00")]


def test_the_log_is_not_a_result_file() -> None:
    """The log beside a version never makes the next save take another attempt number."""
    assert output_basename("sub-001_task-rest_eeg", "A01") == BASE
    from pathlib import Path
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as d:
        (Path(d) / f"{BASE}{RECORDING_LOG_SUFFIX}").write_text("{}\n", encoding="utf-8")
        assert next_free_attempt(Path(d), "sub-001_task-rest_eeg", "A01") == 1
