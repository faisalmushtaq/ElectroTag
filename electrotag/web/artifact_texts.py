"""The study's own words for its artifact types (docs/admin_area.md, "Artifact type descriptions").

Experts and administrators may change, for each type of the catalogue, its short description (the HED-SCORE
definition the catalogue gives, shown on the type buttons, in the type picker, in training and in the artifact
reference guide) and every written part of its entry in the guide: where it shows on the scalp, its frequency, its
shape, its duration and how to tell it from its look-alikes. The example pictures stay as they are. Each type's
changes are one record of the kind ``artifact_texts`` (its ID the label), and a field left out or set back to
null shows the original again. ``GET /me``'s catalogue carries the changes: the description in place of the
original, and the guide's words under ``guide``.

* ``artifact_texts_list {}`` → ``{"texts": {label: {"fields", "changed_at", "changed_by"}},
  "original": {label: description}}``
* ``artifact_text_set {label, fields: {name: text | null}}`` → ``{"label", "text"}``, audited

Both are admin operations that experts may use as well (electrotag/web/admin.py EXPERT_OPERATIONS).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.store import User

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

KIND = "artifact_texts"
#: The written fields: the catalogue's description, then the guide's (js/guide/artifacts.js GUIDE).
TEXT_FIELDS = ("description", "where", "frequency", "shape", "duration")
GUIDE_FIELDS = TEXT_FIELDS[1:] + ("apart",)
MAX_TEXT = 2000
MAX_APART = 12


def _bad(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


class ArtifactTexts:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    def changes(self) -> dict[str, dict[str, Any]]:
        """label -> the fields changed (only those with words of the study's own)."""
        out = {}
        for rec in self.store.records(KIND):
            fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
            if rec.get("label") and fields:
                out[str(rec["label"])] = fields
        return out

    def apply(self, labels: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The catalogue's labels (``GET /me``) with the study's words: its description, and ``guide`` for the
        guide's fields that were changed."""
        changes = self.changes()
        if not changes:
            return labels
        out = []
        for lab in labels:
            ch = changes.get(lab["label"])
            if not ch:
                out.append(lab)
                continue
            new = dict(lab)
            if isinstance(ch.get("description"), str):
                new["description"] = ch["description"]
            guide = {k: ch[k] for k in GUIDE_FIELDS if k in ch}
            if guide:
                new["guide"] = guide
            out.append(new)
        return out

    def list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        texts = {}
        for rec in self.store.records(KIND):
            fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
            if rec.get("label") and fields:
                texts[str(rec["label"])] = {"fields": fields, "changed_at": rec.get("changed_at") or None,
                                            "changed_by": rec.get("changed_by") or None}
        # the catalogue's own descriptions, to show and to go back to (the guide's are in the browser's guide)
        original = {lab.label: lab.description for lab in self.store.catalogue.labels}
        return {"texts": texts, "original": original}

    def set(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        cat = self.store.catalogue
        label = body.get("label")
        if not isinstance(label, str) or not cat.is_permitted(label):
            raise _bad("label must be one of the study's artifact types")
        fields = body.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise _bad("fields must name at least one of description, where, frequency, shape, duration or apart")
        clean: dict[str, Any] = {}
        for name, value in fields.items():
            if name in TEXT_FIELDS:
                if value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT):
                    raise _bad(f"{name} must be text of at most {MAX_TEXT} characters, or null for the original")
                clean[name] = value.strip() if isinstance(value, str) else None
                if name == "description" and clean[name] == "":
                    raise _bad("The description cannot be empty: write the study's own words, or set it back to the "
                               "original")
            elif name == "apart":
                if value is not None:
                    if not isinstance(value, list) or len(value) > MAX_APART:
                        raise _bad(f"apart must be a list of at most {MAX_APART} look-alikes, or null for the original")
                    rows = []
                    for row in value:
                        if (not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], str)
                                or not cat.is_permitted(row[0]) or not isinstance(row[1], str)
                                or not row[1].strip() or len(row[1]) > MAX_TEXT):
                            raise _bad("each look-alike is [an artifact type of the study, how to tell them apart]")
                        rows.append([row[0], row[1].strip()])
                    value = rows
                clean[name] = value
            else:
                raise _bad(f"{name} is not a text of an artifact type: description, where, frequency, shape, duration "
                           "or apart")
        now = now_local_iso()
        changed: list[str] = []

        def change(old: dict[str, Any] | None) -> dict[str, Any] | None:
            kept = dict((old or {}).get("fields") or {})
            for name, value in clean.items():
                if value is None:
                    if name in kept:
                        kept.pop(name)
                        changed.append(name)
                elif kept.get(name) != value:
                    kept[name] = value
                    changed.append(name)
            if not changed:
                return None
            return {"label": label, "fields": kept, "changed_at": now, "changed_by": user.annotator_id}

        rec = self.store.update_record(KIND, label, "", change)
        if changed:
            back = [n for n in changed if clean.get(n) is None]
            words = [n for n in changed if n not in back]
            summary = f"Changed the texts of {label}: " + ", ".join(
                ([f"{', '.join(words)} in the study's own words"] if words else [])
                + ([f"{', '.join(back)} back to the original"] if back else []))
            audit.record(self.store, user.annotator_id, "artifact_text_set", summary,
                         {"label": label, "changed": changed, "original": back,
                          "fields": {n: clean[n] for n in words}})
        fields_kept = (rec or {}).get("fields") or {}
        return {"label": label, "text": ({"fields": fields_kept, "changed_at": rec.get("changed_at"),
                                          "changed_by": rec.get("changed_by")} if rec and fields_kept else None)}
