"""The artifact types a study hides from annotators (annotation.hidden_labels; docs/admin_area.md, "Study settings").

The setting is checked against the catalogue when saved, given to annotators with the study's other annotation
settings, and kept apart from the number keys; the browser leaves the hidden types out of its lists
(web_tests/unit/ui_hidden_types.test.mjs).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from electrotag.config.settings import Settings, SettingsError, load_default_settings_dict
from electrotag.web.errors import ApiError
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore
from electrotag.web.study import WebStudy

ADMIN = User("ADMIN", "Study administrator", role="admin")
KEYS = ["Horizontal-eye-movement-artifact", "EMG-artifact"]


def _with(annotation: dict) -> Settings:
    data = load_default_settings_dict()
    return Settings.from_dict({**data, "annotation": {**data["annotation"], **annotation}})


def test_nothing_is_hidden_by_default_and_the_setting_is_checked() -> None:
    assert _with({}).hidden_labels == ()
    assert _with({"hidden_labels": ["Chewing-artifact"], "quick_labels": KEYS}).hidden_labels == ("Chewing-artifact",)
    for value, words in [("Chewing-artifact", "must be a list of artifact type names"),
                         (["Chewing-artifact", "Chewing-artifact"], "must not name an artifact type twice"),
                         (["Data-artifact"], "cannot hide Data-artifact"),
                         (["EMG-artifact"], "hides EMG-artifact, which is on a number key")]:
        with pytest.raises(SettingsError) as exc:
            _with({"hidden_labels": value, "quick_labels": KEYS})
        assert words in str(exc.value)


@pytest.fixture
def study(tmp_path: Path):
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


def _save(service: StudyService, **annotation: object) -> dict:
    return service.call("admin", ADMIN, {"op": "settings_update", "settings": {"annotation": annotation}})


def test_hidden_types_are_saved_audited_and_given_to_annotators(study: StudyService) -> None:
    assert study.study_info()["annotation"]["hidden_labels"] == []
    _save(study, quick_labels=KEYS, hidden_labels=["Chewing-artifact", "Eye-blink-artifact"])
    info = study.study_info()["annotation"]
    assert info["hidden_labels"] == ["Chewing-artifact", "Eye-blink-artifact"]
    assert info["quick_labels"] == KEYS
    entry = study.call("admin", ADMIN, {"op": "audit", "limit": 1})["entries"][0]
    assert entry["op"] == "settings_update" and "hidden labels (annotation)" in entry["summary"]
    assert "Chewing-artifact, Eye-blink-artifact" in entry["summary"]
    _save(study, hidden_labels=[])
    assert study.study_info()["annotation"]["hidden_labels"] == []


@pytest.mark.parametrize("hidden, words", [
    (["Not-an-artifact"], "'Not-an-artifact' is not an artifact type of the catalogue"),
    (["Data-artifact"], "cannot hide Data-artifact"),
    (["EMG-artifact"], "hides EMG-artifact, which is on a number key"),
])
def test_a_save_that_cannot_be_used_is_refused_in_plain_words(study: StudyService, hidden: list, words: str) -> None:
    with pytest.raises(ApiError) as exc:
        _save(study, quick_labels=KEYS, hidden_labels=hidden)
    assert exc.value.status == 400 and exc.value.code == "invalid_settings"
    assert words in exc.value.message
    assert study.study_info()["annotation"]["hidden_labels"] == []


def test_at_least_one_specific_type_stays_available(study: StudyService) -> None:
    cat = study.store.catalogue
    every = [x for x in cat.specific_labels if x != "Data-artifact"]
    with pytest.raises(ApiError) as exc:
        _save(study, quick_labels=[], hidden_labels=every)
    assert "keep at least one available to annotators" in exc.value.message
    _save(study, quick_labels=[], hidden_labels=every[1:])
    assert study.study_info()["annotation"]["hidden_labels"] == every[1:]
