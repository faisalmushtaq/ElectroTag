"""Application settings and the optional study configuration file.

Defaults live in ``default_settings.json`` next to this module. A study
administrator can override them for a dataset by placing an
``electrotag_study.json`` file in the dataset root (see
``docs/file_formats.md``). Settings that the administrator marks as locked
(for example the viewing filters used in a reliability study) cannot be
changed by annotators. A study run in the browser keeps the same settings with
its records (``electrotag-web init-study``).
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: The uncertain type (electrotag/app/annotations/labels.py UNCERTAIN_LABEL), which a study cannot hide.
UNCERTAIN_LABEL = "Data-artifact"

CONFIG_DIR = Path(__file__).resolve().parent
DEFAULT_SETTINGS_PATH = CONFIG_DIR / "default_settings.json"
STUDY_CONFIG_FILENAME = "electrotag_study.json"

SELECTION_STRATEGIES = ("random", "seeded", "manual")
RECORDING_EXTENSIONS = (".vhdr", ".edf", ".bdf")
# Channel types that the channels.types setting may assign (MNE-Python's names).
CHANNEL_TYPES = ("eeg", "eog", "ecg", "emg", "misc", "stim", "resp", "bio", "gsr", "temperature")
FILTER_METHODS = ("fir", "iir")
NOTCH_FREQUENCIES = (50.0, 60.0)
COVERAGE_CHECKS = ("warn", "off")
#: annotation.confidence: "optional" (annotators rate a mark from 1 to 5 when they wish) or "every_mark" (they
#: are asked to rate each new mark; no mark starts with a rating). "off" and "on" are read as these.
CONFIDENCE_SETTINGS = ("optional", "every_mark")
_CONFIDENCE_ALIASES = {"off": "optional", "on": "every_mark"}
#: review.reason_required: when an adjudicator gives a reason for a decision (always; only when they keep
#: neither version or edit a mark; never).
REASON_RULES = ("always", "edited_or_none", "never")
#: The ways two marks are matched (electrotag.reliability.config.MATCH_CRITERIA; kept here so that reading
#: the settings never loads the agreement analysis, and checked to be the same by the tests).
MATCH_CRITERIA = ("iou", "tolerance", "iou_and_tolerance")
MATCHING_KEYS = ("match_criterion", "iou_threshold", "onset_tolerance_s", "offset_tolerance_s", "channel_jaccard")
#: The five stages of the training path, and those a trainee may be allowed to skip (never the assessment).
TRAINING_STAGES = ("tour", "snippets", "guided", "practice", "assessment")
SKIPPABLE_STAGES = ("tour", "snippets", "guided", "practice")
#: training.gate: real study work waits for a passed assessment ("met"), a finished one ("completed"), or nothing.
TRAINING_GATES = ("met", "completed", "off")


class SettingsError(ValueError):
    """Raised when a settings or study configuration file is invalid."""


def _label_list(value: Any, name: str) -> tuple[str, ...]:
    """A list of artifact type names, each once (their names are checked against the study's catalogue when saved)."""
    if not isinstance(value, list) or not all(isinstance(x, str) and x for x in value):
        raise SettingsError(f"{name} must be a list of artifact type names")
    if len(set(value)) != len(value):
        raise SettingsError(f"{name} must not name an artifact type twice")
    return tuple(value)


def _minutes(value: Any, name: str) -> float:
    """A number of minutes from a settings file, or a plain-words error."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise SettingsError(f"{name} must be a number of minutes")
    try:
        out = float(value)
    except ValueError as exc:
        raise SettingsError(f"{name} must be a number of minutes, not {value!r}") from exc
    if out != out or out in (float("inf"), float("-inf")):
        raise SettingsError(f"{name} must be a number of minutes")
    return out


def _confidence_setting(value: Any) -> str:
    """annotation.confidence, with the first design's "off" and "on" read as "optional" and "every_mark"."""
    text = str(value)
    return _CONFIDENCE_ALIASES.get(text, text) if isinstance(value, str) else repr(value)


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``base`` with ``override`` merged in recursively."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


#: How many annotators one task (or hand-out) gives each recording: at least two, for a disagreement needs two
#: versions, and at most ANNOTATORS_PER_TASK_MAX. Raising it is this one number here and K_MAX in
#: electrotag/web/static/js/admin/tasks_model.js (tests/test_tasks_limits.py keeps the two the same); adjudication
#: tells any number of people apart (letters A to Z, and colours that repeat with another outline).
ANNOTATORS_PER_TASK_MIN, ANNOTATORS_PER_TASK_MAX = 2, 10

@dataclass(frozen=True)
class FilterSettings:
    """Viewing filters applied to the displayed copy of the EEG only.

    The source recording is never filtered or modified.
    """

    highpass_enabled: bool = True
    highpass_hz: float = 1.0
    notch_enabled: bool = True
    notch_hz: float = 50.0  # UK/European mains; 60 Hz can be chosen
    notch_harmonics: bool = False
    method: str = "fir"
    iir_order: int = 4
    locked: bool = False

    def validate(self) -> None:
        if self.method not in FILTER_METHODS:
            raise SettingsError(f"Filter method must be one of {FILTER_METHODS}, got {self.method!r}")
        if self.highpass_enabled and not (self.highpass_hz > 0):
            raise SettingsError("High-pass cut-off must be a positive frequency")
        if self.notch_enabled and float(self.notch_hz) not in NOTCH_FREQUENCIES:
            raise SettingsError(f"Notch frequency must be 50 or 60 Hz, got {self.notch_hz}")
        if self.method == "iir" and not (1 <= int(self.iir_order) <= 8):
            raise SettingsError("IIR order must be between 1 and 8")

    def describe(self) -> str:
        """Short human-readable summary shown in the viewer."""
        parts = []
        if self.highpass_enabled:
            parts.append(f"High-pass {self.highpass_hz:g} Hz")
        else:
            parts.append("No high-pass")
        if self.notch_enabled:
            harm = " + harmonics" if self.notch_harmonics else ""
            parts.append(f"Notch {self.notch_hz:g} Hz{harm}")
        else:
            parts.append("No notch")
        parts.append(self.method.upper())
        return ", ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FilterSettings:
        d = cls()
        obj = cls(
            highpass_enabled=bool(data.get("highpass_enabled", d.highpass_enabled)),
            highpass_hz=float(data.get("highpass_hz", d.highpass_hz)),
            notch_enabled=bool(data.get("notch_enabled", d.notch_enabled)),
            notch_hz=float(data.get("notch_hz", d.notch_hz)),
            notch_harmonics=bool(data.get("notch_harmonics", d.notch_harmonics)),
            method=str(data.get("method", d.method)).lower(),
            iir_order=int(data.get("iir_order", d.iir_order)),
            locked=bool(data.get("locked", d.locked)),
        )
        obj.validate()
        return obj


#: The artifact types on keys 1 to 9 unless a study chooses others (annotation.quick_labels).
DEFAULT_QUICK_LABELS: tuple[str, ...] = (
    "Eye-blink-artifact",
    "Horizontal-eye-movement-artifact",
    "EMG-artifact",
    "Movement-artifact",
    "Electrode-pops-artifact",
    "Chewing-artifact",
    "ECG-artifact",
    "Line-noise-artifact",
    "Data-artifact",  # the group term for an artifact whose type is unclear
)


#: How the browser may colour the EEG's channels: not at all, or by region, side or channel type.
CHANNEL_COLOUR_MODES = ("off", "region", "side", "type")
#: The signal of the topographic map (docs/using.md, "The topographic map"): its filters (those the viewer
#: shows, or none) and its reference (as recorded, or the average of the good channels).
TOPOMAP_FILTERS = ("as_shown", "none")
TOPOMAP_REFERENCES = ("as_recorded", "average")


@dataclass(frozen=True)
class DisplaySettings:
    duration_s: float = 10.0
    n_channels: int = 32
    scalings: dict[str, float] = field(default_factory=dict)
    theme: str = "light"
    overview_mode: str = "empty"
    # The study's default for colouring the EEG's channels by group in the browser; each annotator
    # can choose otherwise in the Recording tab (their choice is kept in their browser).
    channel_colours: str = "off"
    # The topographic map beside the EEG in the browser, and the signal it maps unless an annotator
    # chooses otherwise for themselves (their choice is kept in their browser).
    topomap: bool = True
    topomap_filters: str = "as_shown"
    topomap_reference: str = "as_recorded"


def _flag(block: dict[str, Any], name: str, key: str, default: bool) -> bool:
    """A setting that is on or off: JSON's true or false, nothing else (so that "no" is not read as on)."""
    value = block.get(key, default)
    if not isinstance(value, bool):
        raise SettingsError(f"{name}.{key} must be true or false, not {value!r}")
    return value


def _whole(block: dict[str, Any], name: str, key: str, default: int, low: int, high: int, what: str) -> int:
    value = block.get(key, default)
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value
            or not low <= value <= high):
        raise SettingsError(f"{name}.{key} must be a whole number from {low} to {high} ({what})")
    return int(value)


