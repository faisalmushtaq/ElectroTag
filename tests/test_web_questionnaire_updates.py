"""Questions added or changed after people have answered the sign-up questionnaire, and short answers with tick boxes
(electrotag/web/questionnaire.py to_answer; docs/admin_area.md, "Study settings").

A required question added since someone's latest answers, or whose wording or options have changed since, is asked
at their next sign-in (``missing`` and ``to_answer`` of ``GET /me``); a changed question is asked afresh, without the
earlier answer, while their other answers are kept. A short-answer question can offer a few tick boxes (None, Not
applicable) that answer it instead of the text. These run on the service layer directly, with an empty study;
tests/test_web_questionnaire.py has the rest, through the study server.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

from electrotag.config.questionnaire import DEFAULT_QUESTIONS, PREFER_NOT, QuestionnaireError, check_question
from electrotag.web.errors import ApiError
from electrotag.web.questionnaire import EXAMPLE_ANSWERS, to_answer
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore
from electrotag.web.study import WebStudy

ADMIN = User("ADMIN", "Study administrator", role="admin")
A03 = User("A03", "Newcomer", role="annotator")
CONTACTS = {"full_name": "Ama Owusu", "email": "ama@example.org"}


def _every(questions: list[dict[str, Any]]) -> dict[str, Any]:
    return {q["id"]: EXAMPLE_ANSWERS.get(q["id"], [PREFER_NOT] if q["type"] == "multi" else PREFER_NOT)
            for q in questions}


def test_the_two_new_default_questions() -> None:
    by_id = {q["id"]: q for q in DEFAULT_QUESTIONS}
    density = by_id["eeg_density"]
    assert density["text"] == "What density are you most comfortable working with?"
    assert (density["type"], density["options"], density["other_option"]) == (
        "choice", ["Low", "High", "Both", "Neither", "Other"], "Other")
    pre = by_id["preprocessing"]
    assert pre["text"] == "What pre-processing stages do you typically complete before annotating?"
    assert (pre["type"], pre["options"], pre["required"]) == ("text", ["None", "Not applicable"], True)
    assert set(by_id) <= set(EXAMPLE_ANSWERS), "the demonstration's accounts have an answer to every question"


def test_a_short_answer_can_offer_tick_boxes() -> None:
    base = {"id": "pre", "group": "experience", "text": "What?", "type": "text"}
    assert check_question({**base, "options": [" None ", "Not applicable"]}, 1)["options"] == ["None",
                                                                                              "Not applicable"]
    assert "options" not in check_question({**base, "options": []}, 1)
    for extra, words in [({"options": ["a", "b", "c", "d", "e", "f"]}, "up to 5 answers as tick boxes"),
                         ({"other_option": "None"}, "has no option that asks for their own words"),
                         ({"options": ["None", "none"]}, "an option is given twice"),
                         ({"options": ["Prefer not to say"]}, "leave out")]:
        with pytest.raises(QuestionnaireError) as exc:
            check_question({**base, **extra}, 1)
        assert words in str(exc.value)


def _record(questions: list[dict[str, Any]], answers: dict[str, Any]) -> dict[str, Any]:
    return {"history": [{"at": "x", "version": "v1", "answers": answers}], "definitions": {"v1": questions}}


def test_which_questions_are_asked_again() -> None:
    qs = [{"id": "a", "group": "career", "text": "A?", "type": "choice", "required": True, "options": ["1", "2"]},
          {"id": "b", "group": "career", "text": "B?", "type": "text", "required": True},
          {"id": "c", "group": "career", "text": "C?", "type": "text", "required": False}]
    rec = _record(qs, {"a": "1", "b": "words"})
    assert to_answer(qs, rec) == [] and to_answer(qs, None) == [] and to_answer(qs, {"history": []}) == []
    now = copy.deepcopy(qs)
    now[0]["options"] = ["1", "2", "3"]  # changed: asked again
    now[1]["help"] = "A hint"  # help only: not asked again
    now.append({"id": "d", "group": "career", "text": "D?", "type": "text", "required": True})  # added
    now.append({"id": "e", "group": "career", "text": "E?", "type": "text", "required": False})  # added, optional
    assert to_answer(now, rec) == ["a", "d"]
    now[1]["text"] = "B, reworded?"
    assert to_answer(now, rec) == ["a", "b", "d"]


@pytest.fixture
def study(tmp_path: Path):
    folder = tmp_path / "study"
    WebStudy.init(folder, study_id="pilot", name="Pilot")
    store = FilesStore(folder)
    try:
        store.db.add_user("ADMIN", "password-1234", display_name="Study administrator", roles=["admin"])
        store.db.add_user("A03", "password-1234", display_name="Newcomer", roles=["annotator"])
    finally:
        store.close()
    store = FilesStore(folder)
    yield StudyService(store)
    store.close()


def _questions(service: StudyService) -> list[dict[str, Any]]:
    return service.call("questionnaire", A03, {})["questions"]


def test_questions_added_or_changed_are_asked_at_the_next_sign_in(study: StudyService) -> None:
    qs = _questions(study)
    study.call("questionnaire", A03, {"answers": {**_every(qs), "preprocessing": "Not applicable"},
                                      "contacts": CONTACTS})
    me = study.call("me", A03, {})["questionnaire"]
    assert (me["answered"], me["missing"], me["to_answer"]) == (True, 0, [])

    # The study team rewords one question and adds a required one and an optional one.
    now = [({**q, "text": "For how many years have you worked with EEG?"} if q["id"] == "eeg_years" else q) for q in qs]
    now += [{"id": "montage", "group": "experience", "text": "Which montage do you read EEG in?", "type": "text",
             "required": True, "options": ["None", "Not applicable"]},
            {"id": "notes", "group": "experience", "text": "Anything else?", "type": "text", "required": False}]
    study.call("admin", ADMIN, {"op": "settings_update", "settings": {"questionnaire": {"questions": now}}})
    me = study.call("me", A03, {})["questionnaire"]
    assert (me["answered"], me["missing"], me["to_answer"]) == (True, 2, ["eeg_years", "montage"])
    view = study.call("questionnaire", A03, {})
    assert view["to_answer"] == ["eeg_years", "montage"]
    assert "eeg_years" not in view["answers"], "a changed question is asked afresh"
    assert view["answers"]["preprocessing"] == "Not applicable", "the other answers are kept"
    summary = study.call("admin", ADMIN, {"op": "questionnaire_summary"})
    assert summary["to_update"] == ["A03"] and summary["not_answered"] == []
    assert summary["rows"][0]["to_answer"] == ["eeg_years", "montage"]

    # Still a required answer: the save needs them
    with pytest.raises(ApiError) as exc:
        study.call("questionnaire", A03, {"answers": view["answers"], "contacts": CONTACTS})
    assert exc.value.code == "questionnaire_incomplete"
    study.call("questionnaire", A03, {"answers": {**view["answers"], "eeg_years": "1–2", "montage": "None"},
                                      "contacts": CONTACTS})
    me = study.call("me", A03, {})["questionnaire"]
    assert (me["missing"], me["to_answer"]) == (0, [])
    assert study.call("admin", ADMIN, {"op": "questionnaire_summary"})["to_update"] == []
    # work is never refused for questions added later (only before the first answers)
    study.questionnaire.require_answered(A03, "submit")


def test_tick_box_answers_are_kept_and_counted_by_themselves(study: StudyService) -> None:
    qs = _questions(study)
    base = {**_every(qs)}
    out = study.call("questionnaire", A03, {"answers": {**base, "preprocessing": "None"}, "contacts": CONTACTS})
    assert out["answers"]["preprocessing"] == "None"
    counts = study.call("admin", ADMIN, {"op": "questionnaire_summary"})["counts"]["preprocessing"]
    assert counts == {"None": 1}
    study.call("questionnaire", A03, {"answers": {**base, "preprocessing": "Filtering and ICA"}, "contacts": CONTACTS})
    counts = study.call("admin", ADMIN, {"op": "questionnaire_summary"})["counts"]["preprocessing"]
    assert counts == {"answered": 1}
    with pytest.raises(ApiError) as exc:
        study.call("questionnaire", A03, {"answers": {**base, "preprocessing": None}, "contacts": CONTACTS})
    assert exc.value.code == "questionnaire_incomplete", "a required short answer needs the text or a tick box"
