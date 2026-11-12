"""The settings a study chooses before it starts (docs/admin_area.md, "Before the study starts").

Three groups of settings decide what a study's results mean, so the study team chooses them before the study
starts and reports them with the results: the agreement analysis's settings (saved as the study's own in
``preregistration.agreement``), the measure of working time it reports (``preregistration.working_time``, with
the idle threshold ``logging.idle_after_s``) and the repeat ratings for test-retest reliability (``repeats``).
Every one has a default, so an untouched study cannot be told from one that kept the defaults on purpose: an
administrator confirms each group, and the confirmation keeps who confirmed it, when, and the values confirmed.
A group whose settings have changed since is shown as changed until it is confirmed again; the audit log keeps
every confirmation.

* ``preregistration_get {}`` → :meth:`Preregistration.status`
* ``preregistration_confirm {item}`` → the same, after the confirmation (audited)

The confirmations are records of the kind ``preregistration``, one for each group (its ID the group's name).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.store import User

KIND = "preregistration"
#: The groups of settings, in the order the admin area lists them, with their names in the audit log.
ITEMS = {"agreement": "agreement settings", "working_time": "measure of working time",
         "repeats": "repeat ratings"}


def _moment(stamp: Any) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(stamp or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def current_values(settings: Any) -> dict[str, Any]:
    """The settings of each group as they are now (what a confirmation keeps)."""
    rp = settings.repeats
    return {
        "agreement": settings.preregistration.agreement,
        "working_time": {"measure": settings.preregistration.working_time,
                         "idle_after_s": float(settings.logging_idle_after_s)},
        "repeats": {"enabled": rp.enabled,
                    "rules": [{"id": r.rule_id, "name": r.name,
                               "recordings": "all" if r.every_recording else "some",
                               "datasets": list(r.datasets), "recording_ids": list(r.recording_ids),
                               "repeats": r.repeats, "interval_days": r.interval_days} for r in rp.rules]},
    }


def study_started_at(store: Any) -> str | None:
    """When the first study recording was saved (research annotation; training does not start a study)."""
    times = [str(e.get("completed_at") or "") for e in store.completion_entries()
             if e.get("status") == "completed" and (e.get("mode") or "standard") == "standard"]
    moments = [(t, m) for t in times if (m := _moment(t)) is not None]
    return min(moments, key=lambda x: x[1])[0] if moments else None


def status(store: Any) -> dict[str, Any]:
    """Each group of settings: its values now, whether it is confirmed, and when the study started.

    ``state`` is ``not_confirmed``, ``confirmed`` (its values are the ones confirmed) or ``changed`` (they have
    changed since); ``before_start`` says whether it was confirmed before the first study recording was saved.
    """
    values = current_values(store.settings)
    records = {str(r.get("item")): r for r in store.records(KIND)}
    started = study_started_at(store)
    start = _moment(started)
    items = []
    for item in ITEMS:
        rec = records.get(item)
        ready = values[item] is not None
        if rec is None:
            state = "not_confirmed"
        else:
            state = "confirmed" if _same(rec.get("values"), values[item]) else "changed"
        at = _moment((rec or {}).get("confirmed_at"))
        items.append({
            "item": item, "state": state, "values": values[item], "ready": ready,
            "confirmed_values": (rec or {}).get("values") if rec else None,
            "confirmed_at": (rec or {}).get("confirmed_at") or None,
            "confirmed_by": (rec or {}).get("confirmed_by") or None,
            "before_start": None if rec is None or at is None else start is None or at < start,
        })
    return {"items": items, "study_started_at": started,
            "done": all(i["state"] == "confirmed" for i in items)}


def agreement_check(settings: Any, cfg: Any) -> dict[str, Any]:
    """How an agreement analysis's settings (an AnalysisConfig) stand against the study's pre-registered ones:
    ``state`` is ``not_saved`` (the study has saved none), ``matches`` or ``differs``, with the settings that
    differ."""
    from electrotag.config.settings import PREREGISTERED_AGREEMENT_KEYS

    saved = settings.preregistration.agreement
    if saved is None:
        return {"state": "not_saved", "differs": []}
    used = cfg.to_dict()
    differs = [k for k in PREREGISTERED_AGREEMENT_KEYS if not _same(saved.get(k), used.get(k))]
    return {"state": "differs" if differs else "matches", "differs": differs}


class Preregistration:
    def __init__(self, service: Any) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        return status(self.store)

    def confirm(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        item = body.get("item")
        if item not in ITEMS:
            raise ApiError(400, "bad_request", f"item must be one of {', '.join(ITEMS)}")
        values = current_values(self.store.settings)[item]
        if values is None:
            raise ApiError(409, "not_saved", "The study has no agreement settings of its own yet. Choose them on the "
                           "Analyses page and save them as the study's, then confirm them.")
        now = now_local_iso()
        confirmed: list[bool] = []

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if old is not None and _same(old.get("values"), values):
                return None  # confirmed already, with these values
            confirmed.append(True)
            return {"item": item, "values": values, "confirmed_at": now, "confirmed_by": user.annotator_id,
                    "times_confirmed": int((old or {}).get("times_confirmed") or 0) + 1}

        self.store.update_record(KIND, item, "", change)
        if confirmed:
            started = study_started_at(self.store)
            when = " after the study started" if started else ""
            audit.record(self.store, user.annotator_id, "preregistration_confirm",
                         f"Confirmed the {ITEMS[item]}{when}", {"item": item, "values": values,
                                                                "study_started_at": started})
        return status(self.store)


def preregistration_files(store: Any) -> dict[str, bytes]:
    """For the results zip: the confirmations and the settings now (study/preregistration.json) and, once saved,
    the pre-registered agreement settings in the form ``electrotag-agreement --config`` reads."""
    from electrotag.reliability.config import AnalysisConfig

    dump = lambda obj: (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")  # noqa: E731
    out = {"study/preregistration.json": dump(status(store))}
    saved = store.settings.preregistration.agreement
    if saved is not None:
        out["study/agreement_settings_preregistered.json"] = dump(
            {"config": {**AnalysisConfig().to_dict(), **saved}})
    return out
