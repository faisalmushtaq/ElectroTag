"""Before the study starts (electrotag/web/preregistration.py): the settings a study chooses and confirms before its
first study recording is saved, the confirmations with their values, and what the analyses and the results zip say.

docs/admin_area.md, "Before the study starts"; docs/api.md, "Before the study starts".
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path

import pytest

from electrotag.config.settings import PREREGISTERED_AGREEMENT_KEYS, Settings, SettingsError, load_default_settings_dict
from electrotag.web.errors import ApiError
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore
from electrotag.web.study import WebStudy

ADMIN = User("ADMIN", "Study administrator", role="admin")


def _admin(service: StudyService, op: str, **body: object) -> dict:
    return service.call("admin", ADMIN, {"op": op, **body})


def _states(status: dict) -> list[tuple[str, str]]:
    return [(i["item"], i["state"]) for i in status["items"]]


# --------------------------------------------------------------------------------------- the setting
def _with(block: dict) -> Settings:
    return Settings.from_dict({**load_default_settings_dict(), "preregistration": block})


def test_the_block_is_empty_by_default_and_saved_agreement_settings_take_the_analysis_defaults() -> None:
    pr = Settings.from_dict(load_default_settings_dict()).preregistration
    assert (pr.agreement, pr.working_time) == (None, "active_s")
    pr = _with({"agreement": {"resolutions_s": [0.5, 1]}, "working_time": "wall_s"}).preregistration
    assert pr.working_time == "wall_s"
    assert list(pr.agreement) == list(PREREGISTERED_AGREEMENT_KEYS)
    assert pr.agreement["resolutions_s"] == [0.5, 1] and pr.agreement["match_criterion"] == "iou"
    assert pr.agreement["categories"] is None, "every category"


@pytest.mark.parametrize("block, words", [
    ({"working_time": "hours"}, "preregistration.working_time must be active_s"),
    ({"agreement": []}, "preregistration.agreement must be a block of agreement settings"),
    ({"agreement": {"modes": ["standard"]}}, "preregistration.agreement has no setting 'modes'"),
    ({"agreement": {"comparison": "within"}}, "has no setting 'comparison'"),
    ({"agreement": {"min_bin_coverage": 2}}, "min_bin_coverage must be between 0 and 1"),
    ({"agreement": {"match_criterion": "nearest"}}, "match_criterion must be one of"),
])
def test_the_block_is_checked_in_plain_words(block: dict, words: str) -> None:
    with pytest.raises(SettingsError) as exc:
        _with(block)
    assert words in str(exc.value)


# ------------------------------------------------------------------------------------- an empty study
@pytest.fixture
def empty(tmp_path: Path):
    """A study with an administrator and nothing saved yet (no recordings are needed for these settings)."""
    folder = tmp_path / "study"
    WebStudy.init(folder, study_id="pilot", name="Pilot")
    store = FilesStore(folder)
    try:
        store.db.add_user("ADMIN", "password-1234", display_name="Study administrator", roles=["admin"])
    finally:
        store.close()
    store = FilesStore(folder)
    yield StudyService(store)
    store.close()


def test_each_group_is_confirmed_with_its_values_and_shown_as_changed_when_they_change(empty: StudyService) -> None:
    st = _admin(empty, "preregistration_get")
    assert _states(st) == [("agreement", "not_confirmed"), ("working_time", "not_confirmed"),
                           ("repeats", "not_confirmed"), ("training", "not_confirmed")]
    assert [i["ready"] for i in st["items"]] == [False, True, True, True], "the agreement settings are saved first"
    assert (st["done"], st["study_started_at"]) == (False, None)
    assert st["items"][1]["values"] == {"measure": "active_s", "idle_after_s": 30.0}
    assert st["items"][2]["values"] == {"enabled": False, "rules": []}

    with pytest.raises(ApiError) as exc:
        _admin(empty, "preregistration_confirm", item="agreement")
    assert (exc.value.status, exc.value.code) == (409, "not_saved")
    assert "save them as the study's" in exc.value.message
    with pytest.raises(ApiError) as exc:
        _admin(empty, "preregistration_confirm", item="everything")
    assert (exc.value.status, exc.value.code) == (400, "bad_request")

    _admin(empty, "settings_update", settings={"preregistration": {"agreement": {"resolutions_s": [0.5, 1]}}})
    for item in ("agreement", "working_time", "repeats", "training"):
        st = _admin(empty, "preregistration_confirm", item=item)
    assert st["done"] is True
    assert {(i["confirmed_by"], i["before_start"]) for i in st["items"]} == {("ADMIN", True)}
    assert st["items"][0]["confirmed_values"]["resolutions_s"] == [0.5, 1]
    log = _admin(empty, "audit", limit=5)["entries"]
    assert [(e["op"], e["summary"]) for e in log[:4]] == [
        ("preregistration_confirm", "Confirmed the training standards (no training sets: the study uses no training)"),
        ("preregistration_confirm", "Confirmed the repeat ratings"),
        ("preregistration_confirm", "Confirmed the measure of working time"),
        ("preregistration_confirm", "Confirmed the agreement settings")]
    assert log[4]["summary"] == "Changed agreement (preregistration) from nothing to resolutions_s 0.5, 1"
    n = len(_admin(empty, "audit", limit=50)["entries"])
    _admin(empty, "preregistration_confirm", item="repeats")
    assert len(_admin(empty, "audit", limit=50)["entries"]) == n, "the same values again: no new entry"

    # The idle threshold belongs to working time, and a rule to the repeat ratings: each asks to be confirmed again.
    _admin(empty, "settings_update", settings={"logging": {"idle_after_s": 60},
                                               "repeats": {"enabled": True, "rules": [{"id": "all", "repeats": 1}]}})
    st = _admin(empty, "preregistration_get")
    assert _states(st) == [("agreement", "confirmed"), ("working_time", "changed"), ("repeats", "changed"),
                           ("training", "confirmed")]
    assert st["items"][1]["confirmed_values"]["idle_after_s"] == 30.0
    assert st["items"][1]["values"]["idle_after_s"] == 60.0
    st = _admin(empty, "preregistration_confirm", item="working_time")
    assert st["items"][1]["state"] == "confirmed"
    rec = next(r for r in empty.store.records("preregistration") if r["item"] == "working_time")
    assert rec["times_confirmed"] == 2

    # Changed back, the agreement settings are as confirmed again.
    _admin(empty, "settings_update", settings={"preregistration": {"agreement": {"resolutions_s": [1]}}})
    assert _admin(empty, "preregistration_get")["items"][0]["state"] == "changed"
    _admin(empty, "settings_update", settings={"preregistration": {"agreement": {"resolutions_s": [0.5, 1]}}})
    assert _admin(empty, "preregistration_get")["items"][0]["state"] == "confirmed"


def test_training_standards_cover_every_set_and_the_policy_or_confirm_that_there_is_no_training(
        empty: StudyService) -> None:
    st = _admin(empty, "preregistration_confirm", item="training")
    training = st["items"][3]
    assert training["values"] == {"policy": {"skippable": ["tour", "snippets", "guided", "practice"], "gate": "met",
                                             "tour": True, "snippets_quiz_required": False}, "sets": []}
    assert training["state"] == "confirmed", "no training, confirmed as such"

    # A new set is new training: its standards are to confirm.
    _admin(empty, "set_create", set_id="pilot", name="Pilot set")
    training = _admin(empty, "preregistration_get")["items"][3]
    assert training["state"] == "changed"
    assert training["values"]["sets"] == [{
        "set_id": "pilot", "name": "Pilot set", "assessment_recordings": 0,
        "practice_pass": {"event_f1": 0.8, "label_accuracy": 0.8},
        "assessment_matching": {"match_criterion": "iou", "iou_threshold": 0.2, "onset_tolerance_s": 0.5,
                                "offset_tolerance_s": 0.5},
        "criteria": {"criteria": [], "min_reference_events": 3, "categories": None}}]
    assert training["values"]["sets"][0]["criteria"] == _admin(empty, "sets_list")["sets"][0]["criteria"], \
        "as Training shows them"
    _admin(empty, "preregistration_confirm", item="training")
    assert _admin(empty, "audit", limit=1)["entries"][0]["summary"] == "Confirmed the training standards"

    # The set's criteria and pass mark, and the study's training policy, each ask for it again.
    _admin(empty, "set_update", set_id="pilot", criteria={"criteria": [{"metric": "event_f1", "threshold": 0.7}],
                                                          "min_reference_events": 3, "categories": None})
    assert _admin(empty, "preregistration_get")["items"][3]["state"] == "changed"
    _admin(empty, "preregistration_confirm", item="training")
    _admin(empty, "set_update", set_id="pilot", practice_pass={"event_f1": 0.9})
    assert _admin(empty, "preregistration_get")["items"][3]["state"] == "changed"
    _admin(empty, "preregistration_confirm", item="training")
    _admin(empty, "settings_update", settings={"training": {"gate": "completed"}})
    training = _admin(empty, "preregistration_get")["items"][3]
    assert training["state"] == "changed" and training["values"]["policy"]["gate"] == "completed"
    assert training["confirmed_values"]["sets"][0]["practice_pass"] == {"event_f1": 0.9, "label_accuracy": 0.8}


def test_only_administrators_confirm(empty: StudyService) -> None:
    with pytest.raises(ApiError) as exc:
        empty.call("admin", User("A01", "", role="annotator"), {"op": "preregistration_confirm", "item": "repeats"})
    assert exc.value.status == 403


def test_a_confirmation_after_the_first_study_recording_says_so(empty: StudyService,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    _admin(empty, "preregistration_confirm", item="repeats")
    rows = [{"status": "completed", "mode": "practice", "completed_at": "2020-01-01T09:00:00.000+00:00"},
            {"status": "completed", "mode": "standard", "completed_at": "2020-01-03T09:00:00.000+00:00"},
            {"status": "completed", "completed_at": "2020-01-02T09:00:00.000+01:00"}]
    monkeypatch.setattr(empty.store, "completion_entries", lambda *a, **k: rows)
    st = _admin(empty, "preregistration_get")
    assert st["study_started_at"] == "2020-01-02T09:00:00.000+01:00", "training does not start a study"
    assert st["items"][2]["before_start"] is False, "confirmed after the first study recording was saved"
    _admin(empty, "settings_update", settings={"preregistration": {"working_time": "wall_s"}})
    st = _admin(empty, "preregistration_confirm", item="working_time")
    assert st["items"][1]["before_start"] is False
    entry = _admin(empty, "audit", limit=1)["entries"][0]
    assert entry["summary"] == "Confirmed the measure of working time after the study started"
    assert entry["details"]["values"] == {"measure": "wall_s", "idle_after_s": 30.0}


def test_the_agreement_check_names_the_settings_that_differ(empty: StudyService) -> None:
    from electrotag.reliability.config import AnalysisConfig
    from electrotag.web.preregistration import agreement_check

    assert agreement_check(empty.store.settings, AnalysisConfig()) == {"state": "not_saved", "differs": []}
    _admin(empty, "settings_update", settings={"preregistration": {"agreement": {"resolutions_s": [0.5]}}})
    s = empty.store.settings
    assert agreement_check(s, AnalysisConfig(resolutions_s=(0.5,))) == {"state": "matches", "differs": []}
    # who is compared, the versions and the report's layout are chosen for each analysis
    assert agreement_check(s, AnalysisConfig(resolutions_s=(0.5,), comparison="within",
                                             timeline_max_recordings=3))["state"] == "matches"
    assert agreement_check(s, AnalysisConfig(match_criterion="tolerance")) == {
        "state": "differs", "differs": ["resolutions_s", "match_criterion"]}


def test_the_results_zip_files(empty: StudyService) -> None:
    from electrotag.web.preregistration import preregistration_files

    files = preregistration_files(empty.store)
    assert list(files) == ["study/preregistration.json"], "no agreement settings saved yet"
    _admin(empty, "settings_update", settings={"preregistration": {"agreement": {"allow_many_to_one": True}}})
    _admin(empty, "preregistration_confirm", item="agreement")
    files = preregistration_files(empty.store)
    status = json.loads(files["study/preregistration.json"])
    assert status["items"][0]["state"] == "confirmed" and status["items"][0]["confirmed_by"] == "ADMIN"
    cfg = json.loads(files["study/agreement_settings_preregistered.json"])["config"]
    assert cfg["allow_many_to_one"] is True and cfg["modes"] == ["standard"]
    from electrotag.reliability.config import AnalysisConfig

    AnalysisConfig.from_dict(cfg)  # what electrotag-agreement --config reads


# ------------------------------------------------------------------------------- with saved annotations
@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    from tests.web_helpers import make_template

    return make_template(tmp_path_factory.mktemp("web-preregistration"))


@pytest.fixture
def study(template: Path, tmp_path: Path):
    from tests.web_helpers import copy_demo

    store = FilesStore(copy_demo(template, tmp_path))
    yield StudyService(store), template / "recordings"
    store.close()


def test_the_agreement_analysis_says_whether_it_used_the_pre_registered_settings(study) -> None:
    from tests.web_helpers import SUB1, ann, submission

    service, recordings = study
    blink = ann("b" * 32, "Eye-blink-artifact", 500, 100, [])
    for aid in ("A01", "A02"):
        service.call("submit", User(aid), submission(recordings, SUB1, [blink]))
    st = _admin(service, "preregistration_get")
    assert st["study_started_at"] is not None, "the first study recording was saved"

    none = _admin(service, "agreement", config={"resolutions_s": [1.0]})
    assert none["summary"]["preregistration"] == {"state": "not_saved", "differs": []}
    _admin(service, "settings_update", settings={"preregistration": {"agreement": {"resolutions_s": [1.0]}}})
    same = _admin(service, "agreement", config={"resolutions_s": [1.0], "timeline_max_recordings": 2})
    assert same["summary"]["preregistration"] == {"state": "matches", "differs": []}
    assert not any("pre-registered" in w for w in same["warnings"])
    other = _admin(service, "agreement", config={"resolutions_s": [0.5], "allow_many_to_one": True})
    assert other["summary"]["preregistration"] == {"state": "differs",
                                                   "differs": ["resolutions_s", "allow_many_to_one"]}
    assert any("differ from the study's pre-registered agreement settings (resolutions_s, allow_many_to_one)" in w
               and "exploratory" in w for w in other["warnings"])

    st = _admin(service, "preregistration_confirm", item="agreement")
    assert st["items"][0]["before_start"] is False
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(_admin(service, "results_zip")["base64"])))
    names = z.namelist()
    assert "study/preregistration.json" in names and "study/agreement_settings_preregistered.json" in names
    assert "study/preregistration.json" in z.read("README.txt").decode()
