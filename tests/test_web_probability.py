"""The probability maps of the admin area (electrotag/web/probability.py): the raters of a recording, their
answers as weights, the map of one recording for the browser and the maps of every recording as files."""

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

from electrotag.web.admin import OPERATIONS, READ_ONLY  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, ann, copy_demo, make_template, submission  # noqa: E402

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("probability-demo"))


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


def _answer(app: Any, aid: str, answers: dict[str, str]) -> None:
    app.state.store.update_record("questionnaires", aid, aid, lambda old: {
        "annotator_id": aid, "history": [{"at": "2026-01-01T09:00:00.000+00:00", "version": "v1", "answers": answers}],
        "definitions": {}})


def _two_raters(client: TestClient, recordings: Path) -> None:
    Api(client, "A01").ok("post", "/submissions", submission(recordings, SUB1, [{**BLINK, "confidence": 2}, EMG]))
    Api(client, "A02").ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))


def test_administrators_only_and_reads() -> None:
    assert {"probability_get", "probability_export"} <= set(OPERATIONS) & set(READ_ONLY)


def test_one_recording_for_the_browser(client: TestClient, admin: Api, recordings: Path, app: Any) -> None:
    _two_raters(client, recordings)
    _answer(app, "A01", {"eeg_years": "Less than 1"})
    out = admin.admin_ok("probability_get", {"recording_id": SUB1})
    assert [p["annotator_id"] for p in out["people"]] == ["A01", "A02"]
    assert {p["source"] for p in out["people"]} == {"study"}
    assert out["people"][0]["answers"] == {"eeg_years": "Less than 1"} and out["people"][1]["answers"] == {}
    assert len(out["people"][0]["marks"]) == 10 and out["people"][0]["marks"][4] in (0, 2)
    assert out["min_raters"] == 2 and out["n_samples"] > 0 and out["channels"]
    q = next(q for q in out["questions"] if q["id"] == "eeg_years")
    assert q["options"][0] == {"value": "Less than 1", "label": "Less than 1"}
    assert all(q["id"] != "eeg_systems" for q in out["questions"]), "single-choice questions only"
    Api(client, "A01").admin_error("probability_get", {"recording_id": SUB1}, 403, "forbidden")


def test_every_recording_as_files(client: TestClient, admin: Api, recordings: Path, app: Any) -> None:
    _two_raters(client, recordings)
    _answer(app, "A01", {"eeg_years": "Less than 1"})
    weights = {"confidence": [0.2, 0.4, 0.6, 0.8, 1.0], "questions": {"eeg_years": {"Less than 1": 0.5}}}
    out = admin.admin_ok("probability_export", {"weights": weights, "category": "each", "by_channel": True})
    assert out["recordings"] == 1 and SUB2 in out["left_out"] and out["low_sample"] == [SUB1]
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(out["base64"]))) as z:
        names = z.namelist()
        meta = json.loads(z.read("probability/probability.json"))
        tsv = next(n for n in names if n.endswith("_probability.tsv"))
        rows = [line.split("\t") for line in z.read(tsv).decode().splitlines()]
    assert "probability/README.txt" in names
    rec = meta["recordings"][tsv.split("/", 1)[1]]
    assert rec["low_sample"] is True and rec["categories"] == ["any", "EMG-artifact", "Eye-blink-artifact"]
    assert [(r["annotator_id"], r["weight"]) for r in rec["raters"]] == [("A01", 0.5), ("A02", 1.0)]
    assert meta["weights"]["questions"] == {"eeg_years": {"Less than 1": 0.5}}
    head = rows[0]
    assert head[:7] == ["category", "channel", "start_sample", "end_sample", "onset", "duration", "probability"]
    any_rows = [r for r in rows[1:] if r[0] == "any" and r[1] == "n/a"]
    assert any_rows[0][2] == "0" and int(any_rows[-1][3]) == rec["n_samples"], "the whole recording"
    blink = next(r for r in any_rows if r[2] == "500")
    # A01 at confidence 2 (40 %, rater weight 0.5) and A02 (full): 0.2 + 1 marked of 1.2
    assert float(blink[6]) == pytest.approx(1.2 / 1.2) and blink[8] == "2"
    emg = next(r for r in any_rows if r[2] == "3000")
    assert float(emg[6]) == pytest.approx(0.5 / 1.5), "A01's unrated EMG mark, A02 unmarked"
    assert any(r[1] == "Fp1" for r in rows[1:]) and any(r[0] == "Eye-blink-artifact" for r in rows[1:])
    admin.admin_error("probability_export", {"min_raters": 3}, 404, "no_maps")
    admin.admin_error("probability_export", {"min_raters": 1}, 400, "bad_request")
    admin.admin_error("probability_export", {"category": "Not-a-type"}, 400, "bad_request")
    admin.admin_error("probability_export", {"weights": {"confidence": [1, 1]}}, 400, "bad_request")


def test_experts_files_kept_with_a_reference_are_raters(client: TestClient, admin: Api, recordings: Path) -> None:
    _two_raters(client, recordings)
    admin.admin_ok("set_create", {"set_id": "pilot", "name": "Pilot"})
    admin.admin_ok("set_add_reference", {"set_id": "pilot", "recording_id": SUB1, "recording_scope": "study",
                                         "use": "assessment",
                                         "source": {"kind": "consensus", "annotator_ids": ["A01", "A02"]}})
    out = admin.admin_ok("probability_get", {"recording_id": SUB1, "set_id": "pilot"})
    assert [(p["annotator_id"], p["source"], p["set_id"]) for p in out["people"]] == [
        ("A01", "expert", "pilot"), ("A02", "expert", "pilot")]
    exported = admin.admin_ok("probability_export", {})
    assert exported["recordings"] == 2, "the study's recording and the set's own copy"
