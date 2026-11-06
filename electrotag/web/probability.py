"""The probability maps of the admin area (docs/admin_area.md, "Probability maps"; docs/api.md, "Probability
maps"; the calculation is :mod:`electrotag.reliability.probability`).

The raters of a recording are everyone's latest saved version of it as study work (``standard`` mode, as the
overlay of everyone's marks reads them), and, where the recording is in a reference set, each expert whose own
annotations of it were kept with the reference (its source files: the expert's file of a single-expert
reference, the experts' files of a consensus or of an adjudication). Training work, corrected versions and the
adjudicated version are left out. A person who both saved the recording and gave an expert file of it counts
once, with their saved work.

* ``probability_get`` (a read): what the browser needs to draw the map of one recording and weigh it as the
  administrator chooses, without asking again: the raters with their marks (in the overlay's compact form),
  their answers to the questionnaire's single-choice questions as they stood when they saved the recording,
  and the questions.
* ``probability_export`` (a read): the maps of every recording with enough raters (or those named), worked out
  here with the weights given, as a zip of one TSV a recording and ``probability.json``, which records the
  weights, the raters and their weights, and flags a recording with only two raters as a small sample.

Administrators only: annotators and experts never see them, so that what others marked cannot sway them.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from electrotag import __version__
from electrotag.app.common import now_local_iso
from electrotag.reliability.probability import (
    ANY,
    COLUMNS,
    MIN_RATERS,
    Mark,
    Rater,
    Weights,
    WeightsError,
    rater_weight,
    runs,
    tsv_rows,
    tsv_text,
)
from electrotag.web.errors import ApiError
from electrotag.web.manifest import SCOPE_STUDY, set_scope

if TYPE_CHECKING:
    from electrotag.web.service import StudyService
    from electrotag.web.store import User

READS = ("probability_get", "probability_export")
#: The largest zip of maps returned in one answer, as for the results zip.
MAX_ZIP_BYTES = 25_000_000
#: Every type that someone marked, each with a map of its own (and ``any``).
CATEGORY_EACH = "each"


def _bad(message: str, code: str = "bad_request") -> ApiError:
    return ApiError(400, code, message)


def _min_raters(body: dict[str, Any]) -> int:
    v = body.get("min_raters", MIN_RATERS)
    if isinstance(v, bool) or not isinstance(v, int) or v < MIN_RATERS or v > 10_000:
        raise _bad(f"min_raters is a whole number of {MIN_RATERS} or more: a map needs at least two raters")
    return v


def _weights(body: dict[str, Any]) -> Weights:
    try:
        return Weights.from_dict(body.get("weights"))
    except WeightsError as exc:
        raise _bad(str(exc)) from exc


def _as_mark(m: tuple[Any, ...]) -> Mark:
    _id, label, onset, dur, channels, conf = m
    return Mark(label=label, onset=int(onset), duration=int(dur), channels=tuple(channels),
                confidence=int(conf) if conf else None)


class Probability:
    def __init__(self, service: StudyService) -> None:
        self.service = service

    @property
    def store(self) -> Any:
        return self.service.store

    # ------------------------------------------------------------ the questionnaire
    def questions(self) -> list[dict[str, Any]]:
        """The questionnaire's single-choice questions, whose answers can weigh raters."""
        from electrotag.web.questionnaire import PREFER_NOT, PREFER_NOT_LABEL

        out = []
        for q in self.service.questionnaire.questions():
            if q.get("type") != "choice":
                continue
            options = [{"value": str(o), "label": str(o)} for o in q.get("options") or []]
            out.append({"id": q["id"], "text": q.get("text", ""),
                        "options": options + [{"value": PREFER_NOT, "label": PREFER_NOT_LABEL}]})
        return out

    def _answers(self, records: dict[str, Any], aid: str, when: str | None) -> dict[str, str]:
        from electrotag.web.questionnaire import answers_at

        entry, _later = answers_at(records.get(aid), when or "")
        given = (entry or {}).get("answers") or {}
        return {str(k): v for k, v in given.items() if isinstance(v, str)}

    # ------------------------------------------------------------ the raters
    def _expert_sources(self, rid: str, scope: str) -> list[dict[str, Any]]:
        """The experts' own files of the recording kept with the references of every set that holds it here."""
        from electrotag.web.corrections import wire_annotations
        from electrotag.web.overlay import _marks_of

        out: list[dict[str, Any]] = []
        for rs in self.store.reference_sets():
            if rid not in rs.recordings or (set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY) != scope:
                continue
            prov = rs.recordings[rid].get("provenance") or {}
            experts = {str(e).upper() for e in prov.get("experts") or []}
            adjudicator = str(prov.get("adjudicator") or "").upper()
            for src in prov.get("sources") or []:
                path = Path(rs.directory) / str(src.get("file") or "")
                if path.suffix.lower() != ".json" or not path.is_file():
                    continue
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if not isinstance(raw, dict) or not isinstance(raw.get("annotations"), list):
                    continue  # a disagreements file, or anything else that is not one person's annotations
                who = str((raw.get("annotator") or {}).get("annotator_id") or "").upper()
                if who not in experts or who == adjudicator:
                    continue
                out.append({"annotator_id": who, "source": "expert", "set_id": rs.set_id,
                            "saved_at": prov.get("added_at") or None, "marks": _marks_of(wire_annotations(raw))})
        return out

    def raters(self, rid: str, scope: str) -> list[dict[str, Any]]:
        """Each rater of the recording once: study work first, then experts' files."""
        from electrotag.web.overlay import _saved_people

        out: dict[str, dict[str, Any]] = {}
        if scope == SCOPE_STUDY:
            for p in _saved_people(self.service, rid, "standard", ""):
                out[p["annotator_id"]] = {"annotator_id": p["annotator_id"], "source": "study", "set_id": None,
                                          "saved_at": p.get("saved_at"), "marks": p["marks"]}
        for p in self._expert_sources(rid, scope):
            out.setdefault(p["annotator_id"], p)
        return [out[k] for k in sorted(out)]

    def _recording(self, body: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
        from electrotag.web.admin import _rid

        rid = _rid(body.get("recording_id"))
        set_id = body.get("set_id")
        scope = SCOPE_STUDY
        if set_id:
            rs = self.service.reference_set(str(set_id))
            scope = set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY
        m = self.store.manifest(scope, rid)
        if m is None:
            raise ApiError(404, "unknown_recording", f"{rid} is not a registered recording of this study")
        return rid, scope, m

    # ------------------------------------------------------------ one recording, for the browser
    def op_probability_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.manifest import manifest_info
        from electrotag.web.overlay import _Tables
        from electrotag.web.questionnaire import ANSWERS_KIND

        rid, scope, m = self._recording(body)
        info = manifest_info(m)
        names = list(info.ch_names)
        tables = _Tables(names)
        records = {str(r.get("annotator_id")): r for r in self.store.records(ANSWERS_KIND)}
        people = []
        for p in self.raters(rid, scope):
            people.append({"annotator_id": p["annotator_id"], "source": p["source"], "set_id": p["set_id"],
                           "saved_at": p["saved_at"],
                           "answers": self._answers(records, p["annotator_id"], p["saved_at"]),
                           "marks": tables.flat(p["marks"])})
        return {"recording_id": rid, "scope": scope, "file_name": rid.rsplit("/", 1)[-1],
                "sfreq": info.timing.sfreq, "n_samples": info.timing.n_samples, "channels": names,
                "labels": tables.labels, "sets": tables.sets, "people": people, "questions": self.questions(),
                "min_raters": MIN_RATERS}

    # ------------------------------------------------------------ every recording, as files
    def _recordings(self, body: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
        """(recording, scope, manifest): those named, or every study recording and every set's own recording."""
        named = body.get("recording_ids")
        if named is not None:
            if not isinstance(named, list) or not all(isinstance(r, str) and r for r in named):
                raise _bad("recording_ids is a list of recording IDs")
            out = []
            for rid in named:
                got = self._recording({"recording_id": rid, "set_id": body.get("set_id")})
                out.append(got)
            return out
        scopes = {SCOPE_STUDY} | {set_scope(rs.set_id) for rs in self.store.reference_sets() if rs.self_contained}
        return sorted(((m["recording_id"], m["scope"], m) for m in self.store.manifests() if m.get("scope") in scopes),
                      key=lambda x: (x[1] != SCOPE_STUDY, x[1], x[0]))

    def op_probability_export(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.manifest import manifest_info
        from electrotag.web.questionnaire import ANSWERS_KIND

        weights = _weights(body)
        least = _min_raters(body)
        category = body.get("category") or ANY
        if not isinstance(category, str) or (category not in (ANY, CATEGORY_EACH)
                                             and category not in self.store.catalogue.label_names):
            raise _bad("category is any, each, or a HED-SCORE type of the study's catalogue")
        by_channel = body.get("by_channel", False)
        if not isinstance(by_channel, bool):
            raise _bad("by_channel is true or false")
        records = {str(r.get("annotator_id")): r for r in self.store.records(ANSWERS_KIND)}
        files: dict[str, str] = {}
        listed: dict[str, Any] = {}
        too_few: list[str] = []
        for rid, scope, m in self._recordings(body):
            people = self.raters(rid, scope)
            if len(people) < least:
                too_few.append(rid)
                continue
            info = manifest_info(m)
            names = list(info.ch_names)
            raters = [Rater(p["annotator_id"], [_as_mark(x) for x in p["marks"]],
                            rater_weight(self._answers(records, p["annotator_id"], p["saved_at"]), weights),
                            p["source"])
                      for p in people]
            cats = [ANY] if category == ANY else [category] if category != CATEGORY_EACH else \
                [ANY, *sorted({mk.label for r in raters for mk in r.marks})]
            blocks = []
            for c in cats:
                blocks.append((c, None, runs(raters, info.timing.n_samples, weights, category=c)))
                if by_channel:
                    blocks += [(c, ch, runs(raters, info.timing.n_samples, weights, category=c, channel=ch))
                               for ch in names]
            name = _file_name(rid, scope)
            files[name] = tsv_text(tsv_rows(blocks, info.timing.sfreq, len(raters)))
            listed[name] = {"recording_id": rid, "scope": scope, "sfreq": info.timing.sfreq,
                            "n_samples": info.timing.n_samples, "n_raters": len(raters),
                            "low_sample": len(raters) == MIN_RATERS, "categories": cats,
                            "channels": names if by_channel else [],
                            "raters": [{"annotator_id": r.annotator_id, "source": r.source, "weight": r.weight}
                                       for r in raters]}
        as_tsv = body.get("as") == "tsv"
        if body.get("as") not in (None, "zip", "tsv"):
            raise _bad("as is zip (the default) or tsv (one recording's map)")
        if as_tsv and (body.get("recording_ids") is None or len(body["recording_ids"]) != 1):
            raise _bad("as tsv gives one recording's map: name exactly one in recording_ids")
        if as_tsv and files:
            (name, text), = files.items()
            meta = listed[name]
            return {"file_name": name, "text": text, "recordings": 1, "left_out": [],
                    "low_sample": [meta["recording_id"]] if meta["low_sample"] else [],
                    "raters": meta["raters"], "weights": weights.to_dict()}
        if not files:
            raise ApiError(404, "no_maps", f"No recording has the {least} raters a map needs"
                           + (" among those named." if body.get("recording_ids") is not None else "."))
        settings = {"made_at": now_local_iso(), "made_by": user.annotator_id, "electrotag_version": __version__,
                    "weights": weights.to_dict(), "category": category, "by_channel": by_channel,
                    "min_raters": least, "columns": list(COLUMNS), "recordings": listed,
                    "left_out_too_few_raters": too_few}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("probability/README.txt", README)
            z.writestr("probability/probability.json", json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
            for name, text in sorted(files.items()):
                z.writestr(f"probability/{name}", text)
        data = buf.getvalue()
        if len(data) > MAX_ZIP_BYTES:
            raise ApiError(413, "too_large", f"The maps take {len(data):,} bytes, more than one download holds: "
                           "choose fewer recordings, one category or no breakdown by channel", size_bytes=len(data))
        return {"file_name": "probability_maps.zip", "base64": base64.b64encode(data).decode("ascii"),
                "size_bytes": len(data), "recordings": len(files), "left_out": too_few,
                "low_sample": sorted(r["recording_id"] for r in listed.values() if r["low_sample"])}


def _file_name(rid: str, scope: str) -> str:
    base = rid.replace("/", "__")
    base = base.removesuffix(".vhdr") if base.endswith(".vhdr") else base.replace(".", "_")
    prefix = "" if scope == SCOPE_STUDY else scope.replace(":", "-") + "__"
    return f"{prefix}{base}_probability.tsv"


README = """Probability maps made by ElectroTag (docs/reliability_guide.md, "Probability maps").

Each TSV is one recording's map: the weighted share of its raters who marked each sample as an artifact,
as runs of samples with one value (end_sample not included), from sample 0 to the end of the recording,
for each category ("any" for every mark, or a HED-SCORE type) and, when asked for, each channel
("n/a" is the recording as a whole). probability.json records the weights, the raters and their weights;
a recording with only two raters is marked low_sample.

With MNE-Python and ElectroTag installed:

    import mne
    from electrotag.reliability.probability import probability_array
    raw = mne.io.read_raw("sub-01_task-rest_eeg.vhdr")
    p = probability_array("sub-01_task-rest_eeg_probability.tsv", "any", n_samples=raw.n_times)
    # p[i] is the probability at the sample of raw.get_data()[:, i]; NaN where every rater weighs 0.
"""
