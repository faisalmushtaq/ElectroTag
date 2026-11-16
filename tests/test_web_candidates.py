"""Experts looking through datasets for training recordings (electrotag/web/candidates.py; docs/api.md, "Looking for
training recordings"): who may look, the expert's own marks, notes and ratings (never exported or analysed), their
requests, the study team's decisions and the recordings awaiting annotation in a set; and training.required_types."""

from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path

import pytest

from electrotag.app.eeg.events import OriginalEvents
from electrotag.config.settings import DEFAULT_QUICK_LABELS, Settings, SettingsError, load_default_settings_dict
from electrotag.web import admin as admin_mod
from electrotag.web import candidates as cand
from electrotag.web.errors import ApiError
from electrotag.web.expert import EXPERT_OPS, is_read, load_operations
from electrotag.web.manifest import FINGERPRINT_ROLE, SCHEMA, SCHEMA_VERSION, events_to_dict
from electrotag.web.service import StudyService
from electrotag.web.store import RECORD_KINDS, User
from electrotag.web.store_files import FilesStore
from electrotag.web.study import WebStudy

ADMIN = User("ADMIN", "Study administrator", role="admin")
EXPERT = User("E01", "An expert", roles=("expert",))
OTHER = User("E02", "Another expert", roles=("expert",))
ANNOTATOR = User("A01", "An annotator", role="annotator")
SECRET_NOTE = "Okapi-private-note-about-this-file"


def _manifest(rid: str, dataset_id: str = "", n: int = 1) -> dict:
    """A small study manifest made by hand (no EEG file is needed to look through a dataset's register)."""
    ev = OriginalEvents(source="none", path=None, columns=[], rows=[])
    return {"schema": SCHEMA, "schema_version": SCHEMA_VERSION, "recording_id": rid, "scope": "study",
            "file_name": rid.rsplit("/", 1)[-1], "format": "EDF",
            "timing": {"sfreq": 250.0, "n_samples": 250 * 60}, "ch_names": ["Fp1", "Fp2", "Cz"],
            "hidden_channels": [], "channel_types": {}, "original_events": events_to_dict(ev),
            "fingerprint": {FINGERPRINT_ROLE: {"sha256": f"{n:064x}", "size": 1000 + n}},
            "registration": {"dataset_id": dataset_id, "registered_at": "2026-11-16T10:00:00+00:00",
                             "registered_by": "ADMIN", "retired": False}}


@pytest.fixture
def service(tmp_path: Path):
    folder = tmp_path / "study"
    WebStudy.init(folder, study_id="pilot", name="Pilot")
    store = FilesStore(folder)
    try:
        store.db.add_user("ADMIN", "password-1234", display_name="Study administrator", roles=["admin"])
        store.db.add_user("E01", "password-1234", display_name="An expert", roles=["expert"])
        store.db.add_user("E02", "password-1234", display_name="Another expert", roles=["expert"])
        store.db.add_user("A01", "password-1234", display_name="An annotator", roles=["annotator"])
    finally:
        store.close()
    store = FilesStore(folder)
    svc = StudyService(store)
    _admin(svc, "dataset_create", request_id=f"{1:032x}", dataset_id="youth", name="Youth low-density")
    for i, (rid, did) in enumerate([("youth/sub-001.edf", "youth"), ("youth/sub-002.edf", "youth"),
                                    ("youth/sub-003.edf", "youth"), ("other/sub-009.edf", "")], start=1):
        store.add_manifest(_manifest(rid, did, i))
    yield svc
    store.close()


def _admin(svc: StudyService, op: str, **body: object) -> dict:
    return svc.call("admin", ADMIN, {"op": op, **body})


def _expert(svc: StudyService, user: User, op: str, **body: object) -> dict:
    return svc.call("expert", user, {"op": op, **body})


def _refused(fn, code: str) -> ApiError:
    with pytest.raises(ApiError) as exc:
        fn()
    assert exc.value.code == code, (exc.value.code, exc.value.message)
    return exc.value