def _block(data: dict[str, Any], name: str) -> dict[str, Any]:
    block = data.get(name, {}) or {}
    if not isinstance(block, dict):
        raise SettingsError(f"{name} must be a block of settings")
    return block


@dataclass(frozen=True)
class ReviewSettings:
    """review: corrections of saved work and the adjudication of disagreements (docs/study_settings.md)."""

    corrections: bool = True  # experts may correct saved work, as new versions linked to the original
    show_corrections_to_annotators: bool = True  # annotators see the corrections of their work, with the reasons
    k_default: int = 2  # annotators per task when tasks are made
    show_outcomes_to_annotators: bool = True  # annotators see the decisions on the conflicts in their work
    reason_required: str = "always"  # REASON_RULES
    matching: dict[str, Any] = field(default_factory=lambda: {
        "match_criterion": "iou", "iou_threshold": 0.2, "onset_tolerance_s": 0.5, "offset_tolerance_s": 0.5,
        "channel_jaccard": 0.5})
    gold_min_items: int = 3  # known-answer items scored before a person's accuracy weighs their marks

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> ReviewSettings:
        d = cls()
        matching = block.get("matching", d.matching)
        if not isinstance(matching, dict):
            raise SettingsError("review.matching must be a block of settings (match_criterion, iou_threshold, ...)")
        unknown = sorted(set(matching) - set(MATCHING_KEYS))
        if unknown:
            raise SettingsError(f"review.matching has no setting {unknown[0]!r}; it has {', '.join(MATCHING_KEYS)}")
        m = {**d.matching, **matching}
        if m["match_criterion"] not in MATCH_CRITERIA:
            raise SettingsError(f"review.matching.match_criterion must be one of {', '.join(MATCH_CRITERIA)}")
        for key, low, high in (("iou_threshold", 0.0, 1.0), ("onset_tolerance_s", 0.0, 60.0),
                               ("offset_tolerance_s", 0.0, 60.0), ("channel_jaccard", 0.0, 1.0)):
            v = m[key]
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not low <= v <= high or v != v:
                raise SettingsError(f"review.matching.{key} must be a number from {low:g} to {high:g}")
            m[key] = float(v)
        if m["iou_threshold"] >= 1:
            raise SettingsError("review.matching.iou_threshold must be below 1 (0 counts any overlap)")
        reason = block.get("reason_required", d.reason_required)
        if reason not in REASON_RULES:
            raise SettingsError('review.reason_required must be "always", "edited_or_none" (only when the '
                                'adjudicator keeps neither version or edits a mark) or "never"')
        return cls(
            corrections=_flag(block, "review", "corrections", d.corrections),
            show_corrections_to_annotators=_flag(block, "review", "show_corrections_to_annotators",
                                                 d.show_corrections_to_annotators),
            k_default=_whole(block, "review", "k_default", d.k_default, ANNOTATORS_PER_TASK_MIN,
                             ANNOTATORS_PER_TASK_MAX, "annotators per task"),
            show_outcomes_to_annotators=_flag(block, "review", "show_outcomes_to_annotators",
                                              d.show_outcomes_to_annotators),
            reason_required=str(reason), matching=m,
            gold_min_items=_whole(block, "review", "gold_min_items", d.gold_min_items, 1, 100,
                                  "known-answer items before a person's accuracy counts"),
        )


