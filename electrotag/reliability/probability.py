"""The probability map of several raters' marks on one recording (docs/reliability_guide.md, "Probability maps").

At every sample, each rater either marked an artifact there or did not. The map is the weighted share of the
raters who marked it::

    p(t) = sum_r w_r * c_r(t) * m_r(t) / sum_r w_r * c_r(t)

where ``m_r(t)`` is 1 when rater r marked sample t and 0 when they did not, ``w_r`` is the rater's weight (the
product of the weights of their questionnaire answers chosen for the map, see :func:`rater_weight`) and
``c_r(t)`` the weight of their confidence there: the weight of the confidence they gave the mark (by default
1 to 5 count 20 %, 40 %, 60 %, 80 % and 100 %), full weight for a mark without a confidence, and full weight
for time they left unmarked, which counts as their judgement that there is no artifact. A rater who is not
confident therefore counts for less at that moment, in the denominator as in the numerator. Where a rater's
marks overlap, the most confident of them counts.

The map is exact: it changes only where some rater's mark begins or ends, so it is written as **runs** of
samples with one value each (:class:`Run`), from sample 0 to the end of the recording. ``category`` chooses
the marks: ``any`` for every mark, or one HED-SCORE label. ``channel`` breaks it down: ``None`` for the
recording as a whole (any mark on any channel), or a channel's name, which a mark counts for when it names
that channel or is on the whole montage.

The browser draws the same map (js/expert/probability.js), and web_tests/unit/ui_probability.test.mjs checks
that both give the same runs. :func:`probability_array` reads a map written as TSV into a NumPy array of one
value per sample, aligned with the recording's data as MNE-Python reads it (sample 0 is the first sample of
the file).
"""

from __future__ import annotations

import csv
import io
import math
from collections.abc import Iterable, Mapping
from itertools import pairwise
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Every mark, whatever its type.
ANY = "any"
#: The weights of confidence 1 to 5 by default.
CONFIDENCE_DEFAULT = (0.2, 0.4, 0.6, 0.8, 1.0)
#: The fewest raters a map is made from; a map from exactly this many is flagged as a small sample.
MIN_RATERS = 2
#: The columns of a map's TSV, in order.
COLUMNS = ("category", "channel", "start_sample", "end_sample", "onset", "duration", "probability", "n_raters",
           "n_marked", "weight_total", "weight_marked")
#: The largest weight of an answer (the admin area offers 0 to 1).
MAX_WEIGHT = 10.0


class WeightsError(ValueError):
    """Weights that cannot be used, in plain words."""


def _weight(value: Any, what: str, hi: float = MAX_WEIGHT) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or not 0 <= value <= hi:
        raise WeightsError(f"{what} must be a number from 0 to {hi:g}")
    return float(value)


@dataclass(frozen=True)
class Weights:
    """How raters and their marks are weighed: ``confidence`` the weights of confidence 1 to 5 (0 to 1 each);
    ``questions`` for each questionnaire question used, the weight of each answer (an answer left out, or a
    rater without an answer to that question, weighs ``no_answer``)."""

    confidence: tuple[float, ...] = CONFIDENCE_DEFAULT
    questions: Mapping[str, Mapping[str, float]] = field(default_factory=dict)
    no_answer: float = 1.0

    @classmethod
    def from_dict(cls, d: Any) -> Weights:
        if d is None:
            return cls()
        if not isinstance(d, dict):
            raise WeightsError("weights must be an object with confidence, questions and no_answer")
        unknown = set(d) - {"confidence", "questions", "no_answer"}
        if unknown:
            raise WeightsError(f"weights has no setting {sorted(unknown)[0]!r}")
        conf = d.get("confidence", list(CONFIDENCE_DEFAULT))
        if not isinstance(conf, (list, tuple)) or len(conf) != 5:
            raise WeightsError("confidence must give the weights of confidence 1 to 5, five numbers from 0 to 1")
        conf_t = tuple(_weight(x, f"The weight of confidence {i + 1}", 1.0) for i, x in enumerate(conf))
        qs = d.get("questions") or {}
        if not isinstance(qs, dict):
            raise WeightsError("questions must be an object: for each question, the weight of each answer")
        questions: dict[str, dict[str, float]] = {}
        for qid, answers in qs.items():
            if not isinstance(answers, dict):
                raise WeightsError(f"The weights of the answers to {qid!r} must be an object")
            questions[str(qid)] = {str(a): _weight(w, f"The weight of the answer {a!r} to {qid!r}")
                                   for a, w in answers.items()}
        return cls(confidence=conf_t, questions=questions,
                   no_answer=_weight(d.get("no_answer", 1.0), "The weight of no answer"))

    def to_dict(self) -> dict[str, Any]:
        return {"confidence": list(self.confidence),
                "questions": {q: dict(a) for q, a in sorted(self.questions.items())}, "no_answer": self.no_answer}

    def of_confidence(self, confidence: int | None) -> float:
        """A mark's weight for its confidence: full weight when it has none."""
        if confidence is None or not 1 <= int(confidence) <= 5:
            return 1.0
        return self.confidence[int(confidence) - 1]


def rater_weight(answers: Mapping[str, Any] | None, weights: Weights) -> float:
    """The product of the weights of a rater's answers to the questions chosen; 1 when none is chosen."""
    w = 1.0
    for qid in sorted(weights.questions):
        given = (answers or {}).get(qid)
        table = weights.questions[qid]
        w *= table[given] if isinstance(given, str) and given in table else weights.no_answer
    return w


