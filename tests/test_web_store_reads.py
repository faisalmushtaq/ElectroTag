"""Fewer reads at sign-in (docs/architecture.md, "Signing in quickly"): the manifests of a person's assignments are
read together, and within an operation that only reads, the store reads one annotator's assignments once.

The Firestore store is run here against a small stand-in for the Firestore client that counts its reads, so these
tests need neither the emulator nor Google's libraries; tests/test_web_firestore.py runs the same operations on the
emulator."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from electrotag.web.manifest import fingerprint_of, manifest_key
from electrotag.web.service import StudyService
from electrotag.web.store import User
from electrotag.web.store_files import FilesStore
from electrotag.web.store_firestore import FirestoreStore, pack
from electrotag.web.study import WebStudy
from tests.test_web_candidates import _manifest


class _Snap:
    def __init__(self, ref: _Doc, data: dict[str, Any] | None) -> None:
        self.reference, self.id, self._data = ref, ref.id, data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict[str, Any] | None:
        return dict(self._data) if self._data is not None else None


class _Doc:
    def __init__(self, client: _Client, path: str) -> None:
        self.client, self.path, self.id = client, path, path.rsplit("/", 1)[-1]

    def collection(self, name: str) -> _Col:
        return _Col(self.client, f"{self.path}/{name}")

    def get(self) -> _Snap:
        self.client.reads.append(("get", self.path))
        return _Snap(self, self.client.docs.get(self.path))


class _Col:
    def __init__(self, client: _Client, path: str) -> None:
        self.client, self.path = client, path

    def document(self, doc_id: str) -> _Doc:
        return _Doc(self.client, f"{self.path}/{doc_id}")


class _Client:
    """The few calls of google.cloud.firestore.Client that the reads below use, counting each round trip."""

    def __init__(self) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        self.reads: list[tuple[str, Any]] = []

    def collection(self, name: str) -> _Col:
        return _Col(self, name)

    def get_all(self, refs: list[_Doc]) -> list[_Snap]:
        refs = list(refs)
        self.reads.append(("get_all", len(refs)))
        return [_Snap(r, self.docs.get(r.path)) for r in reversed(refs)]  # Firestore keeps no order


@pytest.fixture
def firestore() -> tuple[FirestoreStore, _Client]:
    client = _Client()
    store = FirestoreStore(client, "pilot")
    for i in range(1, 6):
        m = _manifest(f"ds/sub-{i:03d}.edf", "", i)
        client.docs[f"studies/pilot/manifests/{manifest_key('study', m['recording_id'])}"] = {
            "scope": "study", "recording_id": m["recording_id"], "blob": pack(m)}
    client.docs["studies/pilot/assignments/A01"] = {"programme": "set-1", "items": []}
    return store, client


def test_the_manifests_of_several_recordings_come_in_one_read(firestore) -> None:
    store, client = firestore
    keys = [("study", f"ds/sub-{i:03d}.edf") for i in (1, 2, 3, 2)] + [("study", "ds/not-registered.edf")]
    got = store.manifests_for(keys)
    assert client.reads == [("get_all", 4)]  # each document once, all in one round trip
    assert set(got) == set(keys)
    assert got[("study", "ds/sub-002.edf")]["recording_id"] == "ds/sub-002.edf"
    assert got[("study", "ds/not-registered.edf")] is None
    assert got == {k: store.manifest(*k) for k in keys}  # the same answers as reading them one by one
    client.reads.clear()
    assert store.manifests_for([]) == {} and client.reads == []


def test_within_a_read_only_operation_an_annotators_assignments_are_read_once(firestore) -> None:
    store, client = firestore
    assert store.programme("A01") == "set-1" and store.programme("a01") == "set-1"
    assert len(client.reads) == 2  # outside reading(), every call reads
    client.reads.clear()
    with store.reading():
        with store.reading():  # nested: the outer block's memory is kept
            assert store.programme("A01") == "set-1"
        assert store.programme("a01") == "set-1"
        store._assignment_doc("A01")["programme"] = "changed"  # what a caller does to its copy stays its own
        assert store.programme("A01") == "set-1"
    assert client.reads == [("get", "studies/pilot/assignments/A01")]
    client.docs["studies/pilot/assignments/A01"]["programme"] = "set-2"
    assert store.programme("A01") == "set-2"  # after the block, read afresh


def test_assignments_read_the_manifests_together_with_the_same_answer(tmp_path: Path) -> None:
    folder = tmp_path / "study"
    WebStudy.init(folder, study_id="pilot", name="Pilot")
    store = FilesStore(folder)
    try:
        store.db.add_user("A01", "password-1234", display_name="An annotator", roles=["annotator"])
        rids = [f"ds/sub-{i:03d}.edf" for i in range(1, 9)]
        for i, rid in enumerate(rids, start=1):
            store.add_manifest(_manifest(rid, "", i))
        store.assign("A01", [*rids, "ds/never-registered.edf"])
        svc = StudyService(store)
        user = User("A01", "An annotator", role="annotator")
        one_by_one = [store.manifest("study", r) for r in rids]
        calls: list[int] = []
        read_one = store.manifest
        store.manifests_for = lambda keys: (calls.append(len(keys)),  # type: ignore[method-assign]
                                            {k: read_one(*k) for k in keys})[1]
        store.manifest = lambda *a: pytest.fail("a manifest was read on its own")  # type: ignore[method-assign]
        a = svc.call("assignments", user, {})
        assert calls == [9]  # one read for every assignment, including the one not registered (left out)
        assert [i["recording_id"] for i in a["items"]] == rids
        assert [(i["file_name"], i["size_bytes"], i["n_channels"]) for i in a["items"]] == [
            (m["file_name"], fingerprint_of(m)[1], len(m["ch_names"])) for m in one_by_one]
    finally:
        store.close()
