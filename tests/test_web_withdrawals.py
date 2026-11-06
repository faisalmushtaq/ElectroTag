"""One person's saved work on one recording in the admin area (electrotag/web/withdrawals.py): its files to
download, withdrawing it from the results (with a warning when the results were downloaded since it was saved)
and putting it back."""

from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web.admin import OPERATIONS, READ_ONLY  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    PRACTICE1,
    SUB1,
    SUB2,
    Api,
    admin_audit,
    ann,
    copy_demo,
    make_template,
    match_body,
    skip_to_guided,
    submission,
)

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("withdraw-demo"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path):
    a = create_app(study, demo=True)
    yield a
    a.state.store.close()


@pytest.fixture
def client(app: Any) -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


def _saved_twice(client: TestClient, recordings: Path) -> Api:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    a01.ok("post", "/match", {**match_body(recordings, SUB1), "revise": True})
    a01.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 1})
    return a01


def _status(admin: Api, rid: str) -> str | None:
    items = admin.admin_ok("assignments_list", {"annotator_id": "A01"})["items"]
    return next((i["status"] for i in items if i["recording_id"] == rid), None)


def test_the_operations_are_offered_and_read_as_they_should() -> None:
    assert {"saved_work_get", "withdrawals_list", "saved_work_withdraw", "saved_work_restore"} <= set(OPERATIONS)
    assert {"saved_work_get", "withdrawals_list"} <= set(READ_ONLY)
    assert not {"saved_work_withdraw", "saved_work_restore"} & set(READ_ONLY)


def test_every_version_is_downloaded(client: TestClient, admin: Api, recordings: Path) -> None:
    _saved_twice(client, recordings)
    out = admin.admin_ok("saved_work_get", {"annotator_id": "a01", "recording_id": SUB1})
    assert [v["version"] for v in out["versions"]] == [1, 2] and out["file_name"].endswith("_A01_saved.zip")
    for v in out["versions"]:
        names = [f["name"] for f in v["files"]]
        assert any(n.endswith("_annotations.json") for n in names) and any(n.endswith("_events.tsv") for n in names)
    assert '"EMG-artifact"' in next(f["text"] for f in out["versions"][1]["files"]
                                    if f["name"].endswith("_annotations.json"))
    admin.admin_error("saved_work_get", {"annotator_id": "A01", "recording_id": SUB2}, 404, "not_saved")
    admin.admin_error("saved_work_get", {"recording_id": SUB1}, 400, "bad_request")


def test_withdrawn_work_leaves_the_results_and_comes_back(client: TestClient, admin: Api, recordings: Path,
                                                          app: Any, study: Path) -> None:
    a01 = _saved_twice(client, recordings)
    store = app.state.store
    assert _status(admin, SUB1) == "done"
    out = admin.admin_ok("saved_work_withdraw", {"annotator_id": "A01", "recording_id": SUB1, "then": "todo"})
    w = out["withdrawal"]
    assert [v["version"] for v in w["versions"]] == [1, 2] and w["then"] == "todo" and w["withdrawn_by"] == "ADMIN"
    assert w["downloaded_before"] is None
    # out of the register, the results folder, the lists and the export; given back to annotate
    assert not [e for e in store.completion_entries("A01") if e["recording_id"] == SUB1]
    assert not list((study / "Annotated_Events").rglob("*annotator-A01*_annotations.json"))
    assert len(list((study / "withdrawn").rglob("*_annotations.json"))) == 2
    assert _status(admin, SUB1) == "todo"
    admin.admin_error("saved_work_get", {"annotator_id": "A01", "recording_id": SUB1}, 404, "not_saved")
    zipped = admin.admin_ok("results_zip")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(zipped["base64"]))) as z:
        assert not [n for n in z.namelist() if "annotator-A01" in n and n.endswith("_annotations.json")]
    listed = admin.admin_ok("withdrawals_list", {"annotator_id": "A01"})["withdrawals"]
    assert [x["withdrawal_id"] for x in listed] == [w["withdrawal_id"]]
    entry = admin_audit(admin, 5)
    assert any(e["op"] == "saved_work_withdraw" and SUB1 in e["summary"] and "given back" in e["summary"]
               for e in entry)
    # restored as it was
    back = admin.admin_ok("saved_work_restore", {"withdrawal_id": w["withdrawal_id"]})["withdrawal"]
    assert back["withdrawal_id"] == w["withdrawal_id"] and _status(admin, SUB1) == "done"
    assert len([e for e in store.completion_entries("A01") if e["recording_id"] == SUB1]) == 2
    assert [v["version"] for v in admin.admin_ok("saved_work_get", {"annotator_id": "A01",
                                                                    "recording_id": SUB1})["versions"]] == [1, 2]
    assert admin.admin_ok("withdrawals_list")["withdrawals"] == []
    admin.admin_error("saved_work_restore", {"withdrawal_id": w["withdrawal_id"]}, 404, "no_withdrawal")
    assert admin_audit(admin, 1)[0]["op"] == "saved_work_restore"
    assert a01.ok("get", "/me")  # the person's own account is untouched


