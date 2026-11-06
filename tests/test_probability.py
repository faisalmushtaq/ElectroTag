"""The probability map of several raters' marks (electrotag/reliability/probability.py)."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from electrotag.reliability.probability import (
    ANY,
    Mark,
    Rater,
    Weights,
    WeightsError,
    probability_array,
    rater_weight,
    runs,
    tsv_rows,
    tsv_text,
)

BLINK, EMG = "Eye-blink-artifact", "EMG-artifact"


def _value(rs, s):
    return next(r for r in rs if r.start <= s < r.end).probability


def test_the_weighted_share_of_raters_marking_each_sample() -> None:
    w = Weights()
    raters = [Rater("A01", [Mark(BLINK, 10, 10, confidence=2)]),  # 40 %
              Rater("A02", [Mark(BLINK, 15, 10)]),                 # no confidence: full weight
              Rater("A03", [])]                                    # nothing marked: full weight, value 0
    rs = runs(raters, 40, w)
    assert (rs[0].start, rs[-1].end) == (0, 40), "the whole recording, from its first sample"
    assert _value(rs, 5) == 0.0
    assert _value(rs, 12) == pytest.approx(0.4 / 2.4)    # A01 only, counted at 40 % in both sums
    assert _value(rs, 17) == pytest.approx(1.4 / 2.4)    # A01 and A02
    assert _value(rs, 22) == pytest.approx(1 / 3)        # A02 only
    assert [r.n_marked for r in rs] == [0, 1, 2, 1, 0]
    assert all(a.end == b.start for a, b in zip(rs, rs[1:], strict=False))


def test_confidence_weights_can_be_changed_and_the_most_confident_overlapping_mark_counts() -> None:
    w = Weights.from_dict({"confidence": [0.1, 0.1, 0.1, 0.1, 0.5]})
    a = Rater("A01", [Mark(BLINK, 0, 10, confidence=1), Mark(EMG, 5, 10, confidence=5)])
    b = Rater("A02", [])
    rs = runs([a, b], 20, w)
    assert _value(rs, 2) == pytest.approx(0.1 / 1.1)
    assert _value(rs, 7) == pytest.approx(0.5 / 1.5), "where two marks overlap, the more confident counts"
    assert _value(runs([a, b], 20, w, category=BLINK), 12) == 0.0, "a category counts only its own marks"


def test_rater_weights_multiply_the_weights_of_their_answers() -> None:
    w = Weights.from_dict({"questions": {"eeg_years": {"Less than 1": 0.25, "More than 10": 1.0},
                                         "career_stage": {"PhD": 0.5}}, "no_answer": 0.8})
    assert rater_weight({"eeg_years": "Less than 1", "career_stage": "PhD"}, w) == pytest.approx(0.125)
    assert rater_weight({"eeg_years": "More than 10"}, w) == pytest.approx(0.8), "no answer to career_stage"
    assert rater_weight({}, Weights()) == 1.0
    novice = Rater("A01", [Mark(BLINK, 0, 10)], weight=0.25)
    expert = Rater("E01", [], weight=1.0)
    assert _value(runs([novice, expert], 10, Weights()), 0) == pytest.approx(0.25 / 1.25)


def test_by_channel_a_whole_montage_mark_counts_on_every_channel() -> None:
    a = Rater("A01", [Mark(BLINK, 0, 10, channels=("Fp1",))])
    b = Rater("A02", [Mark(BLINK, 0, 10)])
    w = Weights()
    assert _value(runs([a, b], 10, w, channel="Fp1"), 0) == 1.0
    assert _value(runs([a, b], 10, w, channel="O1"), 0) == 0.5
    assert _value(runs([a, b], 10, w), 0) == 1.0, "the recording as a whole: any mark on any channel"


def test_raters_who_all_weigh_nothing_give_no_value() -> None:
    rs = runs([Rater("A01", [], weight=0.0), Rater("A02", [Mark(BLINK, 0, 5)], weight=0.0)], 10, Weights())
    assert all(r.probability is None for r in rs)


def test_weights_are_checked_in_plain_words() -> None:
    for bad, said in (({"confidence": [1, 1, 1]}, "five numbers"), ({"confidence": [2, 1, 1, 1, 1]}, "from 0 to 1"),
                      ({"questions": {"q": {"a": -1}}}, "from 0 to 10"), ({"extra": 1}, "no setting"),
                      ({"no_answer": True}, "number")):
        with pytest.raises(WeightsError, match=said):
            Weights.from_dict(bad)
    assert Weights.from_dict(Weights().to_dict()) == Weights()


def test_a_map_written_as_tsv_reads_back_sample_by_sample(tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    raters = [Rater("A01", [Mark(BLINK, 2, 3, channels=("Fp1",))]), Rater("A02", [])]
    w = Weights()
    blocks = [(ANY, None, runs(raters, 10, w)), (ANY, "Fp1", runs(raters, 10, w, channel="Fp1")),
              (BLINK, None, runs(raters, 10, w, category=BLINK))]
    text = tsv_text(tsv_rows(blocks, 100.0, 2))
    assert text.splitlines()[0].split("\t")[:4] == ["category", "channel", "start_sample", "end_sample"]
    assert "\tn/a\t2\t5\t0.02\t0.03\t0.5\t2\t1\t2.0\t1.0" in text
    f = tmp_path / "x_probability.tsv"
    f.write_text(text, encoding="utf-8")
    p = probability_array(f, ANY, n_samples=12)
    assert p.shape == (12,) and list(p[:10]) == [0, 0, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0]
    assert all(math.isnan(x) for x in p[10:]), "past the map's end"
    assert np.array_equal(probability_array(f, ANY, "Fp1"), probability_array(f, ANY))
    with pytest.raises(ValueError, match="no map of 'EMG-artifact'"):
        probability_array(f, EMG)
