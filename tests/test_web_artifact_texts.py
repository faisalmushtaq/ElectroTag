"""The study's own words for its artifact types (electrotag/web/artifact_texts.py; docs/api.md,
"artifact_texts_list" and "artifact_text_set"): an expert or administrator changes a type's description and its
guide entry's words, everyone's catalogue carries them, and each field goes back to the original on request."""

from __future__ import annotations

from pathlib import Path

import pytest

BLINK = "Eye-blink-artifact"


def test_experts_and_administrators_put_a_type_in_the_study_s_own_words(tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app
    from tests.web_helpers import Api, admin_audit, copy_demo, make_template

    study = copy_demo(make_template(tmp_path / "template"), tmp_path / "study")
    app = create_app(study, demo=True)
    try:
        client = TestClient(app)
        admin = Api(client, "ADMIN")
        a01 = Api(client, "A01")
        first = admin.admin_ok("artifact_texts_list")
        assert first["texts"] == {} and first["original"][BLINK]
        original = first["original"][BLINK]
        # an expert may do it too
        admin.admin_ok("user_add", {"annotator_id": "E07", "roles": ["expert"], "password": "long enough"})
        expert = Api(client, "E07", password="long enough")
        r = expert.admin_ok("artifact_text_set", {"label": BLINK, "fields": {
            "description": "  A blink, in our words.  ", "shape": "A quick dip.",
            "apart": [["EMG-artifact", "is fast and spiky."]]}})
        assert r["text"]["fields"] == {"description": "A blink, in our words.", "shape": "A quick dip.",
                                       "apart": [["EMG-artifact", "is fast and spiky."]]}
        assert r["text"]["changed_by"] == "E07"
        lab = next(x for x in a01.ok("get", "/me")["catalogue"]["labels"] if x["label"] == BLINK)
        assert lab["description"] == "A blink, in our words."
        assert lab["guide"] == {"shape": "A quick dip.", "apart": [["EMG-artifact", "is fast and spiky."]]}
        other = next(x for x in a01.ok("get", "/me")["catalogue"]["labels"] if x["label"] == "EMG-artifact")
        assert "guide" not in other
        entry = admin_audit(admin)[0]
        assert entry["op"] == "artifact_text_set" and entry["by"] == "E07"
        assert entry["details"]["changed"] == ["description", "shape", "apart"]
        # the same again changes nothing and writes nothing more
        n = len(admin_audit(admin))
        admin.admin_ok("artifact_text_set", {"label": BLINK, "fields": {"shape": "A quick dip."}})
        assert len(admin_audit(admin)) == n
        # back to the original, field by field
        r = admin.admin_ok("artifact_text_set", {"label": BLINK, "fields": {"description": None}})
        assert set(r["text"]["fields"]) == {"shape", "apart"}
        labels = a01.ok("get", "/me")["catalogue"]["labels"]
        assert next(x for x in labels if x["label"] == BLINK)["description"] == original
        r = admin.admin_ok("artifact_text_set", {"label": BLINK, "fields": {"shape": None, "apart": None}})
        assert r["text"] is None and admin.admin_ok("artifact_texts_list")["texts"] == {}
        # refused in plain words
        for body in ({"label": "Nothing", "fields": {"shape": "x"}}, {"label": BLINK, "fields": {}},
                     {"label": BLINK, "fields": {"colour": "red"}}, {"label": BLINK, "fields": {"description": " "}},
                     {"label": BLINK, "fields": {"apart": [["Nothing", "x"]]}},
                     {"label": BLINK, "fields": {"shape": "x" * 2001}}):
            admin.admin_error("artifact_text_set", body, 400, "bad_request")
        Api(client, "A01").admin_error("artifact_texts_list", {}, 403, "forbidden")
    finally:
        app.state.store.close()
