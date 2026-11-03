"""electrotag web check-functions: which Cloud Functions are open to the browser application."""

from __future__ import annotations

import io
import json
import re
import urllib.error
from pathlib import Path

import pytest

from electrotag.web.firebase import access

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "electrotag" / "web" / "firebase" / "functions" / "main.py"


def test_the_list_of_functions_is_main_py_s():
    defined = re.findall(r"^def (et_\w+)\(", MAIN.read_text(encoding="utf-8"), flags=re.MULTILINE)
    assert list(access.FUNCTION_NAMES) == defined


def test_the_address_is_the_one_the_browser_calls():
    assert access.function_url("my-eeg-study", "et_me") == "https://europe-west2-my-eeg-study.cloudfunctions.net/et_me"


class _Answer:
    def __init__(self, status: int, body: bytes) -> None:
        self.status, self._body = status, body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Answer:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _http_error(code: int, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x", code, "error", {}, io.BytesIO(body))  # type: ignore[arg-type]


def _urlopen(outcome):
    def urlopen(req, timeout):
        assert req.get_method() == "POST"
        assert json.loads(req.data) == {"data": {}}
        assert req.get_header("Content-type") == "application/json"
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome
    return urlopen


@pytest.mark.parametrize(("outcome", "state"), [
    # The function itself answers (nobody is signed in, or the study is missing): open.
    (_http_error(400, b'{"error": {"status": "INVALID_ARGUMENT", "message": "The request must name the study"}}'), "open"),
    (_http_error(401, b'{"error": {"status": "UNAUTHENTICATED", "message": "Please sign in"}}'), "open"),
    (_Answer(200, b'{"result": {}}'), "open"),
    # Google's own refusal, before ElectroTag runs: closed.
    (_http_error(403, b"<html><title>403 Forbidden</title>Your client does not have permission</html>"), "closed"),
    (_http_error(404, b"<html>Page not found</html>"), "missing"),
    (_http_error(502, b"<html>Bad gateway</html>"), "answered HTTP 502"),
    (urllib.error.URLError("timed out"), "could not be reached (timed out)"),
])
def test_probe_tells_the_function_s_own_answer_from_google_s(outcome, state):
    assert access.probe("https://x/et_me", urlopen=_urlopen(outcome)) == state


def test_the_report_lists_closed_functions_with_the_command_that_opens_each():
    states = {n: access.OPEN for n in access.FUNCTION_NAMES}
    states["et_me"] = states["et_assignments"] = access.CLOSED
    text = access.report("my-eeg-study", states)
    assert "24 open to the application" in text
    assert "2 closed" in text and "et_me, et_assignments" in text
    for name in ("et_me", "et_assignments"):
        assert (f"gcloud functions add-invoker-policy-binding {name} --region=europe-west2 --member=allUsers "
                f"--project=my-eeg-study") in text
    assert "et-me" in text and "Allow public access" in text
    assert "gcloud functions add-invoker-policy-binding et_admin" not in text


def test_the_report_of_a_healthy_project_says_so():
    text = access.report("p", {n: access.OPEN for n in access.FUNCTION_NAMES})
    assert "26 open" in text and "Every function is open" in text and "gcloud" not in text


def test_check_functions_asks_every_function_once():
    asked: list[str] = []

    def probe_one(url: str) -> str:
        asked.append(url)
        return access.CLOSED if url.endswith("/et_me") else access.OPEN

    states = access.check_functions("p", probe_one=probe_one)
    assert sorted(asked) == sorted(access.function_url("p", n) for n in access.FUNCTION_NAMES)
    assert states["et_me"] == access.CLOSED and list(states) == list(access.FUNCTION_NAMES)


def test_the_command_prints_the_report_and_fails_while_a_function_is_closed(monkeypatch, capsys):
    from electrotag.web import cli

    states = {n: access.OPEN for n in access.FUNCTION_NAMES}
    monkeypatch.setattr(access, "check_functions", lambda project: dict(states))
    assert cli.main(["check-functions", "--firebase-project", "my-eeg-study"]) == 0
    assert "Every function is open" in capsys.readouterr().out
    states["et_me"] = access.CLOSED
    assert cli.main(["check-functions", "--firebase-project", "my-eeg-study"]) == 1
    assert "gcloud functions add-invoker-policy-binding et_me" in capsys.readouterr().out
    monkeypatch.delenv("ELECTROTAG_FIREBASE_PROJECT", raising=False)
    assert cli.main(["check-functions"]) == 2