# ------------------------------------------------------------------ the interfaces
def test_the_operations_and_record_kinds_are_declared() -> None:
    for op in cand.READS:
        assert op in admin_mod.READ_ONLY and is_read(op), op
    for op in cand.WRITES:
        assert op in admin_mod.OPERATIONS and op not in admin_mod.READ_ONLY and not is_read(op), op
    for op in cand.READS + cand.WRITES:
        assert callable(getattr(admin_mod.Admin, f"op_{op}")), op
        assert op not in admin_mod.EXPERT_OPERATIONS, "the study team decides who looks and what is approved"
    load_operations()
    for op in ("browse_datasets_list", "browse_recordings_list", "browse_recording_get"):
        assert op in EXPERT_OPS and is_read(op)
    for op in ("browse_save", "training_request", "training_request_withdraw"):
        assert op in EXPERT_OPS and not is_read(op), "an operation that saves is never repeated by the browser"
    assert {cand.ACCESS, cand.NOTES, cand.REQUESTS} <= set(RECORD_KINDS)
    assert len(set(admin_mod.OPERATIONS)) == len(admin_mod.OPERATIONS)


def test_the_records_are_kept_out_of_the_exports_and_the_analyses() -> None:
    root = Path(cand.__file__).parent
    for name in ("export.py", "analyses.py", "recording_logs.py", "app.py"):
        text = (root / name).read_text(encoding="utf-8")
        for kind in (cand.NOTES, cand.REQUESTS, cand.ACCESS):
            assert kind not in text, f"{name} must not read {kind}"


# ------------------------------------------------------------------ who may look
def test_the_study_team_gives_an_expert_a_dataset_to_look_through_and_takes_it_back(service: StudyService) -> None:
    _refused(lambda: _expert(service, EXPERT, "browse_recordings_list", dataset_id="youth"), "no_access")
    assert _expert(service, EXPERT, "browse_datasets_list")["datasets"] == []
    out = _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E01", access=True)
    assert out["changed"] and [(g["dataset_id"], g["annotator_id"]) for g in out["grants"]] == [("youth", "E01")]
    assert {e["annotator_id"] for e in out["experts"]} == {"E01", "E02"}
    again = _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E01", access=True)
    assert not again["changed"], "the same choice again changes nothing"
    ds = _expert(service, EXPERT, "browse_datasets_list")["datasets"]
    assert [(d["dataset_id"], d["n_recordings"]) for d in ds] == [("youth", 3)]
    rows = _expert(service, EXPERT, "browse_recordings_list", dataset_id="youth")["recordings"]
    assert [r["recording_id"] for r in rows] == ["youth/sub-001.edf", "youth/sub-002.edf", "youth/sub-003.edf"]
    got = _expert(service, EXPERT, "browse_recording_get", recording_id="youth/sub-002.edf")
    assert got["manifest"]["fingerprint"]["hex"] == f"{2:064x}" and got["mine"]["annotations"] == []
    _refused(lambda: _expert(service, EXPERT, "browse_recording_get", recording_id="other/sub-009.edf"), "no_access")
    _refused(lambda: _expert(service, OTHER, "browse_recording_get", recording_id="youth/sub-002.edf"), "no_access")
    _refused(lambda: _expert(service, ANNOTATOR, "browse_datasets_list"), "forbidden")
    _refused(lambda: _admin(service, "browse_access_set", dataset_id="youth", annotator_id="A01", access=True),
             "not_expert")
    _refused(lambda: _admin(service, "browse_access_set", dataset_id="nothing", annotator_id="E01", access=True),
             "unknown_dataset")
    _refused(lambda: service.call("admin", EXPERT, {"op": "browse_access_set", "dataset_id": "youth",
                                                    "annotator_id": "E02", "access": True}), "forbidden")
    # Administrators look through every dataset without being given it.
    assert {d["dataset_id"] for d in _expert(service, ADMIN, "browse_datasets_list")["datasets"]} >= {"youth"}
    taken = _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E01", access=False)
    assert taken["changed"] and taken["grants"] == []
    _refused(lambda: _expert(service, EXPERT, "browse_recordings_list", dataset_id="youth"), "no_access")
    entries = [e for e in service.store.audit_page(None, 50)[0] if e["op"] == "browse_access_set"]
    assert len(entries) == 2, "each change is audited once"