@dataclass(frozen=True)
class Mark:
    """A mark: its type, onset and duration in samples, channels (empty: the whole montage) and confidence."""

    label: str
    onset: int
    duration: int
    channels: tuple[str, ...] = ()
    confidence: int | None = None

    @property
    def end(self) -> int:
        return self.onset + max(1, self.duration)


@dataclass
class Rater:
    """One rater's latest marks of the recording and their weight."""

    annotator_id: str
    marks: list[Mark]
    weight: float = 1.0
    source: str = "study"


@dataclass(frozen=True)
class Run:
    """Samples ``start`` to ``end`` (end not included) with one value: ``probability`` (None when every rater
    weighs 0), how many raters marked them and the weights summed."""

    start: int
    end: int
    probability: float | None
    n_marked: int
    weight_total: float
    weight_marked: float


def _counts(m: Mark, category: str, channel: str | None) -> bool:
    if category != ANY and m.label != category:
        return False
    return channel is None or not m.channels or channel in m.channels


def _steps(spans: list[tuple[int, int, float]]) -> list[tuple[int, int, float]]:
    """A rater's matching marks as pieces that do not overlap, each with the largest confidence weight of the
    marks covering it, in order."""
    cuts = sorted({x for a, b, _ in spans for x in (a, b)})
    out: list[tuple[int, int, float]] = []
    for a, b in pairwise(cuts):
        here = [c for s, e, c in spans if s <= a < e]
        if here:
            out.append((a, b, max(here)))
    return out


def runs(raters: list[Rater], n_samples: int, weights: Weights, *, category: str = ANY,
         channel: str | None = None) -> list[Run]:
    """The map of ``raters`` over samples 0 to ``n_samples``, as runs of one value each.

    Raters are summed in the order of their IDs at every run, as the browser sums them, so that both give the
    same numbers to the last bit."""
    raters = sorted(raters, key=lambda r: r.annotator_id)
    edges = {0, n_samples}
    pieces: list[list[tuple[int, int, float]]] = []
    for r in raters:
        mine = [(max(0, m.onset), min(n_samples, m.end), weights.of_confidence(m.confidence))
                for m in r.marks if _counts(m, category, channel)]
        steps = _steps([s for s in mine if s[1] > s[0]])
        pieces.append(steps)
        for a, b, _ in steps:
            edges.add(a)
            edges.add(b)
    cuts = sorted(e for e in edges if 0 <= e <= n_samples)
    at = [0] * len(raters)  # each rater's next piece
    out: list[Run] = []
    for a, b in pairwise(cuts):
        num = den = 0.0
        marked = 0
        for i, r in enumerate(raters):
            mine = pieces[i]
            k = at[i]
            while k < len(mine) and mine[k][1] <= a:
                k += 1
            at[i] = k
            if k < len(mine) and mine[k][0] <= a:
                c = mine[k][2]
                den += r.weight * c
                num += r.weight * c
                marked += 1
            else:
                den += r.weight
        p = num / den if den > 0 else None
        if out and (out[-1].probability, out[-1].n_marked, out[-1].weight_total, out[-1].weight_marked) \
                == (p, marked, den, num):
            out[-1] = Run(out[-1].start, b, p, marked, den, num)
        else:
            out.append(Run(a, b, p, marked, den, num))
    return out


# ------------------------------------------------------------------ writing and reading
def _num(x: float | None) -> str:
    return "n/a" if x is None else repr(float(x))


def tsv_rows(blocks: Iterable[tuple[str, str | None, list[Run]]], sfreq: float, n_raters: int) -> list[list[str]]:
    """The rows of a map's TSV: one block of runs for each category and channel (None: the recording as a
    whole, written as ``n/a``)."""
    rows = []
    for category, channel, rs in blocks:
        for r in rs:
            rows.append([category, channel if channel is not None else "n/a", str(r.start), str(r.end),
                         repr(r.start / sfreq), repr((r.end - r.start) / sfreq), _num(r.probability),
                         str(n_raters), str(r.n_marked), repr(r.weight_total), repr(r.weight_marked)])
    return rows


def tsv_text(rows: list[list[str]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(COLUMNS)
    w.writerows(rows)
    return buf.getvalue()


def probability_array(path: str | Path, category: str = ANY, channel: str | None = None,
                      n_samples: int | None = None) -> Any:
    """A map's TSV as a NumPy array of one probability a sample (NaN where every rater weighs 0, and past the
    map's end when ``n_samples`` is longer), for ``category`` and ``channel`` (None: the recording as a whole).

    With MNE-Python, ``probability_array(tsv, n_samples=raw.n_times)`` lines up with ``raw.get_data()``: both
    count samples from the first sample of the file."""
    import numpy as np

    want = channel if channel is not None else "n/a"
    rows = []
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            if row["category"] == category and row["channel"] == want:
                rows.append(row)
    if not rows:
        raise ValueError(f"{Path(path).name} has no map of {category!r}"
                         + (f" on channel {channel!r}" if channel is not None else " for the recording as a whole"))
    end = max(int(r["end_sample"]) for r in rows)
    out = np.full(n_samples if n_samples is not None else end, np.nan)
    for r in rows:
        if r["probability"] != "n/a":
            out[int(r["start_sample"]):int(r["end_sample"])] = float(r["probability"])
    return out
