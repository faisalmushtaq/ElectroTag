"""The topographic map's study settings and the electrode positions chosen when a recording is added
(docs/using.md, "The topographic map"; docs/admin_area.md, "Adding recordings from this computer")."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from electrotag.config.settings import Settings, SettingsError

SUFFIXES = ("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")


def _defaults() -> dict[str, Any]:
    return json.loads((Path(__file__).parents[1] / "electrotag" / "config" / "default_settings.json").read_text())


def test_the_map_is_on_by_default_with_the_viewers_signal() -> None:
    d = Settings.from_dict(_defaults()).display
    assert (d.topomap, d.topomap_filters, d.topomap_reference) == (True, "as_shown", "as_recorded")
    data = _defaults()
    for key in ("topomap", "topomap_filters", "topomap_reference"):
        del data["display"][key]
    d = Settings.from_dict(data).display  # a study's settings written before the map
    assert (d.topomap, d.topomap_filters, d.topomap_reference) == (True, "as_shown", "as_recorded")
    data = _defaults()
    data["display"].update(topomap=False, topomap_filters="none", topomap_reference="average")
    d = Settings.from_dict(data).display
    assert (d.topomap, d.topomap_filters, d.topomap_reference) == (False, "none", "average")


@pytest.mark.parametrize("key, value, words", [
    ("topomap", "yes", "display.topomap must be true or false"),
    ("topomap_filters", "raw", "display.topomap_filters must be one of as_shown, none"),
    ("topomap_reference", "Cz", "display.topomap_reference must be one of as_recorded, average"),
])
def test_unusable_map_settings_are_refused(key: str, value: Any, words: str) -> None:
    data = _defaults()
    data["display"][key] = value
    with pytest.raises(SettingsError, match=words):
        Settings.from_dict(data)


# ------------------------------------------------------------------ positions in the manifest (MNE-Python)
@pytest.fixture(scope="module")
def manifest(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    pytest.importorskip("mne")
    import numpy as np

    from electrotag.synthetic import write_edf
    from tests.web_helpers import build_manifests

    root = tmp_path_factory.mktemp("topo-data")
    folder = root / "sub-009" / "eeg"
    folder.mkdir(parents=True)
    rng = np.random.default_rng(9)
    write_edf(folder / "sub-009_task-rest_eeg.edf", rng.normal(0, 2e-5, (5, 2560)), 256.0,
              ["Fp1", "Fp2", "Cz", "Oz", "EOG1"])
    m = build_manifests(root)[0]
    m["channel_types"]["EOG1"] = "eog"
    return m


def test_the_positions_chosen_are_kept_checked_and_shown(manifest: dict[str, Any]) -> None:
    from electrotag.web.manifest import positions_source, public_manifest
    from electrotag.web.manifest_check import check_manifest

    assert positions_source(manifest) == "unset"
    assert "electrode_positions" not in check_manifest(copy.deepcopy(manifest), scope="study", suffixes=SUFFIXES)
    assert "electrode_positions" not in public_manifest(manifest)
    m = copy.deepcopy(manifest)
    m["electrode_positions"] = {"source": "file", "points": {"Oz": [0, -1.0], "Cz": [0.0, 0.0], "Fp1": [-0.3, 0.95]}}
    out = check_manifest(m, scope="study", suffixes=SUFFIXES)
    assert out["electrode_positions"] == {"source": "file", "points": {"Fp1": [-0.3, 0.95], "Cz": [0.0, 0.0],
                                                                       "Oz": [0.0, -1.0]}}
    assert positions_source(out) == "file"
    assert public_manifest(out)["electrode_positions"] == out["electrode_positions"]
    for source in ("standard", "none"):
        m["electrode_positions"] = {"source": source}
        out = check_manifest(m, scope="study", suffixes=SUFFIXES)
        assert out["electrode_positions"] == {"source": source}
        assert public_manifest(out)["electrode_positions"] == {"source": source}


@pytest.mark.parametrize("value, words", [
    ({"source": "maybe"}, "electrode_positions must give a source"),
    ("standard", "electrode_positions must give a source"),
    ({"source": "standard", "points": {"Cz": [0, 0]}}, "points only for the source file"),
    ({"source": "none", "file": "sub-009_electrodes.tsv"}, "holds only source and points"),
    ({"source": "file"}, "at least one channel"),
    ({"source": "file", "points": {"T9": [1, 0]}}, "'T9' is not a channel shown"),
    ({"source": "file", "points": {"EOG1": [1, 0]}}, "'EOG1' is not an EEG channel"),
    ({"source": "file", "points": {"Cz": [0, 9]}}, "two numbers from -3 to 3"),
    ({"source": "file", "points": {"Cz": [0]}}, "two numbers from -3 to 3"),
    ({"source": "file", "points": {"Cz": [True, 0]}}, "two numbers from -3 to 3"),
])
def test_unusable_positions_are_refused(manifest: dict[str, Any], value: Any, words: str) -> None:
    from electrotag.web.manifest_check import ManifestProblem, check_manifest

    m = copy.deepcopy(manifest)
    m["electrode_positions"] = value
    with pytest.raises(ManifestProblem, match=words):
        check_manifest(m, scope="study", suffixes=SUFFIXES)


# ------------------------------------------------------------------ the study server
def test_the_study_sends_the_map_settings_and_keeps_the_positions(tmp_path: Path, manifest: dict[str, Any]) -> None:
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app
    from tests.web_helpers import Api, copy_demo, make_template

    study = copy_demo(make_template(tmp_path / "template"), tmp_path / "study")
    app = create_app(study, demo=True)
    try:
        client = TestClient(app)
        admin = Api(client, "ADMIN")
        display = Api(client, "A01").ok("get", "/me")["study"]["display"]
        assert (display["topomap"], display["topomap_filters"], display["topomap_reference"]) == (
            True, "as_shown", "as_recorded")
        admin.admin_ok("settings_update", {"settings": {"display": {"topomap_reference": "average"}}})
        assert Api(client, "A01").ok("get", "/me")["study"]["display"]["topomap_reference"] == "average"
        # added with the positions of an electrodes.tsv
        m = copy.deepcopy(manifest)
        m["electrode_positions"] = {"source": "file", "points": {"Cz": [0.0, 0.0], "Oz": [0.0, -1.0]}}
        r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": [m]})
        assert r["added"] == [m["recording_id"]]
        rec = {x["recording_id"]: x for x in admin.admin_ok("recordings_list", {"scope": "study"})["recordings"]}
        assert rec[m["recording_id"]]["electrode_positions"] == "file"
        assert all(x["electrode_positions"] == "unset" for k, x in rec.items() if k != m["recording_id"])
        # the annotator's browser is given them with the recording
        admin.admin_ok("assign", {"annotator_ids": ["A01"], "recording_ids": [m["recording_id"]]})
        fp = m["fingerprint"]["eeg"]
        got = Api(client, "A01").ok("post", "/match", {"file_name": m["file_name"], "size_bytes": fp["size"],
                                                      "sha256": fp["sha256"]})
        assert got["manifest"]["electrode_positions"] == {"source": "file", "points": {"Cz": [0.0, 0.0],
                                                                                         "Oz": [0.0, -1.0]}}
        # added again without positions (Replace): the map goes
        m["electrode_positions"] = {"source": "none"}
        admin.admin_ok("recordings_register", {"scope": "study", "manifests": [m], "replace": True})
        rec = {x["recording_id"]: x for x in admin.admin_ok("recordings_list", {"scope": "study"})["recordings"]}
        assert rec[m["recording_id"]]["electrode_positions"] == "none"
        # positions that cannot be used are a reason to skip the recording, in words
        m["electrode_positions"] = {"source": "file", "points": {"EOG1": [0, 0]}}
        r = admin.admin_ok("recordings_register", {"scope": "study", "manifests": [m], "replace": True})
        assert "'EOG1' is not an EEG channel" in r["skipped"][0]["reason"]
    finally:
        app.state.store.close()
