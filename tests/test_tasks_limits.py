"""The limits on annotators per task and on the target of ratings, kept the same in Python and the browser.

The browser checks a form before sending it, so its copies of the limits (``K_MAX`` in
``js/admin/tasks_model.js``, ``RATINGS_MAX`` in ``js/admin/datasets_model.js`` and the sandbox's
``js/api/demo_library.js``) must match the service's. Raising the number of annotators per task means
changing ``ANNOTATORS_PER_TASK_MAX`` in ``electrotag/config/settings.py`` and ``K_MAX`` together.
"""
from __future__ import annotations

import re
from pathlib import Path

from electrotag.config.settings import ANNOTATORS_PER_TASK_MAX, ANNOTATORS_PER_TASK_MIN
from electrotag.reliability.conflicts import LETTERS
from electrotag.web import datasets, tasks
from electrotag.web.adjudication import _letters

STATIC = Path(__file__).resolve().parents[1] / "electrotag" / "web" / "static" / "js"


def _const(path: Path, name: str) -> str:
    found = re.search(rf"export const {name} = ([^;]+);", path.read_text(encoding="utf-8"))
    assert found, f"{name} is not in {path.name}"
    return found.group(1).strip()


def test_annotators_per_task_match_between_python_and_the_browser() -> None:
    assert (tasks.K_MIN, tasks.K_MAX) == (ANNOTATORS_PER_TASK_MIN, ANNOTATORS_PER_TASK_MAX) == (2, 10)
    model = STATIC / "admin" / "tasks_model.js"
    assert int(_const(model, "K_MIN")) == ANNOTATORS_PER_TASK_MIN
    assert int(_const(model, "K_MAX")) == ANNOTATORS_PER_TASK_MAX
    assert len(LETTERS) >= ANNOTATORS_PER_TASK_MAX, "every person in a task needs a letter in adjudication"


def test_the_target_of_ratings_has_no_upper_limit() -> None:
    assert datasets.RATINGS_MAX == 2**53 - 1 and datasets.RATINGS_LARGE == 100
    assert _const(STATIC / "admin" / "datasets_model.js", "RATINGS_MAX") == "Number.MAX_SAFE_INTEGER"
    assert int(_const(STATIC / "admin" / "datasets_model.js", "RATINGS_LARGE")) == datasets.RATINGS_LARGE
    assert "Number.MAX_SAFE_INTEGER" in (STATIC / "api" / "demo_library.js").read_text(encoding="utf-8")


def test_ten_people_are_given_the_letters_a_to_j() -> None:
    people = [f"A{i:02d}" for i in range(1, 11)]
    assert sorted(_letters(people).values()) == list("ABCDEFGHIJ")
    assert sorted(tasks.letters_for("s" * 64, "t-000000000001", people).values()) == list("ABCDEFGHIJ")
