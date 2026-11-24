"""The admin area's download of the interaction logs (``logs_zip``; docs/api.md, docs/admin_area.md "Results")."""

from __future__ import annotations

import base64
import csv
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")

from electrotag.web.admin import OPERATIONS, READ_ONLY  # noqa: E402
from electrotag.web.errors import ApiError  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import SUB1, SUB2, copy_demo, make_template  # noqa: E402

A01, A02 = User("A01", "Annotator one"), User("A02", "Annotator two")
ADMIN = User("ADMIN", "Study administrator", role="admin")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("log-download"))


@pytest.fixture
def service(template: Path, tmp_path: Path):
    svc = StudyService(FilesStore(copy_demo(template, tmp_path)))
    yield svc
    svc.store.close()


def visit(service: StudyService, user: User, recordings: list[str], mode: str | None = None, n_keys: int = 2) -> str:
    """A visit that opens each recording in turn and presses a few keys, then signs out."""
    body: dict[str, Any] = {"client": {"user_agent": "pytest"}}
    if mode:
        body.update(mode=mode, context_id="example")
    v = service.call("visit_open", user, body)["visit_id"]
    t, events = 1.0, []
    for i, rid in enumerate(recordings, start=1):
        events.append({"t": t, "type": "recording_opened", "recording": rid, "window_no": i})
        events += [{"t": t + k / 10, "type": "key", "key": "ArrowRight", "recording": rid, "window_no": i}
                   for k in range(1, n_keys + 1)]
        events.append({"t": t + 1, "type": "closed_without_saving", "recording": rid, "window_no": i})
        t += 2
    if events:
        service.call("visit_events", user, {"visit_id": v, "events": events})
    service.call("visit_close", user, {"visit_id": v, "reason": "signed_out"})
    return v


def download(service: StudyService, **body: Any) -> tuple[dict[str, Any], zipfile.ZipFile]:
    r = service.call("admin", ADMIN, {"op": "logs_zip", **body})
    return r, zipfile.ZipFile(io.BytesIO(base64.b64decode(r["base64"])))


def index(z: zipfile.ZipFile) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(z.read("interaction_logs/visits.tsv").decode()), delimiter="\t"))


def refused(service: StudyService, body: dict[str, Any], user: User = ADMIN) -> ApiError:
    with pytest.raises(ApiError) as e:
        service.call("admin", user, {"op": "logs_zip", **body})
    return e.value


def test_logs_zip_is_an_admin_read() -> None:
    assert "logs_zip" in OPERATIONS and "logs_zip" in READ_ONLY
    assert OPERATIONS.count("logs_zip") == 1


def test_every_log_or_those_chosen(service: StudyService) -> None:
    assert refused(service, {}).code == "no_logs"
    v1 = visit(service, A01, [SUB1])
    v2 = visit(service, A01, [SUB2], mode="practice", n_keys=5)
    v3 = visit(service, A02, [SUB1, SUB2])
    v4 = visit(service, A02, [])

    r, z = download(service)
    assert r["visits"] == 4 and r["file_name"] == f"{service.store.study_id}_interaction_logs.zip"
    assert r["size_bytes"] == len(base64.b64decode(r["base64"]))
    rows = index(z)
    assert {x["visit_id"] for x in rows} == {v1, v2, v3, v4}
    by_id = {x["visit_id"]: x for x in rows}
    assert by_id[v3]["recordings"] == f"{SUB1};{SUB2}" and by_id[v4]["recordings"] == ""
    assert by_id[v2]["mode"] == "practice" and by_id[v2]["context_id"] == "example"
    # each visit's whole log, as the server keeps it: the header, then every event in order
    lines = [json.loads(x) for x in z.read(by_id[v2]["file"]).decode().splitlines()]
    assert lines[0]["type"] == "header" and lines[0]["visit_id"] == v2 and lines[0]["annotator_id"] == "A01"
    assert [e["seq"] for e in lines[1:]] == list(range(1, len(lines)))
    assert lines[-1]["type"] == "log_closed" and int(by_id[v2]["n_events"]) == len(lines) - 1
    assert r["events"] == sum(int(x["n_events"]) for x in rows)
    assert by_id[v2]["file"].startswith("interaction_logs/annotator-A01/") and by_id[v2]["file"].endswith(
        "_practice.jsonl")
    assert "README.txt" in z.namelist() and "People: all" in z.read("README.txt").decode()

    # by person (in any case), by session, by recording, and together
    assert {x["visit_id"] for x in index(download(service, annotator_ids=["a02"])[1])} == {v3, v4}
    assert {x["visit_id"] for x in index(download(service, modes=["practice"])[1])} == {v2}
    assert {x["visit_id"] for x in index(download(service, recording_ids=[SUB2])[1])} == {v2, v3}
    assert {x["visit_id"] for x in index(download(service, annotator_ids=["A01", "A02"], modes=["standard"],
                                                  recording_ids=[SUB1])[1])} == {v1, v3}
    # a visit chosen for one recording keeps the events of the others
    one = download(service, annotator_ids=["A02"], recording_ids=[SUB2])[1]
    kept = [json.loads(x) for x in one.read(index(one)[0]["file"]).decode().splitlines()[1:]]
    assert {e.get("recording") for e in kept if e.get("type") == "recording_opened"} == {SUB1, SUB2}
    assert "Visits that opened: " + SUB2 in one.read("README.txt").decode()

    # by the day the visits began
    today = by_id[v1]["started_at"][:10]
    assert download(service, **{"from": today, "to": today})[0]["visits"] == 4
    assert refused(service, {"to": "2000-01-01"}).code == "no_logs"
    assert refused(service, {"annotator_ids": ["A02"], "modes": ["assessment"]}).code == "no_logs"


def test_the_download_is_audited_with_what_was_chosen(service: StudyService) -> None:
    visit(service, A01, [SUB1])
    download(service, annotator_ids=["A01"], **{"from": "2026-01-01"})
    entry = service.call("admin", ADMIN, {"op": "audit", "limit": 1})["entries"][0]
    assert entry["op"] == "logs_zip" and entry["by"] == "ADMIN"
    assert entry["summary"] == "Downloaded the interaction logs of 1 visit (zip)"
    assert entry["details"] == {"annotator_ids": ["A01"], "from": "2026-01-01", "visits": 1}


def test_what_logs_zip_refuses(service: StudyService, monkeypatch: pytest.MonkeyPatch) -> None:
    visit(service, A01, [SUB1])
    for body in ({"modes": ["dreaming"]}, {"annotator_ids": "A01"}, {"recording_ids": [3]}, {"from": "1 May"},
                 {"from": "2026-02-30"}, {"from": "2026-11-05", "to": "2026-11-01"}):
        assert refused(service, body).code == "bad_request", body
    assert refused(service, {}, A01).code == "forbidden"
    import electrotag.web.log_download as log_download

    monkeypatch.setattr(log_download, "MAX_ZIP_BYTES", 10)
    big = refused(service, {})
    assert big.status == 413 and big.code == "too_large" and "electrotag-web export" in str(big)
    # nothing was downloaded, so nothing was audited
    assert all(e["op"] != "logs_zip" for e in service.call("admin", ADMIN, {"op": "audit"})["entries"])