def test_taken_off_the_list_and_put_back(client: TestClient, admin: Api, recordings: Path) -> None:
    _saved_twice(client, recordings)
    w = admin.admin_ok("saved_work_withdraw", {"annotator_id": "A01", "recording_id": SUB1,
                                               "then": "unassign"})["withdrawal"]
    assert _status(admin, SUB1) is None
    admin.admin_ok("saved_work_restore", {"withdrawal_id": w["withdrawal_id"]})
    assert _status(admin, SUB1) == "done", "restoring puts the recording back on their list, as done"


def test_work_saved_again_keeps_the_withdrawn_work_aside(client: TestClient, admin: Api, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    w = admin.admin_ok("saved_work_withdraw", {"annotator_id": "A01", "recording_id": SUB1,
                                               "then": "todo"})["withdrawal"]
    a01.ok("post", "/submissions", submission(recordings, SUB1, [EMG]))  # annotated again, from the beginning
    admin.admin_error("saved_work_restore", {"withdrawal_id": w["withdrawal_id"]}, 409, "saved_again")


def test_downloaded_results_are_pointed_out_first(client: TestClient, admin: Api, recordings: Path) -> None:
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    admin.admin_ok("results_zip")
    assert admin_audit(admin, 1)[0]["op"] == "results_zip"
    body = {"annotator_id": "A01", "recording_id": SUB1, "then": "todo"}
    err = admin.admin_error("saved_work_withdraw", body, 409, "downloaded")
    assert err["downloaded_by"] == "ADMIN" and err["downloaded_at"] and "outside the study" in err["message"]
    assert _status(admin, SUB1) == "done", "nothing was withdrawn"
    w = admin.admin_ok("saved_work_withdraw", {**body, "downloaded_ok": True})["withdrawal"]
    assert w["downloaded_before"] == err["downloaded_at"]
    assert "had been downloaded" in admin_audit(admin, 1)[0]["summary"]


def test_a_download_before_the_work_was_saved_is_not_a_copy_of_it(client: TestClient, admin: Api,
                                                                   recordings: Path) -> None:
    admin.admin_ok("results_zip")
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    admin.admin_ok("saved_work_withdraw", {"annotator_id": "A01", "recording_id": SUB1, "then": "todo"})


def test_what_stays(client: TestClient, admin: Api, recordings: Path, app: Any) -> None:
    store = app.state.store
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    body = {"annotator_id": "A01", "recording_id": SUB1, "then": "todo"}
    admin.admin_error("saved_work_withdraw", {**body, "then": "later"}, 400, "bad_request")
    admin.admin_error("saved_work_withdraw", {**body, "recording_id": SUB2}, 404, "not_saved")
    # a correction made from it
    store.update_record("corrections", "c" * 32, "A01", lambda old: {
        "correction_id": "c" * 32, "annotator_id": "A01", "recording_id": SUB1, "mode": "standard",
        "context_id": "", "state": "saved"})
    err = admin.admin_error("saved_work_withdraw", body, 409, "has_derived")
    assert "correction" in err["message"]
    # an adjudication that compared it
    store.update_record("corrections", "c" * 32, "A01", lambda old: {**old, "recording_id": SUB2})
    store.update_record("adjudications", "u" * 32, "", lambda old: {
        "unit_id": "u" * 32, "recording_id": SUB1, "inputs": {"A01": {}, "A02": {}}, "state": "in_progress"})
    assert "adjudication" in admin.admin_error("saved_work_withdraw", body, 409, "has_derived")["message"]
    assert _status(admin, SUB1) == "done"


def test_training_work_stays(client: TestClient, admin: Api, recordings: Path) -> None:
    t01 = Api(client, "T01")
    skip_to_guided(t01)
    admin.admin_error("saved_work_withdraw", {"annotator_id": "T01", "recording_id": PRACTICE1, "mode": "practice",
                                              "context_id": "example", "then": "todo"}, 400, "not_study_work")
