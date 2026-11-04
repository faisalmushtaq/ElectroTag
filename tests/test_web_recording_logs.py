"""The ElectroTag server keeps each saved version's own interaction log beside its result files
(electrotag/web/recording_logs.py, docs/file_formats.md "Interaction log of a saved version").

The whole visit's log stays in ``interaction_logs/``; the version's log is written once its segment has
ended, whichever reaches the study first (the save or the browser's ``recording_finished``), gathers the
segments of earlier visits whose work was carried over, goes into the results zip, and is not written when
the study keeps no interaction logs."""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, Api, ann, copy_demo, make_template, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
FOLDER = "annotator-A01/sub-001/eeg"
BASE = "sub-001_task-rest_eeg_annotator-A01"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-recording-logs"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def client(template: Path, tmp_path: Path):
    app = create_app(copy_demo(template, tmp_path), demo=True)
    with TestClient(app) as c:
        yield c
    app.state.store.close()


@pytest.fixture
def root(client: TestClient) -> Path:
    return client.app.state.store.layout.root


def open_visit(api: Api) -> str:
    return api.ok("post", "/visits", {"client": {"user_agent": "pytest"}})["visit_id"]


def send(api: Api, visit_id: str, events: list[dict[str, Any]]) -> None:
    api.ok("post", f"/visits/{visit_id}/events", {"events": events})


def opened(window: int, session_id: str, t: float = 1.0) -> list[dict[str, Any]]:
    ctx = {"recording": SUB1, "window_no": window}
    return [{"t": t, "type": "recording_opened", **ctx, "session_id": session_id, "mode": "standard"},
            {"t": t + 0.5, "type": "viewer_ready", **ctx},
            {"t": t + 1.0, "type": "view", **ctx, "t_start": 0.0, "duration": 10, "ch_start": 0, "n_channels": 22,
             "scale_factor": 1}]


def ended(window: int, session_id: str, t: float, kind: str = "recording_finished") -> list[dict[str, Any]]:
    return [{"t": t, "type": kind, "recording": SUB1, "window_no": window, "session_id": session_id}]


def save(api: Api, recordings: Path, session_id: str, revises: int | None = None) -> dict[str, Any]:
    body = submission(recordings, SUB1, [BLINK])
    body["session"]["session_id"] = session_id
    if revises:
        body["revises"] = revises
    return api.ok("post", "/submissions", body)


def read(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    head, *events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    return head, events


def test_the_version_log_is_written_beside_the_results_once_the_segment_ends(
        client: TestClient, recordings: Path, root: Path) -> None:
    a01 = Api(client, "A01")
    v = open_visit(a01)
    send(a01, v, [*opened(1, "1" * 32), {"t": 4.0, "type": "key", "key": "B"}])
    save(a01, recordings, "1" * 32)  # as the browser does it: the save, then recording_finished
    log = root / FOLDER / f"{BASE}_interaction_log.jsonl"
    assert (root / FOLDER / f"{BASE}_annotations.json").is_file()
    assert not log.exists(), "the segment has not ended yet"
    send(a01, v, ended(1, "1" * 32, 30.0))
    head, events = read(log)
    assert (head["schema"], head["attempt"], head["session_id"], head["output_basename"]) == (
        "electrotag.recording_log", 1, "1" * 32, BASE)
    assert [(s["visit_id"], s["window_no"], s["outcome"], s["open_s"]) for s in head["segments"]] == [
        (v, 1, "finished", 29.0)]
    assert head["visits"][v]["client"] == "web" and head["elapsed_s"] == 61.5
    assert [e["type"] for e in events] == ["recording_opened", "viewer_ready", "view", "recording_finished"]
    assert all(e["visit_id"] == v for e in events) and "key" not in [e["type"] for e in events]
    before = log.read_bytes()
    a01.ok("post", f"/visits/{v}/close", {"reason": "sign_out"})
    assert log.read_bytes() == before
    visit_logs = list((root / "interaction_logs" / "annotator-A01").glob("*.jsonl"))
    assert len(visit_logs) == 1, "the whole visit's log stays as it was"
    types = [json.loads(line).get("type") for line in visit_logs[0].read_text(encoding="utf-8").splitlines()]
    assert types[1] == "visit_started" and "key" in types and types[-1] == "log_closed"


def test_work_carried_over_from_an_earlier_visit_is_in_the_same_log(
        client: TestClient, recordings: Path, root: Path) -> None:
    a01 = Api(client, "A01")
    v1 = open_visit(a01)
    send(a01, v1, [*opened(1, "1" * 32), *ended(1, "1" * 32, 40.0, "closed_without_saving")])
    a01.ok("post", f"/visits/{v1}/close", {"reason": "sign_out"})
    v2 = open_visit(a01)
    send(a01, v2, [*opened(2, "2" * 32, 5.0), *ended(2, "2" * 32, 25.0)])  # the finish arrives first here
    save(a01, recordings, "2" * 32)
    head, events = read(root / FOLDER / f"{BASE}_interaction_log.jsonl")
    assert [(s["visit_id"], s["outcome"], s["open_s"]) for s in head["segments"]] == [
        (v1, "closed_without_saving", 39.0), (v2, "finished", 20.0)]
    assert head["open_s"] == 59.0 and sorted({e["visit_id"] for e in events}) == sorted([v1, v2])
    # a revision is a version of its own, with only what came after the first save
    v3 = open_visit(a01)
    send(a01, v3, opened(1, "3" * 32))
    save(a01, recordings, "3" * 32, revises=1)
    send(a01, v3, ended(1, "3" * 32, 12.0))
    head2, events2 = read(root / FOLDER / f"{BASE}_attempt-02_interaction_log.jsonl")
    assert head2["attempt"] == 2 and {e["visit_id"] for e in events2} == {v3}
    assert read(root / FOLDER / f"{BASE}_interaction_log.jsonl")[0] == head, "the first version's log is unchanged"


def test_the_results_zip_holds_the_version_logs(client: TestClient, recordings: Path) -> None:
    a01 = Api(client, "A01")
    v = open_visit(a01)
    send(a01, v, [*opened(1, "1" * 32), *ended(1, "1" * 32, 9.0)])
    save(a01, recordings, "1" * 32)
    z = Api(client, "ADMIN").admin_ok("results_zip", {})
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(z["base64"]))).namelist()
    assert f"Annotated_Events/{FOLDER}/{BASE}_interaction_log.jsonl" in names
    assert any(n.startswith("Annotated_Events/interaction_logs/annotator-A01/") for n in names)


def test_no_version_log_when_the_study_keeps_no_interaction_logs(
        client: TestClient, recordings: Path, root: Path) -> None:
    Api(client, "ADMIN").admin_ok("settings_update", {"settings": {"logging": {"interactions": False}}})
    a01 = Api(client, "A01")
    assert open_visit(a01) is None
    save(a01, recordings, "1" * 32)
    assert (root / FOLDER / f"{BASE}_annotations.json").is_file()
    assert not list((root / FOLDER).glob("*_interaction_log.jsonl"))
