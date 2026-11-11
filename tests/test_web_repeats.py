"""Repeat ratings (the study setting ``repeats``): scheduled, offered as new work, saved as the repeat, analysed.

docs/admin_area.md, "Repeat ratings"; docs/reliability_guide.md, "Repeat ratings (test-retest)".
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import electrotag.web.service as service_module
from electrotag.config.settings import Settings, SettingsError, load_default_settings_dict
from electrotag.web.errors import ApiError
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore
from tests.web_helpers import SUB1, SUB2, SUB3, ann, copy_demo, make_template, match_body, submission

ADMIN = User("ADMIN", "Study administrator", role="admin")
BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, [])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])


# --------------------------------------------------------------------------------------- the setting
def _with(repeats: dict) -> Settings:
    return Settings.from_dict({**load_default_settings_dict(), "repeats": repeats})


def test_the_setting_is_off_by_default_and_rules_apply_in_order() -> None:
    off = Settings.from_dict(load_default_settings_dict()).repeats
    assert (off.enabled, off.rules) == (False, ())
    rp = _with({"enabled": True, "rules": [
        {"id": "pilot", "name": "Pilot", "recordings": "some", "datasets": ["pilot"], "recording_ids": [SUB2],
         "repeats": 2, "interval_days": 7},
        {"id": "rest", "recordings": "all", "repeats": 1, "interval_days": 30}]}).repeats
    assert rp.rule_for(SUB2, "other").rule_id == "pilot"  # picked one by one
    assert rp.rule_for(SUB1, "pilot").rule_id == "pilot"  # in a dataset of the rule
    assert rp.rule_for(SUB1, "other").rule_id == "rest"  # the first rule that covers it
    assert (rp.rules[0].repeats, rp.rules[0].interval_days, rp.rules[1].repeats) == (2, 7, 1)
    switched_off = _with({"enabled": False, "rules": [{"id": "rest"}]}).repeats
    assert switched_off.rule_for(SUB1, "x") is None and switched_off.rules[0].interval_days == 14


@pytest.mark.parametrize("repeats, words", [
    ({"enabled": "yes"}, "repeats.enabled must be true or false"),
    ({"rules": {}}, "repeats.rules must be a list"),
    ({"rules": [{"id": "a b"}]}, "repeats.rules[1].id must be up to 40 letters"),
    ({"rules": [{"id": "a"}, {"id": "a"}]}, "the ID 'a' is used twice"),
    ({"rules": [{"id": "a", "recordings": "most"}]}, 'recordings must be "all" or "some"'),
    ({"rules": [{"id": "a", "recordings": "some"}]}, "name at least one dataset or recording"),
    ({"rules": [{"id": "a", "repeats": 0}]}, "repeats.rules[1].repeats must be a whole number from 1 to 10"),
    ({"rules": [{"id": "a", "repeats": 11}]}, "from 1 to 10"),
    ({"rules": [{"id": "a", "interval_days": 2.5}]}, "interval_days must be a whole number from 1 to 365"),
    ({"rules": [{"id": "a", "interval_days": 366}]}, "from 1 to 365"),
    ({"rules": [{"id": "a", "datasets": "pilot"}]}, "datasets must be a list of IDs"),
])
def test_the_setting_is_checked_in_plain_words(repeats: dict, words: str) -> None:
    with pytest.raises(SettingsError) as exc:
        _with(repeats)
    assert words in str(exc.value)


# ------------------------------------------------------------------------------------- the study
@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-repeats"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def service(template: Path, tmp_path: Path):
    folder = copy_demo(template, tmp_path)
    store = FilesStore(folder)
    try:
        store.db.add_user("A03", "password-1234", display_name="Annotator A03")
        store.assign("A03", [SUB1, SUB2, SUB3])
    finally:
        store.close()
    store = FilesStore(folder)
    yield StudyService(store)
    store.close()


def _rules(service: StudyService, *rules: dict, enabled: bool = True) -> dict:
    return service.call("admin", ADMIN, {"op": "settings_update",
                                         "settings": {"repeats": {"enabled": enabled, "rules": list(rules)}}})


def _item(service: StudyService, aid: str, rid: str) -> dict:
    return next(i for i in service.call("assignments", User(aid), {})["items"] if i["recording_id"] == rid)


class _Clock:
    """The service's clock, moved on by whole days (the saves keep their real times)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.offset = timedelta(0)
        clock = self

        class Moved(datetime):
            @classmethod
            def now(cls, tz=None):  # noqa: ANN001, ANN206 - as datetime.now
                return datetime.now(tz or timezone.utc) + clock.offset

        monkeypatch.setattr(service_module, "datetime", Moved)

    def days(self, n: float) -> None:
        self.offset = timedelta(days=n)


