"""Table-driven tests of the convergence rules (pure function, no database)."""
from __future__ import annotations

import pytest

from fleethub.domain.reconciler import VERIFY_WINDOW_S, evaluate

NOW = 10_000
SRC = {"id": "s", "last_sync_at": NOW - 60, "fresh_threshold_s": 900, "stale_threshold_s": 21600}
DEP = {"id": "d", "managed": 1}
REV = {"id": "r2", "rev_no": 2, "model_version_id": "mv2", "engine_version_id": "ev2", "image_id": "img2", "created_at": NOW - 3000}


def obs(**kw):
    o = {"id": "o", "present": 1, "model_version_id": "mv2", "engine_version_id": "ev2", "image_id": "img2",
         "model_raw": "m:2", "engine_raw": "e:2", "image_digest_raw": "sha256:2", "health": "healthy", "observed_at": NOW - 100}
    o.update(kw)
    return o


def req(status="completed"):
    return {"id": "q", "status": status}


def op(status="reported_succeeded", finished=NOW - 1000):
    return {"id": "op", "status": status, "finished_at": finished, "timeout_at": NOW + 5000, "result_message": None}


def run(**kw):
    args = dict(deployment=DEP, revision=REV, request=req(), operation=op(), obs=obs(), source=SRC, prev=None, now=NOW)
    args.update(kw)
    return evaluate(**args)


def test_converged_requires_post_op_evidence():
    assert run().state == "converged"
    # Inventory last synced BEFORE the operation finished: a matching snapshot is not proof yet.
    c = run(operation=op(finished=NOW - 30))
    assert c.state == "verifying" and not c.post_op_evidence


def test_unmanaged():
    assert run(deployment={"id": "d", "managed": 0}, revision=None).state == "unmanaged"


def test_in_flight_is_converging():
    assert run(request=req("submitted"), operation=op("running", None)).state == "converging"


def test_apply_failed():
    assert run(operation=op("reported_failed")).state == "apply_failed"


def test_phantom_success_after_deadline():
    old = obs(model_version_id="mv1", image_id="img1")
    within = run(obs=old, operation=op(finished=NOW - VERIFY_WINDOW_S + 60))
    assert within.state == "verifying"
    after = run(obs=old, operation=op(finished=NOW - VERIFY_WINDOW_S - 60))
    assert after.state == "not_observed_after_success"
    assert {d["field"] for d in after.diff} == {"model_version", "image"}


def test_stale_source_is_unverifiable_never_ok():
    stale = dict(SRC, last_sync_at=NOW - 3600)
    assert run(source=stale).state == "unverifiable"
    never = dict(SRC, last_sync_at=None)
    assert run(source=never).state == "unverifiable"


def test_digest_only_drift_detected():
    prev = {"last_converged_revision_id": "r2", "last_converged_at": NOW - 900}
    c = run(obs=obs(image_id=None, image_digest_raw="sha256:hotfix"), prev=prev)
    assert c.state == "drifted"
    assert c.diff == [{"field": "image", "desired": "img2", "observed": None, "observed_raw": "sha256:hotfix", "unrecognized": True}]


def test_missing_after_converged():
    prev = {"last_converged_revision_id": "r2", "last_converged_at": NOW - 900}
    assert run(obs=obs(present=0), prev=prev).state == "missing"


def test_timed_out_without_result_but_inventory_proves_success():
    assert run(operation=op("timed_out", None) | {"timeout_at": NOW - 500}).state == "converged"
    c = run(operation=op("timed_out", None) | {"timeout_at": NOW - VERIFY_WINDOW_S - 10}, obs=obs(model_version_id="mv1"))
    assert c.state == "apply_failed"


@pytest.mark.parametrize("prev_rev", ["r1", None])
def test_retry_of_same_revision_is_not_drift(prev_rev):
    # Converged earlier on a different revision -> mismatch is "verifying", not drift.
    prev = {"last_converged_revision_id": prev_rev, "last_converged_at": NOW - 5000}
    assert run(obs=obs(model_version_id="mv1"), prev=prev, operation=op(finished=NOW - 60)).state == "verifying"