@dataclass(frozen=True)
class TrainingPolicy:
    """training: which stages of the training path a trainee may skip, and what real study work waits for."""

    skippable: tuple[str, ...] = SKIPPABLE_STAGES
    gate: str = "met"  # TRAINING_GATES
    tour: bool = True  # the training path begins with the platform tour
    snippets_quiz_required: bool = False  # the snippets stage is done only once its recognition check is finished

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> TrainingPolicy:
        d = cls()
        skippable = block.get("skippable", list(d.skippable))
        if not isinstance(skippable, list) or not all(isinstance(x, str) for x in skippable):
            raise SettingsError("training.skippable must be a list of stages (tour, snippets, guided, practice)")
        if "assessment" in skippable:
            raise SettingsError("training.skippable cannot include the assessment: trainees must pass the blind "
                                "assessment before real study work")
        unknown = [x for x in skippable if x not in SKIPPABLE_STAGES]
        if unknown:
            raise SettingsError(f"training.skippable names {unknown[0]!r}, which is not a stage; the stages that "
                                f"can be skipped are {', '.join(SKIPPABLE_STAGES)}")
        gate = block.get("gate", d.gate)
        if gate not in TRAINING_GATES:
            raise SettingsError('training.gate must be "met" (study work waits until the assessment is passed), '
                                '"completed" (until it is done) or "off"')
        return cls(skippable=tuple(x for x in SKIPPABLE_STAGES if x in skippable), gate=str(gate),
                   tour=_flag(block, "training", "tour", d.tour),
                   snippets_quiz_required=_flag(block, "training", "snippets_quiz_required",
                                                d.snippets_quiz_required))


@dataclass(frozen=True)
class ReplaySettings:
    """replay: who may watch a step-by-step replay of a session, from its interaction log."""

    enabled: bool = True  # experts and administrators may replay annotators' sessions
    trainees_watch_experts: bool = True  # trainees may watch the sessions of experts who have agreed to it
    trainees_see_crowd: bool = False  # trainees may see everyone's marks as a crowd, on teaching recordings only

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> ReplaySettings:
        d = cls()
        return cls(enabled=_flag(block, "replay", "enabled", d.enabled),
                   trainees_watch_experts=_flag(block, "replay", "trainees_watch_experts", d.trainees_watch_experts),
                   trainees_see_crowd=_flag(block, "replay", "trainees_see_crowd", d.trainees_see_crowd))


