"""One person's saved work on one recording, from the admin area's lists of a person's work (docs/api.md,
"Saved work: download and withdraw"; docs/admin_area.md, "Results").

* ``saved_work_get``: every saved version's files, as the annotator's own download gives the latest
  (``my_files`` in :mod:`electrotag.web.service`), for the browser to put in one zip.
* ``saved_work_withdraw``: takes every saved version of a study recording out of the results, the lists, the
  analyses and the exports (``Store.withdraw_saved`` keeps them aside), and either gives the recording back to
  the person to annotate again or takes it off their list. Work that a correction or an adjudication was built
  on stays (409 ``has_derived``), as does training work (400 ``not_study_work``). Work saved before the
  results were last downloaded as a whole (the results zip, ``GET /admin/results.zip`` or
  ``electrotag web export``) is withdrawn only once the request says ``downloaded_ok`` (409 ``downloaded``),
  because a copy of it is already outside the study.
* ``withdrawals_list`` and ``saved_work_restore``: the work withdrawn, and putting it back as it was.

Every withdrawal and restoration is in the audit log.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.store import StoreError, User, attempt_of
from electrotag.web.errors import ApiError

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: The audit entries of a download of the whole results: the results zip from the admin area (with or without
#: the names and contacts), the zip from ``GET /admin/results.zip`` and ``electrotag web export``.
DOWNLOAD_OPS = ("results_zip", "results_zip_contacts", "results_export")
#: What happens to the recording in the person's list once their work is withdrawn.
THEN = {"todo": "given back to annotate again", "unassign": "taken off their list"}
READS = ("saved_work_get", "withdrawals_list")
WRITES = ("saved_work_withdraw", "saved_work_restore")


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _when(text: Any) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.astimezone()


class Withdrawals:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    # ------------------------------------------------------------ the request
    def _item(self, body: dict[str, Any]) -> tuple[str, str, str, str]:
        aid = body.get("annotator_id")
        if not isinstance(aid, str) or not aid.strip():
            raise _bad("Give annotator_id")
        aid = aid.strip().upper()
        rid = body.get("recording_id")
        if not isinstance(rid, str) or not rid.strip() or len(rid) > 500:
            raise _bad("Give recording_id")
        mode = body.get("mode") or "standard"
        if mode not in ("standard", "guided", "practice", "assessment"):
            raise _bad("mode is standard, guided, practice or assessment")
        ctx = str(body.get("context_id") or "") if mode != "standard" else ""
        return aid, rid.strip(), mode, ctx

    def _entries(self, aid: str, rid: str, mode: str, ctx: str) -> list[dict[str, str]]:
        return sorted((e for e in self.store.completion_entries(aid)
                       if e.get("recording_id") == rid and e.get("mode", "standard") == mode
                       and e.get("context", "") == ctx and e.get("status") == "completed"), key=attempt_of)

    # ------------------------------------------------------------ downloading
    def op_saved_work_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid, rid, mode, ctx = self._item(body)
        versions = []
        for e in self._entries(aid, rid, mode, ctx):
            n = attempt_of(e)
            files = self.store.saved_files(aid, rid, mode, ctx, n)
            versions.append({"version": n, "saved_at": e.get("completed_at", ""),
                             "folder": str(e.get("output_basename") or f"version-{n}"),
                             "files": [{"name": k, "text": files[k].decode("utf-8")} for k in sorted(files)]})
        if not versions:
            raise ApiError(404, "not_saved", f"{aid} has no saved annotations of {rid}.")
        stem = rid.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        return {"annotator_id": aid, "recording_id": rid, "mode": mode, "context_id": ctx,
                "file_name": f"{stem}_{aid}_saved.zip", "versions": versions}

    # ------------------------------------------------------------ withdrawing
    def _built_on(self, aid: str, rid: str, mode: str, ctx: str) -> list[str]:
        """What was built on the person's work on this recording: corrections and adjudications."""
        out = []
        corrections = [r for r in self.store.records("corrections", aid)
                       if r.get("recording_id") == rid and (r.get("mode") or "standard") == mode
                       and str(r.get("context_id") or "") == ctx]
        if corrections:
            out.append("an expert's correction of it")
        if any(r.get("recording_id") == rid and aid in (r.get("inputs") or {})
               for r in self.store.records("adjudications")):
            out.append("an adjudication of the recording")
        return out

    def last_download_after(self, since: datetime) -> dict[str, Any] | None:
        """The latest download of the whole results made after ``since``, from the audit log, or None."""
        before = None
        while True:
            entries, before = self.store.audit_page(before, 200)
            for e in entries:
                at = _when(e.get("at"))
                if at is not None and at <= since:
                    return None
                if e.get("op") in DOWNLOAD_OPS:
                    return e
            if not before or not entries:
                return None

    def op_saved_work_withdraw(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid, rid, mode, ctx = self._item(body)
        then = body.get("then")
        if then not in THEN:
            raise _bad("then is todo (to annotate it again) or unassign (to take it off their list)")
        if mode != "standard":
            raise _bad("Only the work of study recordings can be withdrawn; training work stays with the training "
                       "programme.", "not_study_work")
        entries = self._entries(aid, rid, mode, ctx)
        if not entries:
            raise ApiError(404, "not_saved", f"{aid} has no saved annotations of {rid}.")
        built = self._built_on(aid, rid, mode, ctx)
        if built:
            raise ApiError(409, "has_derived", f"{aid}'s work on {rid} stays: {' and '.join(built)} was made from it. "
                           "Remove that first in the expert area.")
        assignment = next((a for a in self.store.assignments(aid) if a.recording_id == rid
                           and a.mode == mode and a.context_id == ctx), None)
        if then == "unassign" and assignment is not None and getattr(assignment, "task_id", ""):
            raise ApiError(409, "in_task", f"{rid} came to {aid} through a task, so it stays on their list: give it "
                           "back to annotate again, or take them out of the task under Tasks.")
        earliest = min((d for d in (_when(e.get("completed_at")) for e in entries) if d is not None), default=None)
        download = self.last_download_after(earliest) if earliest is not None else None
        if download is not None and body.get("downloaded_ok") is not True:
            raise ApiError(409, "downloaded", f"The results were downloaded on {download.get('at', '')[:16]} "
                           f"(by {download.get('by', '')}) after {aid} saved this work, so a copy of it is "
                           "outside the study already. Withdrawing it here leaves that copy as it is.",
                           downloaded_at=download.get("at"), downloaded_by=download.get("by"))
        record = {"withdrawal_id": uuid.uuid4().hex, "annotator_id": aid, "recording_id": rid, "mode": mode,
                  "context_id": ctx, "then": then, "withdrawn_at": now_local_iso(), "withdrawn_by": user.annotator_id,
                  "downloaded_before": download.get("at") if download else None}
        kept = self.store.withdraw_saved(aid, rid, mode, ctx, record)
        if kept is None:
            raise ApiError(404, "not_saved", f"{aid} has no saved annotations of {rid}.")
        if then == "unassign":
            self.store.unassign_item(aid, rid, mode, ctx)
        n = len(kept.get("versions", []))
        audit.record(self.store, user.annotator_id, "saved_work_withdraw",
                     f"Withdrew {aid}'s saved work on {rid} ({audit.count(n, 'version')}); the recording was "
                     f"{THEN[then]}" + (" (the results had been downloaded since it was saved)" if download else ""),
                     {"withdrawal_id": record["withdrawal_id"], "annotator_id": aid, "recording_id": rid,
                      "then": then, "versions": [attempt_of(e) for e in kept.get("versions", [])],
                      "downloaded_before": record["downloaded_before"]})
        return {"withdrawal": self._public(kept)}

    # ------------------------------------------------------------ the list and restoring
    @staticmethod
    def _public(rec: dict[str, Any]) -> dict[str, Any]:
        versions = rec.get("versions", [])
        return {k: rec.get(k) for k in ("withdrawal_id", "annotator_id", "recording_id", "mode", "context_id", "then",
                                        "withdrawn_at", "withdrawn_by", "downloaded_before")} | {
            "versions": [{"version": attempt_of(e), "saved_at": e.get("completed_at", "")} for e in versions]}

    def op_withdrawals_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        aid = body.get("annotator_id")
        if aid is not None and (not isinstance(aid, str) or not aid.strip()):
            raise _bad("annotator_id is an annotator's ID")
        rows = [self._public(r) for r in self.store.withdrawals(aid.strip().upper() if aid else None)]
        rows.sort(key=lambda r: str(r.get("withdrawn_at") or ""), reverse=True)
        return {"withdrawals": rows}

    def op_saved_work_restore(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        wid = body.get("withdrawal_id")
        if not isinstance(wid, str) or not wid:
            raise _bad("Give withdrawal_id")
        rec = next((r for r in self.store.withdrawals() if r.get("withdrawal_id") == wid), None)
        if rec is None:
            raise ApiError(404, "no_withdrawal", "There is no withdrawn work with that ID; it may have been restored.")
        aid, rid, mode, ctx = rec["annotator_id"], rec["recording_id"], rec.get("mode", "standard"), \
            rec.get("context_id", "")
        if self._entries(aid, rid, mode, ctx):
            raise ApiError(409, "saved_again", f"{aid} has saved {rid} again since it was withdrawn, so the withdrawn "
                           "work stays aside. Withdraw the new work first to put the earlier work back.")
        try:
            kept = self.store.restore_withdrawn(wid)
        except StoreError as exc:
            raise ApiError(409, "saved_again", str(exc)) from exc
        if kept is None:
            raise ApiError(404, "no_withdrawal", "There is no withdrawn work with that ID; it may have been restored.")
        mine = self.store.assignments(aid)
        if not any(a.recording_id == rid and a.mode == mode and a.context_id == ctx for a in mine):
            self.store.assign(aid, [rid], mode=mode, context_id=ctx)  # back on their list, as done
        audit.record(self.store, user.annotator_id, "saved_work_restore",
                     f"Restored {aid}'s saved work on {rid} ({audit.count(len(kept.get('versions', [])), 'version')}), "
                     f"withdrawn by {rec.get('withdrawn_by', '')}",
                     {"withdrawal_id": wid, "annotator_id": aid, "recording_id": rid})
        return {"withdrawal": self._public(kept)}