def test_a_repeat_comes_back_after_its_days_as_new_work_and_is_saved_as_the_repeat(
        service: StudyService, recordings: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = _Clock(monkeypatch)
    a03 = User("A03")
    out = _rules(service, {"id": "pilot", "name": "Pilot", "recordings": "some", "recording_ids": [SUB1],
                           "repeats": 2, "interval_days": 7})
    assert out["settings"]["repeats"]["rules"][0]["id"] == "pilot"
    audit = service.call("admin", ADMIN, {"op": "audit", "limit": 1})["entries"][0]
    assert audit["op"] == "settings_update" and "enabled (repeats) from off to on" in audit["summary"]
    assert "rules pilot (repeats) added" in audit["summary"]

    first = service.call("submit", a03, submission(recordings, SUB1, [BLINK, EMG]))
    assert first["attempt"] == 1
    service.call("submit", a03, submission(recordings, SUB2, [BLINK]))
    assert _item(service, "A03", SUB1)["status"] == "done"
    clock.days(6.9)
    assert _item(service, "A03", SUB1)["status"] == "done", "not before its days"

    # Seven days on, it is new work again, with nothing of the first rating: no history, no times.
    clock.days(7.1)
    item = _item(service, "A03", SUB1)
    assert (item["status"], item["saved"], item["completed_at"], item["n_annotations"], item["repeat"]) == (
        "todo", None, None, None, False)
    assert _item(service, "A03", SUB2)["status"] == "done", "a recording no rule covers is not repeated"
    assert service.call("assignments", a03, {})["next"] in (SUB1, SUB3), "it is open work again"
    # The study team still counts the recording as done.
    counts = service.call("admin", ADMIN, {"op": "overview"})["counts"]
    assert counts["done"] >= 2
    # Opened, it starts empty (no revision, no draft of the first rating), and a draft is kept as for new work.
    m = service.call("match", a03, match_body(recordings, SUB1))
    assert m["status"] == "matched" and m["revision"] is None and m["draft"] is None and m["repeat"] is False
    service.call("put_draft", a03, {"recording_id": SUB1, "mode": "standard", "context_id": "",
                                    "draft": {"annotations": [BLINK], "elapsed_s": 5.0}})
    assert _item(service, "A03", SUB1)["status"] == "in_progress"
    # Asked to revise, it opens as the repeat all the same: the first rating is not shown.
    again = service.call("match", a03, {**match_body(recordings, SUB1), "revise": True})
    assert again["revision"] is None and again["draft"]["annotations"][0]["label"] == "Eye-blink-artifact"

    # Saved: the next attempt, marked as the first repeat in the register and in the files.
    second = service.call("submit", a03, submission(recordings, SUB1, [BLINK]))
    assert second["attempt"] == 2 and second["revision"] is None
    rows = [r for r in service.store.completion_entries("A03") if r["recording_id"] == SUB1]
    assert [r.get("retest", "") for r in rows] == ["", "1"]
    doc = json.loads(service.store.saved_document("A03", SUB1, "standard", ""))
    assert doc["session"]["context"]["retest"] == {"number": 1, "rule_id": "pilot", "interval_days": 7}
    clock.days(0)  # (the repeat was saved now; the clock still stood seven days on)
    assert _item(service, "A03", SUB1)["status"] == "done"

    # The second repeat counts its days from the first repeat's save; after it, no more.
    clock.days(6.5)
    assert _item(service, "A03", SUB1)["status"] == "done"
    clock.days(7.5)
    assert _item(service, "A03", SUB1)["status"] == "todo"
    service.call("submit", a03, submission(recordings, SUB1, [BLINK, EMG]))
    rows = [r for r in service.store.completion_entries("A03") if r["recording_id"] == SUB1]
    assert [r.get("retest", "") for r in rows] == ["", "1", "2"]
    clock.days(400)
    assert _item(service, "A03", SUB1)["status"] == "done", "two repeats, as the rule asks"

    # Switched off, no repeat comes due, and the rules are kept.
    _rules(service, {"id": "pilot", "recordings": "all", "repeats": 5, "interval_days": 1}, enabled=False)
    assert _item(service, "A03", SUB2)["status"] == "done"
    _rules(service, {"id": "pilot", "recordings": "all", "repeats": 5, "interval_days": 1})
    assert _item(service, "A03", SUB2)["status"] == "todo"


def test_a_revision_of_a_repeat_stays_that_repeat(service: StudyService, recordings: Path,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    clock = _Clock(monkeypatch)
    a03 = User("A03")
    _rules(service, {"id": "all", "recordings": "all", "repeats": 1, "interval_days": 3})
    service.call("submit", a03, submission(recordings, SUB1, [BLINK]))
    clock.days(4)
    service.call("submit", a03, submission(recordings, SUB1, [EMG]))
    clock.days(0)
    item = _item(service, "A03", SUB1)
    assert item["status"] == "done" and item["saved"]["version"] == 2
    out = service.call("submit", a03, {**submission(recordings, SUB1, [BLINK, EMG]), "revises": 2})
    assert out["revision"] == {"version": 3, "revises": 2}
    rows = [r for r in service.store.completion_entries("A03") if r["recording_id"] == SUB1]
    assert [r.get("retest", "") for r in rows] == ["", "1", "1"]
    clock.days(400)
    assert _item(service, "A03", SUB1)["status"] == "done", "the revision is not a further repeat"


def test_the_analyses_leave_repeats_out_between_annotators_and_compare_each_with_their_own(
        service: StudyService, recordings: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = _Clock(monkeypatch)
    _rules(service, {"id": "all", "recordings": "all", "repeats": 1, "interval_days": 2})
    for aid in ("A01", "A03"):
        service.call("submit", User(aid), submission(recordings, SUB2, [BLINK, EMG]))
    clock.days(3)
    service.call("submit", User("A03"), submission(recordings, SUB2, [BLINK]))  # A03's repeat: EMG left out

    between = service.call("admin", ADMIN, {"op": "agreement", "config": {"resolutions_s": [1.0]}})
    assert any("repeat rating was left out" in w for w in between["warnings"])
    assert {"A01", "A03"} <= set(between["summary"]["annotators"])

    within = service.call("admin", ADMIN, {"op": "agreement",
                                           "config": {"resolutions_s": [1.0], "comparison": "within"}})
    assert within["summary"]["annotators"] == ["first rating", "repeat 1"]
    assert "intrarater_by_annotator.tsv" in within["tables"]
    by_person = within["tables"]["intrarater_by_annotator.tsv"]
    assert "A03\tANY-artifact\tfirst rating\trepeat 1" in by_person
    assert "A01\t" not in by_person, "A01 has no repeat yet"
    assert "Intra-rater (test-retest) agreement report" in within["report_html"]
    with pytest.raises(ApiError) as exc:  # a reference annotator is for comparisons between people
        service.call("admin", ADMIN, {"op": "agreement",
                                      "config": {"comparison": "within", "reference_annotator": "A01"}})
    assert exc.value.code == "invalid_config"