@dataclass(frozen=True)
class QuestionnaireSettings:
    """questionnaire: the sign-up questionnaire and contact details (electrotag/config/questionnaire.py)."""

    enabled: bool = True  # annotators and experts answer it before any work opens
    demographics: bool = True  # include the demographic questions (only where the ethics approval covers them)
    questions: tuple[dict[str, Any], ...] | None = None  # None: the default questionnaire
    contacts: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_CONTACTS))

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> QuestionnaireSettings:
        from electrotag.config.questionnaire import QuestionnaireError, check_contacts, check_questions

        d = cls()
        try:
            questions = check_questions(block.get("questions"))
            contacts = check_contacts(block.get("contacts"))
        except QuestionnaireError as exc:
            raise SettingsError(str(exc)) from exc
        return cls(enabled=_flag(block, "questionnaire", "enabled", d.enabled),
                   demographics=_flag(block, "questionnaire", "demographics", d.demographics),
                   questions=None if questions is None else tuple(questions), contacts=contacts)

    def effective(self) -> list[dict[str, Any]]:
        """The questions people are asked now (the demographic group left out when it is switched off)."""
        from electrotag.config.questionnaire import effective_questions

        return effective_questions(None if self.questions is None else list(self.questions), self.demographics)


_DEFAULT_CONTACTS = {"full_name": "required", "email": "required", "phone": "optional", "institution": "optional"}

#: The most repeats one rule may ask for, and the longest wait (days) before a repeat.
MAX_REPEATS = 10
MAX_REPEAT_DAYS = 365
_RULE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


@dataclass(frozen=True)
class RepeatRule:
    """One rule of repeat ratings: which recordings, how many repeats, and the days before each."""

    rule_id: str
    name: str = ""
    every_recording: bool = True  # recordings: "all"; otherwise the datasets and recordings named
    datasets: tuple[str, ...] = ()
    recording_ids: tuple[str, ...] = ()
    repeats: int = 1  # how many times a recording is rated again after the first rating
    interval_days: int = 14  # days from saving one rating until the recording comes back for the next

    def covers(self, recording_id: str, dataset_id: str) -> bool:
        return self.every_recording or dataset_id in self.datasets or recording_id in self.recording_ids


@dataclass(frozen=True)
class RepeatSettings:
    """repeats: ask annotators to rate recordings again, for intra-rater (test-retest) reliability.

    The rules are applied in order: a recording takes the first rule that covers it, so a rule for some
    recordings goes before a rule for all of them.
    """

    enabled: bool = False
    rules: tuple[RepeatRule, ...] = ()

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> RepeatSettings:
        enabled = _flag(block, "repeats", "enabled", False)
        rules = block.get("rules", [])
        if not isinstance(rules, list) or len(rules) > 50:
            raise SettingsError("repeats.rules must be a list of at most 50 rules")
        out: list[RepeatRule] = []
        for i, r in enumerate(rules, start=1):
            where = f"repeats.rules[{i}]"
            if not isinstance(r, dict):
                raise SettingsError(f"{where} must be a block (id, name, recordings, repeats, interval_days)")
            rid = r.get("id")
            if not isinstance(rid, str) or not _RULE_ID_RE.match(rid):
                raise SettingsError(f"{where}.id must be up to 40 letters, digits, hyphens or underscores")
            if any(x.rule_id == rid for x in out):
                raise SettingsError(f"repeats.rules: the ID {rid!r} is used twice")
            name = r.get("name", "")
            if not isinstance(name, str) or len(name) > 100:
                raise SettingsError(f"{where}.name must be text of at most 100 characters")
            scope = r.get("recordings", "all")
            if scope not in ("all", "some"):
                raise SettingsError(f'{where}.recordings must be "all" or "some" (the datasets and recordings named)')
            lists = {}
            for key in ("datasets", "recording_ids"):
                v = r.get(key, [])
                if not isinstance(v, list) or len(v) > 10000 or not all(isinstance(x, str) and x for x in v):
                    raise SettingsError(f"{where}.{key} must be a list of IDs")
                lists[key] = tuple(dict.fromkeys(v))
            if scope == "some" and not (lists["datasets"] or lists["recording_ids"]):
                raise SettingsError(f"{where} applies to some recordings: name at least one dataset or recording")
            repeats = _whole(r, where, "repeats", 1, 1, MAX_REPEATS, "how many times a recording is rated again")
            days = _whole(r, where, "interval_days", 14, 1, MAX_REPEAT_DAYS,
                          "the days from saving one rating until the recording comes back")
            out.append(RepeatRule(rule_id=rid, name=name.strip(), every_recording=scope == "all",
                                  datasets=lists["datasets"], recording_ids=lists["recording_ids"],
                                  repeats=repeats, interval_days=days))
        return cls(enabled=enabled, rules=tuple(out))

    def rule_for(self, recording_id: str, dataset_id: str) -> RepeatRule | None:
        """The first rule that covers a recording, or None (also while repeats are switched off)."""
        if not self.enabled:
            return None
        return next((r for r in self.rules if r.covers(recording_id, dataset_id)), None)


