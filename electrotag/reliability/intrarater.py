"""Intra-rater (test-retest) agreement, by annotator.

With ``comparison`` "within" (:mod:`electrotag.reliability.config`), the dataset holds each annotator's
ratings of a recording as raters of their own ("first rating", "repeat 1", ...) of the recording
"<recording> · <annotator>" (:func:`electrotag.reliability.data._by_comparison`), so the usual tables compare
one person's ratings with each other and pool those pairs over everyone. This measure adds
``intrarater_by_annotator``: the same comparisons pooled over each annotator's recordings on their own, so
that the study team sees how consistent each person is, beside the study's overall figure.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from electrotag.reliability.config import ANY_ARTIFACT, AnalysisConfig
from electrotag.reliability.data import AgreementDataset
from electrotag.reliability.matching import event_agreement
from electrotag.reliability.timeresolved import time_resolved_agreement

POOLED = "ALL (pooled)"
SEPARATOR = " · "

INTRARATER_COLUMNS = ["annotator", "category", "rater_1", "rater_2", "n_recordings", "cohen_kappa",
                        "positive_agreement", "proportion_agreement", "event_f1", "event_threshold"]


def annotator_of(recording: str) -> str:
    """The annotator of a within-annotator recording ("<recording> · <annotator>")."""
    return recording.rsplit(SEPARATOR, 1)[-1] if SEPARATOR in recording else ""


def intrarater_measure(ds: AgreementDataset, cfg: AnalysisConfig) -> dict[str, list[dict[str, Any]]]:
    """``intrarater_by_annotator``: each annotator's ratings compared with each other, pooled over their
    recordings: the time-resolved agreement (exact, time only) and the event F1 at the main threshold."""
    if cfg.comparison != "within":
        return {"by_annotator": []}
    people = sorted({annotator_of(rid) for rid in ds.groups if annotator_of(rid)})
    # The figures by annotator are made with time only, whatever the channel modes chosen.
    one = replace(cfg, channel_modes=("time_only",))
    rows: list[dict[str, Any]] = []
    for person in people:
        groups = {rid: g for rid, g in ds.groups.items() if annotator_of(rid) == person and len(g.docs) >= 2}
        if not groups:
            continue
        mine = replace(ds, groups=groups, warnings=[])
        times = [r for r in time_resolved_agreement(mine, one)["pairwise"]
                 if r["recording"] == POOLED and r["representation"] == "exact" and r["channel_mode"] == "time_only"]
        events = {(r["category"], r["reference"], r["compared"]): r for r in event_agreement(mine, one)["summary"]
                  if r["threshold"] == one.primary_iou_threshold or one.match_criterion == "tolerance"}
        for t in times:
            if t["category"] != ANY_ARTIFACT and not (t.get("both") or t.get("only_1") or t.get("only_2")):
                continue  # a type this person never marked in these ratings
            e = events.get((t["category"], t["rater_1"], t["rater_2"])) or {}
            rows.append({"annotator": person, "category": t["category"], "rater_1": t["rater_1"],
                         "rater_2": t["rater_2"], "n_recordings": t.get("n_recordings"),
                         "cohen_kappa": t.get("cohen_kappa"), "positive_agreement": t.get("positive_agreement"),
                         "proportion_agreement": t.get("proportion_agreement"), "event_f1": e.get("f1"),
                         "event_threshold": e.get("threshold")})
    return {"by_annotator": rows}


__all__ = ["INTRARATER_COLUMNS", "annotator_of", "intrarater_measure"]
