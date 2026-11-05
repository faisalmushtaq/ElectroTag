"""Whether each of ElectroTag's Cloud Functions is open to the browser application.

A callable function is created open to the public (Cloud Run's invoker role for ``allUsers``):
the function itself then checks who is signed in. Firebase's tool sets this when it creates a
function and leaves it alone on later deployments, so a first deployment that Google slows down
(quotas, 429) can leave a function created but closed. A closed function answers 403 before
ElectroTag's code runs and without the headers a browser needs, so the application only learns
that the call failed. ``electrotag web check-functions`` asks every function from outside, as a
browser does, and lists the closed ones with the way to open them (docs/firebase.md, step 8).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from electrotag.web.firebase import REGION

#: The callable functions of functions/main.py (tests/test_firebase_access.py keeps the two the same).
FUNCTION_NAMES: tuple[str, ...] = (
    "et_me", "et_assignments", "et_match", "et_put_draft", "et_delete_draft", "et_submit", "et_training",
    "et_guided_get", "et_guided_check", "et_guided_continue", "et_guided_show_me", "et_visit_open",
    "et_visit_events", "et_visit_close", "et_admin_progress", "et_admin", "et_quiz", "et_expert",
    "et_my_feedback", "et_training_stage", "et_training_snippets", "et_achievements", "et_questionnaire",
    "et_problem_report", "et_my_reviews", "et_my_results",
)

OPEN, CLOSED, MISSING = "open", "closed", "missing"


def function_url(project: str, name: str, region: str = REGION) -> str:
    """The address the browser application calls for one function."""
    return f"https://{region}-{project}.cloudfunctions.net/{name}"


def _is_callable_answer(body: bytes) -> bool:
    """True when the body is a callable function's own JSON answer ({"error": {...}} or {"result": ...})."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    return isinstance(data, dict) and ("error" in data or "result" in data)


def probe(url: str, *, timeout: float = 60.0, urlopen: Callable[..., Any] = urllib.request.urlopen) -> str:
    """How one function answers a call with no one signed in: ``open`` when the function itself
    answers (its own refusal, since nobody is signed in), ``closed`` for Google's 403, ``missing``
    for 404, and otherwise a short description of what came back."""
    req = urllib.request.Request(url, data=b'{"data": {}}', method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=timeout) as res:
            return OPEN if _is_callable_answer(res.read()) else f"answered HTTP {res.status} without a function's answer"
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp is not None else b""
        if _is_callable_answer(body):
            return OPEN
        if exc.code == 403:
            return CLOSED
        if exc.code == 404:
            return MISSING
        return f"answered HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        return f"could not be reached ({reason})"


def check_functions(project: str, names: Iterable[str] = FUNCTION_NAMES, *, region: str = REGION,
                    probe_one: Callable[[str], str] = probe) -> dict[str, str]:
    """Each function's state, by name (the functions are asked at the same time)."""
    names = list(names)
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = list(pool.map(lambda n: probe_one(function_url(project, n, region)), names))
    return dict(zip(names, states))


def report(project: str, states: dict[str, str], region: str = REGION) -> str:
    """What ``check-functions`` prints: a summary, then what to do about closed or missing functions."""
    closed = [n for n, s in states.items() if s == CLOSED]
    missing = [n for n, s in states.items() if s == MISSING]
    other = {n: s for n, s in states.items() if s not in (OPEN, CLOSED, MISSING)}
    n_open = sum(1 for s in states.values() if s == OPEN)
    lines = [f"ElectroTag's {len(states)} functions in the Firebase project {project} ({region}):",
             f"  {n_open} open to the application"]
    if closed:
        lines.append(f"  {len(closed)} closed (Google turns browsers away before ElectroTag answers): {', '.join(closed)}")
    if missing:
        lines.append(f"  {len(missing)} not deployed: {', '.join(missing)}")
    for name, state in other.items():
        lines.append(f"  {name} {state}")
    if closed:
        lines += [
            "",
            "Open each closed function once; later deployments keep it open. With Google Cloud's command",
            "(gcloud, https://cloud.google.com/sdk/docs/install), signed in with an owner of the project:",
            "",
        ]
        lines += [f"  gcloud functions add-invoker-policy-binding {n} --region={region} --member=allUsers "
                  f"--project={project}" for n in closed]
        lines += [
            "",
            "Or in the Google Cloud console: Cloud Run, the function's service (its name with hyphens, for",
            f"example {closed[0].replace('_', '-')}), Security, then Allow public access.",
            "Then run this check again.",
        ]
    if missing:
        lines += ["", "Deploy again to create the missing functions (docs/firebase.md, step 8):",
                  '  npx firebase-tools deploy --only "functions,firestore,hosting"']
    if not closed and not missing and not other:
        lines += ["", "Every function is open to the application."]
    return "\n".join(lines)
