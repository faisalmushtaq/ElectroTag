"""Component B: inter-rater agreement for continuous EEG artifact annotations.

Typical use::

    from electrotag.reliability import AnalysisConfig, run_analysis, write_outputs
    result = run_analysis(["Annotated_Events"], AnalysisConfig())
    write_outputs(result, "agreement_results")

See ``docs/reliability_guide.md`` for the measures and their assumptions.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

# Loaded when first asked for, so that importing a light submodule (``electrotag.reliability.probability``,
# which the web service uses) does not load pandas and SciPy with the analysis.
_WHERE = {
    "MEASURES": "analysis", "AnalysisResult": "analysis", "register_measure": "analysis", "run_analysis": "analysis",
    "write_outputs": "analysis", "AnalysisConfig": "config", "build_dataset": "data", "load_dataset": "data",
}


def __getattr__(name: str) -> Any:
    if name in _WHERE:
        return getattr(import_module(f"electrotag.reliability.{_WHERE[name]}"), name)
    raise AttributeError(f"module 'electrotag.reliability' has no attribute {name!r}")

__all__ = [
    "MEASURES",
    "AnalysisConfig",
    "AnalysisResult",
    "build_dataset",
    "load_dataset",
    "register_measure",
    "run_analysis",
    "write_outputs",
]