#: The settings of the agreement analysis that a study pre-registers (electrotag.reliability.config.AnalysisConfig):
#: what is measured and how marks are matched. Who is compared, the versions, the unit and the report's layout
#: are chosen for each analysis.
PREREGISTERED_AGREEMENT_KEYS = ("resolutions_s", "min_bin_coverage", "channel_modes", "include_any_artifact",
                                "include_group_rollups", "match_criterion", "iou_thresholds", "primary_iou_threshold",
                                "onset_tolerance_s", "offset_tolerance_s", "allow_many_to_one", "min_channel_jaccard",
                                "categories", "duplicate_policy", "channel_exclude")
#: The measures of working time a study can report (the activity analysis's recordings.tsv).
WORKING_TIME_MEASURES = ("active_s", "wall_s")


@dataclass(frozen=True)
class PreregistrationSettings:
    """preregistration: the settings a study chooses before it starts and reports with its results.

    ``agreement`` holds the agreement analysis's settings saved as the study's (None until saved), and
    ``working_time`` the measure of working time it reports. The confirmations are records of their own
    (electrotag/web/preregistration.py), so that a change of these settings never confirms itself.
    """

    agreement: dict[str, Any] | None = None
    working_time: str = "active_s"

    @classmethod
    def from_dict(cls, block: dict[str, Any]) -> PreregistrationSettings:
        working = block.get("working_time", "active_s")
        if working not in WORKING_TIME_MEASURES:
            raise SettingsError("preregistration.working_time must be active_s (idle time and time in other programs "
                                "left out) or wall_s (all the time from opening to closing)")
        agreement = block.get("agreement")
        if agreement is not None:
            agreement = preregistered_agreement(agreement)
        return cls(agreement=agreement, working_time=working)


def preregistered_agreement(value: Any) -> dict[str, Any]:
    """The agreement settings a study saves as its own, checked as the analysis checks them, with every key of
    :data:`PREREGISTERED_AGREEMENT_KEYS` (those left out take the analysis's defaults)."""
    from electrotag.reliability.config import AnalysisConfig

    if not isinstance(value, dict):
        raise SettingsError("preregistration.agreement must be a block of agreement settings, or null for none")
    unknown = sorted(set(value) - set(PREREGISTERED_AGREEMENT_KEYS))
    if unknown:
        raise SettingsError(f"preregistration.agreement has no setting {unknown[0]!r}; it has "
                            f"{', '.join(PREREGISTERED_AGREEMENT_KEYS)}")
    try:
        cfg = AnalysisConfig.from_dict({**AnalysisConfig().to_dict(), **value}).to_dict()
    except (ValueError, TypeError) as exc:
        raise SettingsError(f"preregistration.agreement cannot be used: {exc}") from exc
    return {k: cfg[k] for k in PREREGISTERED_AGREEMENT_KEYS} | without_unused_channel_overlap(cfg)


def without_unused_channel_overlap(cfg: dict[str, Any]) -> dict[str, Any]:
    """The channel overlap needed counts only when channels are compared (time_and_channel); otherwise it is kept as
    the default, so that a value nobody uses is neither pre-registered nor a difference from it."""
    from electrotag.reliability.config import AnalysisConfig

    if "time_and_channel" in (cfg.get("channel_modes") or []):
        return {}
    return {"min_channel_jaccard": AnalysisConfig().min_channel_jaccard}


