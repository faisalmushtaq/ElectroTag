"""Experts set up reference sets as administrators do (docs/admin_area.md, "The expert area"; admin.py
EXPERT_OPERATIONS), audited under their own ID, and see accounts by ID only."""

from __future__ import annotations

from pathlib import Path

import pytest


def test_experts_set_up_reference_sets_and_nothing_else(tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app
    from tests.web_helpers import Api, copy_demo, make_template

    study = copy_demo(make_template(tmp_path / "template"), tmp_path / "study")
    app = create_app(study, demo=True)
    try:
        client = TestClient(app)
        admin = Api(client, "ADMIN")
        admin.admin_ok("user_add", {"annotator_id": "E07", "display_name": "Expert seven", "roles": ["expert"],
                                    "password": "long enough"})
        expert = Api(client, "E07", password="long enough")
        made = expert.admin_ok("set_create", {"set_id": "expert-made", "name": "Made by an expert"})
        assert made["set"]["set_id"] == "expert-made"
        assert "expert-made" in {s["set_id"] for s in expert.admin_ok("sets_list", {})["sets"]}
        expert.admin_ok("set_update", {"set_id": "expert-made", "description": "for the pilot"})
        entries = admin.admin_ok("audit", {})["entries"]
        mine = [e for e in entries if e["by"] == "E07"]
        assert {e["op"] for e in mine} >= {"set_create", "set_update"}
        # accounts by ID and roles only
        users = expert.admin_ok("users_list", {})["users"]
        assert all(set(u) == {"annotator_id", "roles"} for u in users)
        assert {"annotator_id": "E07", "roles": ["expert"]} in users
        assert "display_name" in admin.admin_ok("users_list", {})["users"][0]
        # the rest of the admin area stays closed
        for op, body in (("overview", {}), ("user_add", {"annotator_id": "X99"}), ("settings_get", {}),
                         ("recordings_register", {"manifests": []}), ("results_zip", {})):
            r = expert.admin(op, body)
            assert r.status_code == 403, op
            assert r.json()["error"] == "forbidden"
        expert.admin_ok("set_delete", {"set_id": "expert-made"})
    finally:
        app.state.store.close()