# ------------------------------------------------------------------ the expert's own marks, notes and ratings
def test_an_experts_marks_notes_and_ratings_are_their_own(service: StudyService) -> None:
    _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E01", access=True)
    _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E02", access=True)
    rid = "youth/sub-001.edf"
    marks = [{"annotation_id": "okapi-mark-1", "label": "Eye-blink-artifact", "onset_sample": 100,
              "duration_samples": 50, "channels": ["Fp1"]},
             {"annotation_id": "okapi-mark-2", "label": "EMG-artifact", "onset_sample": 900, "duration_samples": 200,
              "channels": []}]
    out = _expert(service, EXPERT, "browse_save", recording_id=rid, note=f"  {SECRET_NOTE}  ", rating="maybe",
                  annotations=marks)
    assert out["changed"] and out["mine"]["note"] == SECRET_NOTE and out["mine"]["rating"] == "maybe"
    assert out["mine"]["labels"] == {"EMG-artifact": 1, "Eye-blink-artifact": 1}
    assert not _expert(service, EXPERT, "browse_save", recording_id=rid, rating="maybe")["changed"]
    assert _expert(service, EXPERT, "browse_save", recording_id=rid, rating="yes")["mine"]["note"] == SECRET_NOTE
    got = _expert(service, EXPERT, "browse_recording_get", recording_id=rid)["mine"]
    assert got["rating"] == "yes"
    assert [a["annotation_id"] for a in got["annotations"]] == ["okapi-mark-1", "okapi-mark-2"]
    assert _expert(service, OTHER, "browse_recording_get", recording_id=rid)["mine"]["annotations"] == [], \
        "another expert never sees them"
    row = next(r for r in _expert(service, EXPERT, "browse_recordings_list", dataset_id="youth")["recordings"]
               if r["recording_id"] == rid)
    assert row["rating"] == "yes" and row["has_note"] and row["n_annotations"] == 2
    assert _expert(service, EXPERT, "browse_datasets_list")["datasets"][0]["n_rated"] == 1
    _refused(lambda: _expert(service, EXPERT, "browse_save", recording_id=rid, rating="perhaps"), "bad_request")
    _refused(lambda: _expert(service, EXPERT, "browse_save", recording_id=rid), "bad_request")
    _refused(lambda: _expert(service, EXPERT, "browse_save", recording_id=rid,
                             annotations=[{"label": "EMG-artifact", "onset_sample": -1, "duration_samples": 3}]),
             "invalid_annotations")
    _refused(lambda: _expert(service, EXPERT, "browse_save", recording_id=rid, note="x" * (cand.MAX_NOTE + 1)),
             "bad_request")
    # Never anyone's draft or saved work, so nothing of it reaches the results or an analysis.
    assert service.store.completion_entries() == []
    assert not any(SECRET_NOTE in str(e) for e in service.store.audit_page(None, 100)[0])
    zipped = _admin(service, "results_zip")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(zipped["base64"]))) as z:
        for name in z.namelist():
            data = z.read(name)
            assert SECRET_NOTE.encode() not in data and b"okapi-mark" not in data, name