@dataclass(frozen=True)
class Settings:
    """All application settings after merging defaults and study overrides."""

    output_directory_name: str
    output_directory: str | None
    discovery_suffixes: tuple[str, ...]
    discovery_exclude_dir_names: tuple[str, ...]
    discovery_follow_symlinks: bool
    filters: FilterSettings
    display: DisplaySettings
    preload_memory_limit_mb: float
    hash_source_files: bool
    apply_channel_types_from_bids: bool
    show_bids_bad_channels: bool
    hidden_channel_patterns: tuple[str, ...]
    selection_strategy: str
    selection_seed: int | None
    recording_lock_stale_hours: float
    register_lock_timeout_s: float
    min_duration_samples: int
    # The artifact types on the number keys 1 to 9 (and the toolbar's quick buttons), in key order.
    quick_labels: tuple[str, ...] = DEFAULT_QUICK_LABELS
    # annotation.hidden_labels: artifact types the study does not use, left out of every list annotators choose
    # a type from (marks that already have one keep it). The uncertain type, Data-artifact, cannot be hidden.
    hidden_labels: tuple[str, ...] = ()
    # channels.types: (name pattern, MNE channel type) pairs, applied in order when a recording is loaded.
    channel_type_patterns: tuple[tuple[str, str], ...] = ()
    # logging: the interaction log of each visit (research data; see docs/activity_logs.md).
    logging_interactions: bool = True
    logging_pointer_hz: float = 5.0  # pointer samples per second over the EEG (0: none)
    logging_idle_after_s: float = 30.0  # seconds without input after which the annotator counts as idle
    # annotation.allow_revisions: an annotator may open a recording they finished, change it and submit
    # it again as a new attempt (the earlier files are kept; analyses use the latest attempt).
    allow_revisions: bool = True
    # annotation.allow_reviews: an administrator may review a saved recording (Agree, Caveat, Comment per
    # annotation); annotation.show_reviews_to_annotators: the annotator sees that feedback (off: blind reviews).
    allow_reviews: bool = True
    show_reviews_to_annotators: bool = True
    # annotation.merge_overlapping: a mark drawn or changed so that it overlaps another of the same type on the
    # same channels joins it (marks that only touch, or are apart, always stay separate); off keeps every mark as drawn.
    merge_overlapping: bool = True
    # gamification: the counters, milestones, personal goal and team progress on the home page, and the
    # anonymised leaderboard (ranked by recordings completed, or only those viewed in full).
    gamification_enabled: bool = True
    gamification_leaderboard: bool = True
    gamification_leaderboard_viewed_only: bool = False
    # annotation: comfort for long sessions in the browser (docs/using.md, "Pausing and breaks").
    break_reminder_minutes: float = 50.0  # minutes of work since the last break before a reminder (0: none)
    idle_pause_minutes: float = 3.0  # minutes without input after which the clock pauses itself (0: never)
    coverage_check: str = "warn"  # "warn": Save and Finish lists the parts never on screen; "off"
    confidence: str = "optional"  # CONFIDENCE_SETTINGS: how sure the annotator is of each mark (docs/using.md)
    # review, training and replay: corrections and adjudication, the training path's policy, and replays.
    review: ReviewSettings = field(default_factory=ReviewSettings)
    training: TrainingPolicy = field(default_factory=TrainingPolicy)
    replay: ReplaySettings = field(default_factory=ReplaySettings)
    questionnaire: QuestionnaireSettings = field(default_factory=QuestionnaireSettings)
    repeats: RepeatSettings = field(default_factory=RepeatSettings)
    preregistration: PreregistrationSettings = field(default_factory=PreregistrationSettings)
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Settings:
        try:
            out = data["output"]
            disc = data["discovery"]
            disp = data["display"]
            load = data["loading"]
            sel = data["selection"]
            locks = data["locks"]
            ann = data["annotation"]
            chans = data.get("channels", {}) or {}
            logs = data.get("logging", {}) or {}
            games = data.get("gamification", {}) or {}
            if not isinstance(games, dict):
                raise SettingsError("gamification must be a block of settings (enabled, leaderboard, ...)")
            types = chans.get("types", {}) or {}
            if not isinstance(types, dict):
                raise SettingsError(
                    'channels.types must map channel-name patterns to channel types, for example {"EXG*": "misc"}'
                )
            # Study files written before EDF support give a single "suffix".
            suffixes = [disc["suffix"]] if disc.get("suffix") else list(disc.get("suffixes", []))
            settings = cls(
                output_directory_name=str(out["directory_name"]),
                output_directory=out.get("directory"),
                discovery_suffixes=tuple(str(x) for x in suffixes),
                discovery_exclude_dir_names=tuple(disc.get("exclude_dir_names", [])),
                discovery_follow_symlinks=bool(disc.get("follow_symlinks", False)),
                filters=FilterSettings.from_dict(data["filters"]),
                display=DisplaySettings(
                    duration_s=float(disp["duration_s"]),
                    n_channels=int(disp["n_channels"]),
                    scalings={k: float(v) for k, v in disp.get("scalings", {}).items()},
                    theme=str(disp.get("theme", "light")),
                    overview_mode=str(disp.get("overview_mode", "empty")),
                    channel_colours=str(disp.get("channel_colours", "off")),
                    topomap=_flag(disp, "display", "topomap", True),
                    topomap_filters=str(disp.get("topomap_filters", "as_shown")),
                    topomap_reference=str(disp.get("topomap_reference", "as_recorded")),
                ),
                preload_memory_limit_mb=float(load["preload_memory_limit_mb"]),
                hash_source_files=bool(load["hash_source_files"]),
                apply_channel_types_from_bids=bool(load.get("apply_channel_types_from_bids", True)),
                show_bids_bad_channels=bool(load.get("show_bids_bad_channels", True)),
                hidden_channel_patterns=tuple(str(x) for x in chans.get("hide", [])),
                selection_strategy=str(sel["strategy"]),
                selection_seed=None if sel.get("seed") is None else int(sel["seed"]),
                recording_lock_stale_hours=float(locks["recording_lock_stale_hours"]),
                register_lock_timeout_s=float(locks["register_lock_timeout_s"]),
                min_duration_samples=int(ann["min_duration_samples"]),
                quick_labels=tuple(str(x) for x in ann.get("quick_labels", DEFAULT_QUICK_LABELS)),
                hidden_labels=_label_list(ann.get("hidden_labels", []), "annotation.hidden_labels"),
                break_reminder_minutes=_minutes(ann.get("break_reminder_minutes", 50.0),
                                                "annotation.break_reminder_minutes"),
                idle_pause_minutes=_minutes(ann.get("idle_pause_minutes", 3.0), "annotation.idle_pause_minutes"),
                coverage_check=str(ann.get("coverage_check", "warn")),
                confidence=_confidence_setting(ann.get("confidence", "optional")),
                channel_type_patterns=tuple((str(k), str(v).strip().lower()) for k, v in types.items()),
                logging_interactions=bool(logs.get("interactions", True)),
                logging_pointer_hz=float(logs.get("pointer_hz", 5.0)),
                logging_idle_after_s=float(logs.get("idle_after_s", 30.0)),
                allow_revisions=_flag(ann, "annotation", "allow_revisions", True),
                allow_reviews=_flag(ann, "annotation", "allow_reviews", True),
                show_reviews_to_annotators=_flag(ann, "annotation", "show_reviews_to_annotators", True),
                merge_overlapping=_flag(ann, "annotation", "merge_overlapping", True),
                gamification_enabled=_flag(games, "gamification", "enabled", True),
                gamification_leaderboard=_flag(games, "gamification", "leaderboard", True),
                gamification_leaderboard_viewed_only=_flag(games, "gamification", "leaderboard_viewed_only", False),
                review=ReviewSettings.from_dict(_block(data, "review")),
                training=TrainingPolicy.from_dict(_block(data, "training")),
                replay=ReplaySettings.from_dict(_block(data, "replay")),
                questionnaire=QuestionnaireSettings.from_dict(_block(data, "questionnaire")),
                repeats=RepeatSettings.from_dict(_block(data, "repeats")),
                preregistration=PreregistrationSettings.from_dict(_block(data, "preregistration")),
                raw=copy.deepcopy(data),
            )
        except KeyError as exc:  # pragma: no cover - defaults always complete
            raise SettingsError(f"Missing setting: {exc}") from exc
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.selection_strategy not in SELECTION_STRATEGIES:
            raise SettingsError(
                f"selection.strategy must be one of {SELECTION_STRATEGIES}, got {self.selection_strategy!r}"
            )
        if self.selection_strategy == "seeded" and self.selection_seed is None:
            raise SettingsError("selection.seed is required when selection.strategy is 'seeded'")
        if not self.discovery_suffixes:
            raise SettingsError("discovery.suffixes must name at least one kind of recording file")
        for sfx in self.discovery_suffixes:
            if not sfx.lower().endswith(RECORDING_EXTENSIONS):
                raise SettingsError(
                    f"discovery.suffixes: {sfx!r} must end with one of {', '.join(RECORDING_EXTENSIONS)}"
                )
        if any(not p.strip() for p in self.hidden_channel_patterns):
            raise SettingsError("channels.hide must not contain empty patterns")
        for pattern, ch_type in self.channel_type_patterns:
            if not pattern.strip():
                raise SettingsError("channels.types must not contain empty patterns")
            if ch_type not in CHANNEL_TYPES:
                raise SettingsError(
                    f"channels.types: {pattern!r} is given the type {ch_type!r}; use one of {', '.join(CHANNEL_TYPES)}"
                )
        if self.display.topomap_filters not in TOPOMAP_FILTERS:
            raise SettingsError(f"display.topomap_filters must be one of {', '.join(TOPOMAP_FILTERS)}, "
                                f"got {self.display.topomap_filters!r}")
        if self.display.topomap_reference not in TOPOMAP_REFERENCES:
            raise SettingsError(f"display.topomap_reference must be one of {', '.join(TOPOMAP_REFERENCES)}, "
                                f"got {self.display.topomap_reference!r}")
        if self.display.channel_colours not in CHANNEL_COLOUR_MODES:
            raise SettingsError(
                f"display.channel_colours must be one of {', '.join(CHANNEL_COLOUR_MODES)}, "
                f"got {self.display.channel_colours!r}"
            )
        if self.min_duration_samples < 1:
            raise SettingsError("annotation.min_duration_samples must be at least 1")
        if len(self.quick_labels) > 9:
            raise SettingsError("annotation.quick_labels can name at most 9 artifact types (keys 1 to 9)")
        if len(set(self.quick_labels)) != len(self.quick_labels):
            raise SettingsError("annotation.quick_labels must not name an artifact type twice")
        if UNCERTAIN_LABEL in self.hidden_labels:
            raise SettingsError(f"annotation.hidden_labels cannot hide {UNCERTAIN_LABEL}: it is the type for an "
                                "artifact whose type cannot be told (key 0, Uncertain), and is always available")
        on_keys = [q for q in self.quick_labels if q in self.hidden_labels]
        if on_keys:
            raise SettingsError(f"annotation.hidden_labels hides {on_keys[0]}, which is on a number key "
                                "(annotation.quick_labels): take it off the keys, or keep it available")
        if not 0 <= self.break_reminder_minutes <= 240:
            raise SettingsError("annotation.break_reminder_minutes must be between 0 (no reminders) and 240 minutes")
        if not 0 <= self.idle_pause_minutes <= 60:
            raise SettingsError("annotation.idle_pause_minutes must be between 0 (never pause by itself) and 60 "
                                "minutes")
        if self.coverage_check not in COVERAGE_CHECKS:
            raise SettingsError('annotation.coverage_check must be "warn" (list the parts not yet viewed before '
                                'Save and Finish) or "off"')
        if self.confidence not in CONFIDENCE_SETTINGS:
            raise SettingsError('annotation.confidence must be "optional" (annotators rate their confidence in a '
                                'mark when they wish) or "every_mark" (annotators are asked to rate each new mark)')
        if not 0 <= self.logging_pointer_hz <= 60:
            raise SettingsError("logging.pointer_hz must be between 0 (no pointer samples) and 60")
        if not 5 <= self.logging_idle_after_s <= 3600:
            raise SettingsError("logging.idle_after_s must be between 5 and 3600 seconds")
        if not self.output_directory_name or any(c in self.output_directory_name for c in "/\\:"):
            raise SettingsError("output.directory_name must be a plain folder name")

    def with_filters(self, filters: FilterSettings) -> Settings:
        """Return a copy with different viewing filters (respecting locks)."""
        if self.filters.locked and filters != self.filters:
            raise SettingsError("Filter settings are fixed by the study administrator")
        filters.validate()
        data = copy.deepcopy(self.raw)
        data["filters"] = filters.to_dict()
        return Settings.from_dict(data)


