"""Experts looking through a dataset for training recordings (docs/api.md, "Looking for training recordings";
docs/admin_area.md, "Looking for training recordings").

An administrator gives an expert the whole of a source dataset to look through (``browse_access_set``). The expert
opens any of its recordings from their own computer, as always, and may mark artifacts on it, write notes of their
own about it and rate it Yes, No or Maybe for training (``browse_save``). What they mark and write there is theirs
alone: it is kept in its own records (``browse_notes``), never as anyone's draft or saved work, so it never reaches
the results, the exports, the results zip or an analysis, and the browser does not record the visit in the
interaction log. The expert asks for recordings to be added to the training material (``training_request``, one
recording or many at once), and the study team sees the requests in Training (``training_requests_list``),
approving them into a reference set of their choice or declining them (``training_requests_decide``).

An approved recording waits in its set, Awaiting annotation (``training_waiting_list``), until the study's experts
annotate it properly and its reference is added in the usual way (Recordings and references); a recording whose
reference is in the set leaves the list by itself. ``training_waiting_remove`` takes one off the list.

The records, each written with :meth:`Store.update_record` and never deleted:

* ``browse_access``: one per dataset and expert, with ``active`` and the history of the changes;
* ``browse_notes``: one per expert and recording, with ``note``, ``rating`` and ``annotations`` (the expert's own
  marks, kept as the browser sends them, as a draft is);
* ``training_requests``: one per expert and recording, with its ``status`` (``pending``, ``approved``,
  ``declined``, ``withdrawn`` or ``removed``), the set it was approved into and its history.

Administrators may look through every dataset without being given it. Every change is in the audit log, apart from
the expert's own marks, notes and ratings, which are theirs and change as they work.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.datasets import DEFAULT_DATASET_ID
from electrotag.web.errors import ApiError
from electrotag.web.expert import expert_op
from electrotag.web.manifest import SCOPE_STUDY, dataset_of
from electrotag.web.store import User, parse_roles

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

ACCESS, NOTES, REQUESTS = "browse_access", "browse_notes", "training_requests"
RATINGS = ("yes", "no", "maybe")
STATUSES = ("pending", "approved", "declined", "withdrawn", "removed")
#: The statuses from which an expert's new request opens the request again.
CLOSED = ("declined", "withdrawn", "removed")
MAX_NOTE = 5000
MAX_MARKS = 5000
#: The most an expert's marks on one recording may take as JSON (a Firestore document holds about 1 MB).
MAX_MARKS_BYTES = 600_000
MAX_AT_ONCE = 500
HISTORY_KEPT = 50
#: The admin area's operations of this module (electrotag/web/admin.py adds them to its lists).
READS = ("browse_access_list", "training_requests_list", "training_waiting_list")
WRITES = ("browse_access_set", "training_requests_decide", "training_waiting_remove")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _key(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


def access_key(dataset_id: str, annotator_id: str) -> str:
    return _key("access", dataset_id, annotator_id)


def notes_key(annotator_id: str, recording_id: str) -> str:
    return _key("notes", annotator_id, recording_id)


def request_key(annotator_id: str, recording_id: str) -> str:
    return _key("request", annotator_id, recording_id)


def _effective_dataset(m: dict[str, Any]) -> str:
    return dataset_of(m) or DEFAULT_DATASET_ID


def _label_counts(annotations: list[Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for a in annotations:
        if isinstance(a, dict) and isinstance(a.get("label"), str):
            out[a["label"]] = out.get(a["label"], 0) + 1
    return dict(sorted(out.items()))


def _history(old: dict[str, Any], entry: dict[str, Any]) -> list[dict[str, Any]]:
    return [*list(old.get("history") or [])[-(HISTORY_KEPT - 1):], entry]


class Candidates:
    """Looking for training recordings: the admin area's operations (``Admin.op_<name>`` delegates here) and the
    expert area's (registered below with :func:`expert_op`)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def _audit(self, user: User, op: str, summary: str, **details: Any) -> None:
        audit.record(self.store, user.annotator_id, op, summary, details)

    # ------------------------------------------------------------- who may look
    def _expert_ids(self) -> dict[str, dict[str, Any]]:
        """The accounts that hold the expert role (administrators look at everything without being given it)."""
        return {r["annotator_id"]: r for r in self.store.user_records()
                if "expert" in parse_roles(r.get("roles") or r.get("role"))}

    def grants(self, annotator_id: str | None = None) -> list[dict[str, Any]]:
        """The datasets given to experts to look through, as they stand (those taken back are left out)."""
        return [g for g in self.store.records(ACCESS, annotator_id) if g.get("active")]

    def may_browse(self, user: User, dataset_id: str) -> bool:
        if user.is_admin:
            return True
        return user.is_expert and any(g.get("dataset_id") == dataset_id for g in self.grants(user.annotator_id))

    def _datasets_of(self, user: User) -> list[dict[str, Any]]:
        datasets = self.service.datasets.all_datasets()
        if user.is_admin:
            return datasets
        mine = {g.get("dataset_id") for g in self.grants(user.annotator_id)}
        return [d for d in datasets if d["dataset_id"] in mine]

    def _study_recording(self, user: User, rid: Any) -> dict[str, Any]:
        """The manifest of a study recording the caller may look at (404 when there is none, 403 when it is in a
        dataset they have not been given)."""
        if not isinstance(rid, str) or not rid or len(rid) > 512:
            raise _bad("recording_id is missing")
        m = self.store.manifest(SCOPE_STUDY, rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not one of the study's recordings")
        if not self.may_browse(user, _effective_dataset(m)):
            raise ApiError(403, "no_access", f"You have not been given the dataset that {rid} belongs to. Ask the "
                           "study team to let you look through it.")
        return m

    # ------------------------------------------------------------- the records
    def _notes(self, aid: str) -> dict[str, dict[str, Any]]:
        return {str(r.get("recording_id")): r for r in self.store.records(NOTES, aid)}

    def _requests(self, aid: str | None = None) -> list[dict[str, Any]]:
        return self.store.records(REQUESTS, aid)

    @staticmethod
    def notes_out(rec: dict[str, Any] | None) -> dict[str, Any]:
        rec = rec or {}
        marks = rec.get("annotations") if isinstance(rec.get("annotations"), list) else []
        return {"note": str(rec.get("note") or ""), "rating": rec.get("rating") if rec.get("rating") in RATINGS
                else None, "annotations": marks, "n_annotations": len(marks), "labels": _label_counts(marks),
                "updated_at": rec.get("updated_at") or None}

    def _set_names(self) -> dict[str, str]:
        return {rs.set_id: rs.name or rs.set_id for rs in self.store.reference_sets()}

    @staticmethod
    def request_out(rec: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
        set_id = rec.get("set_id") or None
        return {"request_id": rec.get("request_id"), "annotator_id": rec.get("annotator_id"),
                "recording_id": rec.get("recording_id"), "file_name": rec.get("file_name", ""),
                "dataset_id": rec.get("dataset_id", ""), "status": rec.get("status", "pending"),
                "rating": rec.get("rating") if rec.get("rating") in RATINGS else None,
                "requested_at": rec.get("requested_at") or None, "set_id": set_id,
                "set_name": names.get(set_id, set_id) if set_id else None,
                "decided_at": rec.get("decided_at") or None, "decided_by": rec.get("decided_by") or None,
                "reason": rec.get("reason") or ""}

    # ================================================================ the expert's operations
    def datasets_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``browse_datasets_list``: the datasets the caller may look through, with how far they have got."""
        heads = self.service.datasets.heads()
        notes = self._notes(user.annotator_id)
        requests = {r.get("recording_id"): r for r in self._requests(user.annotator_id)}
        out = []
        for d in self._datasets_of(user):
            rids = [h["recording_id"] for h in heads if h["dataset_id"] == d["dataset_id"] and not h["retired"]]
            out.append({"dataset_id": d["dataset_id"], "name": d.get("name", ""),
                        "description": d.get("description", ""), "n_recordings": len(rids),
                        "n_rated": sum(1 for r in rids if (notes.get(r) or {}).get("rating") in RATINGS),
                        "n_requested": sum(1 for r in rids if r in requests
                                           and requests[r].get("status") in ("pending", "approved"))})
        return {"datasets": out, "everything": user.is_admin}

    def recordings_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``browse_recordings_list``: one dataset's recordings in use, each with the caller's rating, whether they
        wrote a note, how many marks they made and where their request stands."""
        did = body.get("dataset_id")
        rec = self.service.datasets.need_dataset(did)
        if not self.may_browse(user, rec["dataset_id"]):
            raise ApiError(403, "no_access", f"You have not been given the dataset {rec.get('name') or did} to look "
                           "through. Ask the study team.")
        notes = self._notes(user.annotator_id)
        requests = {r.get("recording_id"): r for r in self._requests(user.annotator_id)}
        names = self._set_names()
        rows = []
        for h in self.service.datasets.heads():
            if h["dataset_id"] != rec["dataset_id"] or h["retired"]:
                continue
            n = self.notes_out(notes.get(h["recording_id"]))
            r = requests.get(h["recording_id"])
            rows.append({"recording_id": h["recording_id"], "file_name": h["file_name"], "format": h["format"],
                         "duration_s": h["n_samples"] / h["sfreq"] if h["sfreq"] else 0.0,
                         "n_channels": h["n_channels"], "rating": n["rating"], "has_note": bool(n["note"]),
                         "n_annotations": n["n_annotations"], "labels": n["labels"], "updated_at": n["updated_at"],
                         "request": self.request_out(r, names) if r else None})
        return {"dataset": {"dataset_id": rec["dataset_id"], "name": rec.get("name", ""),
                            "description": rec.get("description", "")}, "recordings": rows}

    def recording_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``browse_recording_get``: what the browser needs to open one recording to look at it (its manifest, to check
        the file against) with the caller's own marks, note and rating."""
        m = self._study_recording(user, body.get("recording_id"))
        rid = m["recording_id"]
        r = next((x for x in self._requests(user.annotator_id) if x.get("recording_id") == rid), None)
        did = _effective_dataset(m)
        ds = self.service.datasets.dataset_record(did) or {}
        return {"recording_id": rid, "file_name": m.get("file_name", ""), "dataset_id": did,
                "dataset_name": ds.get("name", ""), "manifest": self.service.public_manifest(m),
                "mine": self.notes_out(self._notes(user.annotator_id).get(rid)),
                "request": self.request_out(r, self._set_names()) if r else None}

    def save(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``browse_save``: the caller's own marks, note and rating on one recording; only the keys sent change. The
        same state sent again changes nothing."""
        m = self._study_recording(user, body.get("recording_id"))
        rid = m["recording_id"]
        change: dict[str, Any] = {}
        if "note" in body:
            note = body.get("note")
            if note is None:
                note = ""
            if not isinstance(note, str) or len(note) > MAX_NOTE:
                raise _bad(f"note must be text of at most {MAX_NOTE} characters")
            change["note"] = note.strip()
        if "rating" in body:
            rating = body.get("rating")
            if rating is not None and rating not in RATINGS:
                raise _bad("rating must be yes, no, maybe or null (not rated)")
            change["rating"] = rating
        if "annotations" in body:
            change["annotations"] = self._marks(body.get("annotations"))
        if not change:
            raise _bad("Nothing to save: give note, rating or annotations")
        now = now_local_iso()
        changed = {"value": False}

        def put(old: dict[str, Any] | None) -> dict[str, Any] | None:
            base = old or {"schema": "electrotag.browse_notes", "schema_version": 1, "annotator_id": user.annotator_id,
                           "recording_id": rid, "dataset_id": _effective_dataset(m), "note": "", "rating": None,
                           "annotations": [], "created_at": now}
            new = {**base, **change}
            if old is not None and all(json.dumps(old.get(k), sort_keys=True) == json.dumps(v, sort_keys=True)
                                       for k, v in change.items()):
                return None
            changed["value"] = True
            return {**new, "updated_at": now}

        kept = self.store.update_record(NOTES, notes_key(user.annotator_id, rid), user.annotator_id, put)
        return {"recording_id": rid, "mine": self.notes_out(kept), "changed": changed["value"]}

    @staticmethod
    def _marks(value: Any) -> list[dict[str, Any]]:
        from electrotag.web.service import confidence_and_note

        if not isinstance(value, list) or len(value) > MAX_MARKS or not all(isinstance(a, dict) for a in value):
            raise ApiError(422, "invalid_annotations", f"annotations must be a list of at most {MAX_MARKS} marks")
        for i, a in enumerate(value, start=1):
            if not isinstance(a.get("label"), str) or not a["label"]:
                raise ApiError(422, "invalid_annotations", f"Mark {i} has no artifact type")
            for k in ("onset_sample", "duration_samples"):
                v = a.get(k)
                if isinstance(v, bool) or not isinstance(v, int) or v < 0:
                    raise ApiError(422, "invalid_annotations", f"Mark {i}: {k} must be a whole number of samples")
            confidence_and_note(a, f"Mark {i}", "invalid_annotations")
        if len(json.dumps(value)) > MAX_MARKS_BYTES:
            raise ApiError(413, "too_large", "These marks are too many to keep with your notes. They are for looking "
                           "through only: keep the ones that matter and remove the rest.")
        return [dict(a) for a in value]

    def request(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``training_request``: ask for recordings (``recording_ids``, one or many) to be added to the training
        material. A request already waiting or approved stays as it is; one declined, withdrawn or taken off a
        waiting list opens again."""
        rids = body.get("recording_ids")
        if not isinstance(rids, list) or not rids or len(rids) > MAX_AT_ONCE \
                or not all(isinstance(r, str) and r for r in rids):
            raise _bad(f"recording_ids must be a list of 1 to {MAX_AT_ONCE} recordings")
        rids = list(dict.fromkeys(rids))
        manifests = [self._study_recording(user, rid) for rid in rids]  # every one checked before any is asked for
        notes = self._notes(user.annotator_id)
        now = now_local_iso()
        made, kept = [], []
        for m in manifests:
            rid = m["recording_id"]
            rating = (notes.get(rid) or {}).get("rating")
            opened = {"value": False}

            def put(old: dict[str, Any] | None, m: dict[str, Any] = m, rid: str = rid, rating: Any = rating,
                    opened: dict[str, bool] = opened) -> dict[str, Any] | None:
                if old is not None and old.get("status") not in CLOSED:
                    return None
                opened["value"] = True
                key = request_key(user.annotator_id, rid)
                base = old or {"schema": "electrotag.training_request", "schema_version": 1, "request_id": key,
                               "annotator_id": user.annotator_id, "recording_id": rid}
                return {**base, "file_name": m.get("file_name", ""), "dataset_id": _effective_dataset(m),
                        "status": "pending", "rating": rating if rating in RATINGS else None, "requested_at": now,
                        "set_id": None, "decided_at": None, "decided_by": None, "reason": "",
                        "history": _history(old or {}, {"at": now, "by": user.annotator_id, "status": "pending"})}

            self.store.update_record(REQUESTS, request_key(user.annotator_id, rid), user.annotator_id, put)
            (made if opened["value"] else kept).append(rid)
        if made:
            self._audit(user, "training_request", f"{user.annotator_id} asked for "
                        f"{audit.count(len(made), 'recording')} to be added to the training material",
                        recording_ids=made)
        names = self._set_names()
        mine = {r.get("recording_id"): r for r in self._requests(user.annotator_id)}
        return {"requested": made, "already": kept,
                "requests": [self.request_out(mine[r], names) for r in rids if r in mine]}

    def withdraw(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``training_request_withdraw``: take back the caller's own request while it waits for a decision."""
        rid = body.get("recording_id")
        if not isinstance(rid, str) or not rid:
            raise _bad("recording_id is missing")
        now = now_local_iso()
        state = {"found": None}

        def put(old: dict[str, Any] | None) -> dict[str, Any] | None:
            state["found"] = old
            if old is None or old.get("status") != "pending":
                return None
            return {**old, "status": "withdrawn", "decided_at": now, "decided_by": user.annotator_id,
                    "history": _history(old, {"at": now, "by": user.annotator_id, "status": "withdrawn"})}

        kept = self.store.update_record(REQUESTS, request_key(user.annotator_id, rid), user.annotator_id, put)
        old = state["found"]
        if old is None:
            raise ApiError(404, "no_request", f"You have not asked for {rid} to be added to the training material")
        if old.get("status") not in ("pending", "withdrawn"):
            raise ApiError(409, "decided", "The study team has already decided on this request, so it cannot be "
                           "taken back")
        if old.get("status") == "pending":
            self._audit(user, "training_request_withdraw", f"{user.annotator_id} took back the request for {rid}",
                        recording_id=rid)
        return {"request": self.request_out(kept or old, self._set_names())}

    # ================================================================ the study team's operations
    def op_browse_access_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """Who may look through which dataset, and the experts who could be given one."""
        names = {d["dataset_id"]: d.get("name", "") for d in self.service.datasets.all_datasets()}
        experts = self._expert_ids()
        grants = sorted(({"dataset_id": g.get("dataset_id"), "dataset_name": names.get(g.get("dataset_id"), ""),
                          "annotator_id": g.get("annotator_id"),
                          "display_name": str((experts.get(g.get("annotator_id")) or {}).get("display_name") or ""),
                          "granted_at": g.get("granted_at") or None, "granted_by": g.get("granted_by") or None,
                          "still_expert": g.get("annotator_id") in experts}
                         for g in self.grants() if body.get("dataset_id") in (None, g.get("dataset_id"))),
                        key=lambda g: (str(g["dataset_id"]), str(g["annotator_id"])))
        return {"grants": grants,
                "experts": [{"annotator_id": a, "display_name": str(r.get("display_name") or "")}
                            for a, r in sorted(experts.items())]}

    def op_browse_access_set(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``{"dataset_id", "annotator_id", "access": bool}``: give an expert a dataset to look through, or take it
        back. The same choice again changes nothing."""
        from electrotag.web.admin import _aid

        ds = self.service.datasets.need_dataset(body.get("dataset_id"))
        did = ds["dataset_id"]
        aid = _aid(body.get("annotator_id"))
        access = body.get("access")
        if not isinstance(access, bool):
            raise _bad("access must be true (let them look through the dataset) or false (take it back)")
        if access and aid not in self._expert_ids():
            raise ApiError(409, "not_expert", f"{aid} is not one of the study's experts. Give them the expert role in "
                           "People first.")
        now = now_local_iso()
        changed = {"value": False}

        def put(old: dict[str, Any] | None) -> dict[str, Any] | None:
            if bool((old or {}).get("active")) == access:
                return None
            changed["value"] = True
            base = old or {"schema": "electrotag.browse_access", "schema_version": 1, "dataset_id": did,
                           "annotator_id": aid, "changes": []}
            entry = {"at": now, "by": user.annotator_id, "access": access}
            return {**base, "active": access, "granted_at": now if access else base.get("granted_at"),
                    "granted_by": user.annotator_id if access else base.get("granted_by"),
                    "changes": [*list(base.get("changes") or [])[-(HISTORY_KEPT - 1):], entry]}

        self.store.update_record(ACCESS, access_key(did, aid), aid, put)
        if changed["value"]:
            name = ds.get("name") or did
            self._audit(user, "browse_access_set",
                        f"Let {aid} look through the dataset {name} for training recordings" if access
                        else f"Took back {aid}'s access to look through the dataset {name}",
                        dataset_id=did, annotator_id=aid, access=access)
        return {**self.op_browse_access_list(user, {"dataset_id": did}), "changed": changed["value"]}

    def op_training_requests_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """Every expert's requests (``status`` to choose one kind), newest first, each with the expert's rating and the
        types of the marks they made while looking (never their notes, which are their own)."""
        status = body.get("status")
        if status is not None and status not in STATUSES:
            raise _bad(f"status must be one of {', '.join(STATUSES)}")
        names = self._set_names()
        datasets = {d["dataset_id"]: d.get("name", "") for d in self.service.datasets.all_datasets()}
        notes: dict[str, dict[str, dict[str, Any]]] = {}
        out = []
        for r in self._requests():
            if status is not None and r.get("status") != status:
                continue
            aid = str(r.get("annotator_id") or "")
            if aid not in notes:
                notes[aid] = self._notes(aid)
            n = self.notes_out(notes[aid].get(str(r.get("recording_id"))))
            out.append({**self.request_out(r, names), "dataset_name": datasets.get(r.get("dataset_id"), ""),
                        "rating_now": n["rating"], "n_annotations": n["n_annotations"], "labels": n["labels"]})
        out.sort(key=lambda r: str(r["requested_at"] or ""), reverse=True)
        counts = {s: 0 for s in STATUSES}
        for r in self._requests():
            counts[r.get("status", "pending")] = counts.get(r.get("status", "pending"), 0) + 1
        return {"requests": out, "counts": counts,
                "sets": [{"set_id": s, "name": n} for s, n in sorted(names.items(), key=lambda x: x[1].lower())]}

    def op_training_requests_decide(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``{"request_ids", "decision": "approve" | "decline", "set_id", "reason"}``: approve requests into a reference
        set (each recording then waits there, Awaiting annotation) or decline them. A request already decided the
        same way is left as it is."""
        ids = body.get("request_ids")
        if not isinstance(ids, list) or not ids or len(ids) > MAX_AT_ONCE or not all(isinstance(i, str) for i in ids):
            raise _bad(f"request_ids must be a list of 1 to {MAX_AT_ONCE} requests")
        decision = body.get("decision")
        if decision not in ("approve", "decline"):
            raise _bad("decision must be approve or decline")
        set_id = None
        if decision == "approve":
            set_id = body.get("set_id")
            if not isinstance(set_id, str) or not set_id:
                raise _bad("Choose the training set the recordings go into (set_id)")
            self.service.reference_set(set_id)  # 404 no_reference_set when there is none
        reason = body.get("reason") or ""
        if not isinstance(reason, str) or len(reason) > 1000:
            raise _bad("reason must be text of at most 1000 characters")
        by_id = {r.get("request_id"): r for r in self._requests()}
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise ApiError(404, "no_request", f"There is no request {missing[0]}")
        withdrawn = [by_id[i] for i in ids if by_id[i].get("status") == "withdrawn"]
        if withdrawn:
            w = withdrawn[0]
            raise ApiError(409, "withdrawn", f"{w.get('annotator_id')} took back the request for "
                           f"{w.get('file_name') or w.get('recording_id')}, so there is nothing to decide")
        status = "approved" if decision == "approve" else "declined"
        now = now_local_iso()
        done = []
        for i in dict.fromkeys(ids):
            r = by_id[i]

            def put(old: dict[str, Any] | None) -> dict[str, Any] | None:
                if old is None or (old.get("status") == status and old.get("set_id") == set_id):
                    return None
                return {**old, "status": status, "set_id": set_id, "decided_at": now, "decided_by": user.annotator_id,
                        "reason": reason.strip(), "history": _history(old, {"at": now, "by": user.annotator_id,
                                                                            "status": status, "set_id": set_id})}

            before = r.get("status"), r.get("set_id")
            self.store.update_record(REQUESTS, i, str(r.get("annotator_id")), put)
            if before != (status, set_id):
                done.append(r)
        if done:
            what = audit.count(len(done), "request")
            files = ", ".join(sorted({str(r.get("file_name") or r.get("recording_id")) for r in done})[:10])
            self._audit(user, "training_requests_decide",
                        f"Approved {what} into the training set {set_id}: {files}" if set_id
                        else f"Declined {what}: {files}", decision=decision, set_id=set_id,
                        request_ids=[r.get("request_id") for r in done],
                        recording_ids=sorted({str(r.get("recording_id")) for r in done}))
        return {"decided": len(done), **self.op_training_requests_list(user, {})}

    def waiting(self, set_id: str) -> list[dict[str, Any]]:
        """The recordings approved into a set that have no reference there yet, each with who asked for it."""
        rs = self.service.reference_set(set_id)
        held = set(rs.recordings)
        out: dict[str, dict[str, Any]] = {}
        for r in self._requests():
            if r.get("status") != "approved" or r.get("set_id") != set_id or r.get("recording_id") in held:
                continue
            rid = str(r.get("recording_id"))
            row = out.setdefault(rid, {"recording_id": rid, "file_name": r.get("file_name", ""),
                                       "dataset_id": r.get("dataset_id", ""), "requested_by": [], "ratings": {},
                                       "approved_at": r.get("decided_at"), "approved_by": r.get("decided_by"),
                                       "registered": self.store.manifest(SCOPE_STUDY, rid) is not None})
            row["requested_by"].append(r.get("annotator_id"))
            if r.get("rating") in RATINGS:
                row["ratings"][str(r.get("annotator_id"))] = r["rating"]
            if str(r.get("decided_at") or "") > str(row["approved_at"] or ""):
                row["approved_at"], row["approved_by"] = r.get("decided_at"), r.get("decided_by")
        for row in out.values():
            row["requested_by"].sort()
        return sorted(out.values(), key=lambda x: (str(x["file_name"]).lower(), x["recording_id"]))

    def op_training_waiting_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        set_id = body.get("set_id")
        if not isinstance(set_id, str) or not set_id:
            raise _bad("set_id is missing")
        return {"set_id": set_id, "waiting": self.waiting(set_id)}

    def op_training_waiting_remove(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``{"set_id", "recording_id"}``: take a recording off a set's list of those awaiting annotation (its
        requests are marked ``removed``; an expert may ask for it again)."""
        set_id = body.get("set_id")
        if not isinstance(set_id, str) or not set_id:
            raise _bad("set_id is missing")
        self.service.reference_set(set_id)
        rid = body.get("recording_id")
        if not isinstance(rid, str) or not rid:
            raise _bad("recording_id is missing")
        now = now_local_iso()
        hit = [r for r in self._requests() if r.get("status") == "approved" and r.get("set_id") == set_id
               and r.get("recording_id") == rid]
        for r in hit:
            def put(old: dict[str, Any] | None) -> dict[str, Any] | None:
                if old is None or old.get("status") != "approved" or old.get("set_id") != set_id:
                    return None
                return {**old, "status": "removed", "decided_at": now, "decided_by": user.annotator_id,
                        "history": _history(old, {"at": now, "by": user.annotator_id, "status": "removed",
                                                  "set_id": set_id})}

            self.store.update_record(REQUESTS, str(r.get("request_id")), str(r.get("annotator_id")), put)
        if hit:
            self._audit(user, "training_waiting_remove", f"Took {rid} off the recordings awaiting annotation in the "
                        f"training set {set_id}", set_id=set_id, recording_id=rid)
        return {"removed": bool(hit), **self.op_training_waiting_list(user, {"set_id": set_id})}


# ------------------------------------------------------------------ the expert area's operations
@expert_op("browse_datasets_list")
def browse_datasets_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The datasets the caller may look through for training recordings."""
    return service.candidates.datasets_list(user, body)


@expert_op("browse_recordings_list")
def browse_recordings_list(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """One dataset's recordings, with the caller's ratings, notes, marks and requests."""
    return service.candidates.recordings_list(user, body)


@expert_op("browse_recording_get")
def browse_recording_get(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """One recording to open and look at, with the caller's own marks, note and rating."""
    return service.candidates.recording_get(user, body)


@expert_op("browse_save")
def browse_save(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """The caller's own marks, note or rating on one recording (never exported or analysed)."""
    return service.candidates.save(user, body)


@expert_op("training_request")
def training_request(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Ask for recordings to be added to the training material."""
    return service.candidates.request(user, body)


@expert_op("training_request_withdraw")
def training_request_withdraw(service: StudyService, user: User, body: dict[str, Any]) -> dict[str, Any]:
    """Take back a request that waits for the study team's decision."""
    return service.candidates.withdraw(user, body)


__all__ = ["ACCESS", "NOTES", "RATINGS", "READS", "REQUESTS", "STATUSES", "WRITES", "Candidates", "access_key",
           "notes_key", "request_key"]