# ------------------------------------------------------------------ requests and decisions
def test_experts_ask_for_recordings_and_the_study_team_approves_them_into_a_set(service: StudyService) -> None:
    _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E01", access=True)
    _admin(service, "browse_access_set", dataset_id="youth", annotator_id="E02", access=True)
    _admin(service, "set_create", set_id="pilot", name="Pilot set")
    one, two, three = "youth/sub-001.edf", "youth/sub-002.edf", "youth/sub-003.edf"
    _expert(service, EXPERT, "browse_save", recording_id=one, rating="yes")
    out = _expert(service, EXPERT, "training_request", recording_ids=[one, two, one])
    assert out["requested"] == [one, two] and out["already"] == []
    assert [r["status"] for r in out["requests"]] == ["pending", "pending"] and out["requests"][0]["rating"] == "yes"
    again = _expert(service, EXPERT, "training_request", recording_ids=[one])
    assert again["requested"] == [] and again["already"] == [one]
    _expert(service, OTHER, "training_request", recording_ids=[one, three])
    _refused(lambda: _expert(service, EXPERT, "training_request", recording_ids=["other/sub-009.edf"]), "no_access")
    _refused(lambda: _expert(service, EXPERT, "training_request", recording_ids=[]), "bad_request")
    listed = _admin(service, "training_requests_list")
    assert listed["counts"]["pending"] == 4 and {s["set_id"] for s in listed["sets"]} == {"pilot"}
    by = {(r["annotator_id"], r["recording_id"]): r for r in listed["requests"]}
    assert by[("E01", one)]["rating_now"] == "yes" and "note" not in by[("E01", one)]
    # The expert takes one back; a withdrawn request cannot be decided.
    assert _expert(service, EXPERT, "training_request_withdraw", recording_id=two)["request"]["status"] == "withdrawn"
    _refused(lambda: _admin(service, "training_requests_decide", request_ids=[by[("E01", two)]["request_id"]],
                            decision="approve", set_id="pilot"), "withdrawn")
    _refused(lambda: _admin(service, "training_requests_decide", request_ids=[by[("E01", one)]["request_id"]],
                            decision="approve"), "bad_request")
    _refused(lambda: _admin(service, "training_requests_decide", request_ids=[by[("E01", one)]["request_id"]],
                            decision="approve", set_id="nothing"), "no_reference_set")
    ids = [by[("E01", one)]["request_id"], by[("E02", one)]["request_id"]]
    decided = _admin(service, "training_requests_decide", request_ids=ids, decision="approve", set_id="pilot")
    assert decided["decided"] == 2
    assert _admin(service, "training_requests_decide", request_ids=ids, decision="approve",
                  set_id="pilot")["decided"] == 0, "the same decision again changes nothing"
    _admin(service, "training_requests_decide", request_ids=[by[("E02", three)]["request_id"]], decision="decline",
           reason="Too short")
    waiting = _admin(service, "training_waiting_list", set_id="pilot")["waiting"]
    assert [(w["recording_id"], w["requested_by"], w["ratings"]) for w in waiting] == [(one, ["E01", "E02"],
                                                                                         {"E01": "yes"})]
    mine = {r["recording_id"]: r["request"] for r in
            _expert(service, EXPERT, "browse_recordings_list", dataset_id="youth")["recordings"]}
    assert mine[one]["status"] == "approved" and mine[one]["set_name"] == "Pilot set"
    _refused(lambda: _expert(service, EXPERT, "training_request_withdraw", recording_id=one), "decided")
    # A declined request may be asked for again.
    assert _expert(service, OTHER, "training_request", recording_ids=[three])["requested"] == [three]
    removed = _admin(service, "training_waiting_remove", set_id="pilot", recording_id=one)
    assert removed["removed"] and removed["waiting"] == []
    assert _expert(service, EXPERT, "training_request", recording_ids=[one])["requested"] == [one]
    ops = [e["op"] for e in service.store.audit_page(None, 100)[0]]
    for op in ("training_request", "training_request_withdraw", "training_requests_decide", "training_waiting_remove"):
        assert op in ops, op


# ------------------------------------------------------------------ the artifact types training should cover
def _settings(block: str, **values: object) -> Settings:
    d = load_default_settings_dict()
    d[block] = {**d[block], **values}
    return Settings.from_dict(d)


def test_the_artifact_types_that_need_training_material_default_to_the_number_keys() -> None:
    s = Settings.from_dict(load_default_settings_dict())
    assert s.training.required_types is None and s.training_required_types == DEFAULT_QUICK_LABELS
    assert _settings("training", required_types=["EMG-artifact"]).training_required_types == ("EMG-artifact",)
    keys = _settings("annotation", quick_labels=["Chewing-artifact"])
    assert keys.training_required_types == ("Chewing-artifact",), "unchosen, the list follows the number keys"
    assert _settings("training", required_types=[]).training_required_types == ()
    for bad in ("EMG-artifact", ["EMG-artifact", "EMG-artifact"], [3]):
        with pytest.raises(SettingsError):
            _settings("training", required_types=bad)


def test_the_study_team_chooses_the_artifact_types_in_study_settings(service: StudyService) -> None:
    got = _admin(service, "settings_get")["settings"]["training"]
    assert got["required_types"] is None
    many = ["Eye-blink-artifact", "Chewing-artifact", "Electrode-pops-artifact", "Sweat-artifact"]
    out = _admin(service, "settings_update", settings={"training": {"required_types": many}})
    assert out["settings"]["training"]["required_types"] == many
    assert service.settings.training_required_types == tuple(many)
    _refused(lambda: _admin(service, "settings_update", settings={"training": {"required_types": ["Banana"]}}),
             "invalid_settings")
    values = _admin(service, "preregistration_get")["items"][3]["values"]
    assert values["policy"]["required_types"] == many