def load_default_settings_dict() -> dict[str, Any]:
    return json.loads(DEFAULT_SETTINGS_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class AnnotatorEntry:
    annotator_id: str
    display_name: str = ""


@dataclass(frozen=True)
class StudyConfig:
    """Optional per-dataset configuration written by a study administrator."""

    path: Path
    study_id: str
    settings_overrides: dict[str, Any]
    annotators: tuple[AnnotatorEntry, ...]
    allow_unlisted_annotators: bool
    manual_assignments: dict[str, tuple[str, ...]]
    admin_passphrase: dict[str, str] | None
    training: dict[str, Any]
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> StudyConfig:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise SettingsError(f"Study configuration {path} is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise SettingsError(f"Study configuration {path} must contain a JSON object")
        annotators = []
        for entry in data.get("annotators", []):
            if isinstance(entry, str):
                annotators.append(AnnotatorEntry(entry))
            else:
                annotators.append(
                    AnnotatorEntry(str(entry["annotator_id"]), str(entry.get("display_name", "")))
                )
        allocation = data.get("allocation", {}) or {}
        assignments = {
            str(k): tuple(str(x) for x in v) for k, v in (allocation.get("assignments") or {}).items()
        }
        overrides = copy.deepcopy(data.get("settings", {}) or {})
        # Allocation strategy and seed can be given in the allocation block for readability.
        if "strategy" in allocation or "seed" in allocation:
            sel = overrides.setdefault("selection", {})
            if "strategy" in allocation:
                sel["strategy"] = allocation["strategy"]
            if "seed" in allocation:
                sel["seed"] = allocation["seed"]
        return cls(
            path=path,
            study_id=str(data.get("study_id", "")),
            settings_overrides=overrides,
            annotators=tuple(annotators),
            allow_unlisted_annotators=bool(data.get("allow_unlisted_annotators", True)),
            manual_assignments=assignments,
            admin_passphrase=data.get("admin_passphrase"),
            training=dict(data.get("training", {}) or {}),
            raw=data,
        )


def find_study_config(dataset_root: Path) -> Path | None:
    candidate = Path(dataset_root) / STUDY_CONFIG_FILENAME
    return candidate if candidate.is_file() else None


def load_settings(
    dataset_root: Path | None = None,
    overrides: dict[str, Any] | None = None,
) -> tuple[Settings, StudyConfig | None]:
    """Load defaults, then the dataset's study config, then explicit overrides."""
    data = load_default_settings_dict()
    study = None
    if dataset_root is not None:
        path = find_study_config(Path(dataset_root))
        if path is not None:
            study = StudyConfig.load(path)
            data = deep_merge(data, study.settings_overrides)
    if overrides:
        data = deep_merge(data, overrides)
    return Settings.from_dict(data), study
