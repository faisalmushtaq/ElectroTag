"""The guided coach when a check and Show me are handled at once (electrotag/web/coach.py, js/training/coach.js).

On Firebase the functions answer calls side by side: a check that read the step before Show me was saved, and is
saved after it, must not take the step's "shown" away, or the step is scored as found alone (3 stars, not 1)."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")

from electrotag.training.guided import STARS_SHOWN  # noqa: E402
from electrotag.web.service import StudyService  # noqa: E402
from electrotag.web.store import User  # noqa: E402
from electrotag.web.store_files import FilesStore  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    as_wire,
    copy_demo,
    make_template,
    reference_annotations,
    skip_to_guided_in,
)

T01 = User("T01", "Trainee")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-guided-race"))


@pytest.fixture
def service(template: Path, tmp_path: Path):
    svc = StudyService(FilesStore(copy_demo(template, tmp_path)))
    yield svc
    svc.store.close()


def test_a_check_saved_after_show_me_keeps_the_step_shown(service: StudyService,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    skip_to_guided_in(service, T01)
    service.call("guided_get", T01, {"recording_id": GUIDED1})
    rs = service.reference_set("example")
    coach = service.coach
    # the state as the check read it: before Show me was saved
    stale = copy.deepcopy(coach._state(T01, rs, GUIDED1))
    shown = service.call("guided_show_me", T01, {"recording_id": GUIDED1, "step": 1})
    assert shown["annotation"]["label"]
    real = coach._state
    calls: list[int] = []

    def read_before_show_me(user: User, rs_: Any, rid: str) -> dict[str, Any]:
        calls.append(1)
        return copy.deepcopy(stale) if len(calls) == 1 else real(user, rs_, rid)

    monkeypatch.setattr(coach, "_state", read_before_show_me)
    step = reference_annotations(service.store, "example", GUIDED1)[0]
    c = service.call("guided_check", T01, {"recording_id": GUIDED1, "step": 1, "annotations": [as_wire(step)]})
    monkeypatch.undo()
    assert calls and c["can_continue"] and c["stars"] == STARS_SHOWN
    nxt = service.call("guided_continue", T01, {"recording_id": GUIDED1, "step": 1})
    assert nxt["previous"]["used_show_me"] is True and nxt["previous"]["stars"] == STARS_SHOWN
