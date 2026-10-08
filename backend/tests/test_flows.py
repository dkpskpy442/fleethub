"""End-to-end flows through the HTTP API on a seeded SQLite database."""
from __future__ import annotations

from conftest import Api


def vuln_id(api: Api, ext: str) -> str:
    return next(v["id"] for v in api.get("/vulnerabilities") if v["external_id"] == ext)


def create_rollout(api: Api, persona: str, *, kind: str, mv=None, ev=None, deployment_ids=None, linked=None,
                   justify=True, title="test rollout") -> dict:
    pv = api.post("/rollouts/preview", {"kind": kind, "target_model_version_id": mv, "target_engine_version_id": ev,
                                        "deployment_ids": deployment_ids}, persona=persona)
    just = {t["deployment"]["id"]: "accepted for test" for t in pv["targets"] if t["guardrails"]["outcome"] == "warn"} if justify else {}
    return api.post("/rollouts", {"title": title, "kind": kind, "target_model_version_id": mv, "target_engine_version_id": ev,
                                  "linked_vulnerability_id": linked, "reason": "test", "waves": pv["suggested_waves"],
                                  "justifications": just, "submit": True}, persona=persona)


def run_until(api: Api, rid: str, statuses: set[str], max_minutes: int = 600) -> dict:
    r = api.get(f"/rollouts/{rid}")
    waited = 0
    while r["status"] not in statuses and waited < max_minutes:
        api.advance(5)
        waited += 5
        r = api.get(f"/rollouts/{rid}")
    return r


def release_seeded_tei_rollout(api: Api) -> None:
    """The seed has a submitted TEI rollout holding locks on lumen-embed deployments."""
    r = next(x for x in api.get("/rollouts") if x["title"].startswith("Lumen Embed"))
    api.post(f"/rollouts/{r['id']}/cancel", {"comment": "superseded by test"})


def targets(r: dict) -> list[dict]:
    return [t for w in r["waves"] for t in w["targets"]]


def test_cve_remediation_end_to_end(api: Api):
    """Vuln -> remediation options -> staged rollout -> approval -> deploy -> inventory -> finding remediated."""
    # eu-west inventory is down in the seed; bring it back so the exposed deployment is verifiable.
    api.post("/sim/source", {"source_id": "src_inv_euw", "offline": False})
    api.post("/sim/sync")
    vid = vuln_id(api, "SIM-2026-0167")
    v = api.get(f"/vulnerabilities/{vid}")
    exposed = [e for e in v["exposure"] if e["exposure"]["observed"]]
    assert [e["service_name"] for e in exposed] == ["atlas-chat-batch"]
    opt = next(o for o in v["remediation_options"] if o["label"] == "vLLM 0.10.0")
    assert opt["counts"]["blocked"] == 0

    r = create_rollout(api, "u_jordan", kind="engine", ev=opt["engine_version_id"],
                       deployment_ids=[e["id"] for e in exposed], linked=vid)
    assert r["status"] == "ready" and r["approval_status"] == "pending"
    api.post(f"/rollouts/{r['id']}/approve", {"comment": "ok"}, persona="u_jordan", expect=403)  # no self-approval
    api.post(f"/rollouts/{r['id']}/approve", {"comment": "ok"}, persona="u_taylor")
    api.post(f"/rollouts/{r['id']}/start")
    r = run_until(api, r["id"], {"completed", "paused"})
    assert r["status"] == "completed", r["pause_reason"]

    dep = api.get(f"/deployments/{exposed[0]['id']}")
    assert dep["convergence"]["state"] == "converged"
    assert dep["observed"]["engine_version"]["label"] == "vLLM 0.10.0"
    assert dep["desired"]["source"] == "rollout"
    v = api.get(f"/vulnerabilities/{vid}")
    assert {f["status"] for f in v["findings"] if f["image"]["accelerator"] == "cuda"} == {"remediated"}
    actions = [a["action"] for a in api.get("/audit?limit=500")]
    assert "finding.remediated" in actions and "rollout.approved" in actions


def test_phantom_success_pauses_then_retry(api: Api):
    """Deployer says success, inventory disagrees -> target fails, rollout pauses; retry converges."""
    r = next(x for x in api.get("/rollouts") if x["title"] == "Forge Coder 3.1 rollout")
    r = run_until(api, r["id"], {"paused", "completed"})
    assert r["status"] == "paused"
    failed = [t for t in targets(r) if t["status"] == "failed"]
    assert len(failed) == 1 and failed[0]["failure_reason"].startswith("claimed_success_not_observed")
    assert failed[0]["request"]["operation"]["status"] == "reported_succeeded"
    api.post(f"/rollouts/{r['id']}/resume", expect=409)  # unresolved failure
    api.post(f"/rollouts/{r['id']}/targets/{failed[0]['id']}/verify", {"comment": "x"}, persona="u_jordan", expect=403)
    api.post(f"/rollouts/{r['id']}/targets/{failed[0]['id']}/retry")
    api.advance(30)
    r = api.get(f"/rollouts/{r['id']}")
    t = next(t for t in targets(r) if t["id"] == failed[0]["id"])
    assert t["status"] == "succeeded" and not t["manually_verified"]


def test_manual_verify_is_admin_only_and_flagged(api: Api):
    r = next(x for x in api.get("/rollouts") if x["title"] == "Forge Coder 3.1 rollout")
    r = run_until(api, r["id"], {"paused"})
    failed = next(t for t in targets(r) if t["status"] == "failed")
    api.post(f"/rollouts/{r['id']}/targets/{failed['id']}/verify", {"comment": ""}, persona="u_alex", expect=400)
    r = api.post(f"/rollouts/{r['id']}/targets/{failed['id']}/verify", {"comment": "Checked pods by hand"}, persona="u_alex")
    t = next(t for t in targets(r) if t["id"] == failed["id"])
    assert t["status"] == "succeeded" and t["manually_verified"]


def test_stale_inventory_fails_as_unverifiable_and_recovers(api: Api):
    r = next(x for x in api.get("/rollouts") if x["title"] == "Forge Coder 3.1 rollout")
    api.post("/sim/fault", {"target_id": "tgt_prd-usw-h100-1", "kind": "fail"})  # replace phantom w/ ... then clear all
    for f in api.get("/sim")["faults"]:
        if f["target_id"] == "tgt_prd-usw-h100-1":
            api._do("DELETE", f"/sim/fault/{f['id']}", "u_jordan")
    r = run_until(api, r["id"], {"paused", "completed"})
    failed = [t for t in targets(r) if t["status"] == "failed"]
    assert failed and failed[0]["deployment"]["target"]["name"] == "prd-euw-h100-1"
    assert failed[0]["failure_reason"].startswith("unverifiable_stale_inventory")
    api.post("/sim/source", {"source_id": "src_inv_euw", "offline": False})
    api.post(f"/rollouts/{r['id']}/targets/{failed[0]['id']}/retry")
    api.post(f"/rollouts/{r['id']}/resume")
    r = run_until(api, r["id"], {"completed", "paused"})
    assert r["status"] == "completed"


def test_health_gate_then_target_rollback(api: Api):
    """Unhealthy new version -> auto-pause -> single-target rollback restores previous revision."""
    release_seeded_tei_rollout(api)
    api.post("/sim/fault", {"target_id": "tgt_dev-use-h100-1", "kind": "unhealthy"})
    dep = api.deployment("lumen-embed", "dev-use-h100-1")
    prev_ev = dep["desired"]["engine_version"]["id"]
    r = create_rollout(api, "u_jordan", kind="engine", ev="ev_tei_1_7", deployment_ids=[dep["id"]])
    assert r["approval_status"] == "not_required"
    api.post(f"/rollouts/{r['id']}/start")
    r = run_until(api, r["id"], {"paused", "completed"})
    assert r["status"] == "paused"
    t = targets(r)[0]
    assert t["failure_reason"].startswith("health_gate")
    r = api.post(f"/rollouts/{r['id']}/targets/{t['id']}/rollback", {"comment": "bad build"})
    api.advance(30)
    d = api.get(f"/deployments/{dep['id']}")
    assert d["desired"]["source"] == "rollback"
    assert d["desired"]["engine_version"]["id"] == prev_ev
    assert d["convergence"]["state"] == "converged"
    assert d["lock"] is None
    revs = [x["source"] for x in d["revisions"]]
    assert revs[:3] == ["rollback", "rollout", "seed"]  # history preserved, never rewritten


def test_rollback_all_reverse_order(api: Api):
    release_seeded_tei_rollout(api)
    ids = [api.deployment("lumen-embed", c)["id"] for c in ("dev-use-h100-1", "stg-use-h100-1")]
    r = create_rollout(api, "u_jordan", kind="engine", ev="ev_tei_1_7", deployment_ids=ids)
    api.post(f"/rollouts/{r['id']}/start")
    r = run_until(api, r["id"], {"completed"})
    r = api.post(f"/rollouts/{r['id']}/rollback", {"comment": "regression in recall@10"})
    r = run_until(api, r["id"], {"rolled_back"})
    assert r["status"] == "rolled_back"
    for i in ids:
        assert api.get(f"/deployments/{i}")["observed"]["engine_version"]["label"] == "Text Embeddings Inference 1.6"


def test_drift_reconcile_and_accept_guardrails(api: Api):
    d = api.deployment("atlas-chat", "prd-use-h100-2")
    assert d["convergence"]["state"] == "drifted"
    # Hotfix image is not in the catalog -> cannot be accepted as desired state.
    api.post(f"/deployments/{d['id']}/accept-observed", {"reason": "keep hotfix"}, expect=409)
    api.post(f"/deployments/{d['id']}/reconcile", {"reason": "revert hotfix"}, persona="u_priya", expect=403)
    api.post(f"/deployments/{d['id']}/reconcile", {"reason": "revert hotfix"})
    api.advance(20)
    assert api.get(f"/deployments/{d['id']}")["convergence"]["state"] == "converged"

    # Manual downgrade to an engine with a critical CVE: accept-observed is blocked by guardrails.
    d2 = api.deployment("atlas-chat", "prd-use-h100-1")
    api.post("/sim/drift", {"deployment_id": d2["id"], "kind": "engine_downgrade"})
    api.post("/sim/sync")
    d2 = api.get(f"/deployments/{d2['id']}")
    assert d2["convergence"]["state"] == "drifted"
    err = api.post(f"/deployments/{d2['id']}/accept-observed", {"reason": "it works"}, expect=422)
    assert err["error"]["code"] == "guardrail_blocked"


def test_adopt_unmanaged_then_include_in_rollout(api: Api):
    d = api.deployment("sentinel-guard-shadow", "prd-use-l4-1")
    assert d["convergence"]["state"] == "unmanaged" and not d["managed"]
    pv = api.post("/rollouts/preview", {"kind": "engine", "target_engine_version_id": "ev_vllm_0_10_1",
                                        "deployment_ids": [d["id"]]})
    assert any(c["code"] == "unmanaged" for c in pv["targets"][0]["guardrails"]["checks"])
    api.post(f"/deployments/{d['id']}/adopt", {"reason": "shadow traffic is now official"})
    api.advance(10)
    d = api.get(f"/deployments/{d['id']}")
    assert d["managed"] and d["desired"]["source"] == "adopt" and d["convergence"]["state"] == "converged"
    pv = api.post("/rollouts/preview", {"kind": "engine", "target_engine_version_id": "ev_vllm_0_10_1",
                                        "deployment_ids": [d["id"]]})
    assert pv["targets"][0]["guardrails"]["outcome"] == "warn"  # preview engine in prod


def test_locks_block_direct_changes(api: Api):
    d = api.deployment("forge-coder", "prd-usw-h100-1")
    assert d["lock"]["rollout"]["title"] == "Forge Coder 3.1 rollout"
    err = api.post(f"/deployments/{d['id']}/reconcile", {"reason": "x"}, expect=409)
    assert err["error"]["code"] == "locked"
    pv = api.post("/rollouts/preview", {"kind": "model", "target_model_version_id": "mv_coder_3_1", "deployment_ids": [d["id"]]})
    assert pv["targets"][0]["guardrails"]["outcome"] == "blocked"


def test_mid_rollout_lifecycle_change_requires_reacknowledgement(api: Api):
    release_seeded_tei_rollout(api)
    ids = [api.deployment("lumen-embed", c)["id"] for c in ("dev-use-h100-1", "prd-use-l4-1")]
    r = create_rollout(api, "u_jordan", kind="engine", ev="ev_tei_1_7", deployment_ids=ids)
    api.post(f"/rollouts/{r['id']}/approve", {"comment": "ok"}, persona="u_taylor")
    api.post(f"/rollouts/{r['id']}/start")
    # Deprecate the target engine version while the first wave runs.
    api.post("/engine-versions/ev_tei_1_7/lifecycle", {"to": "deprecated", "reason": "superseded"})
    r = run_until(api, r["id"], {"paused", "completed"})
    assert r["status"] == "paused" and "engine_deprecated" in r["pause_reason"]
    api.post(f"/rollouts/{r['id']}/resume", expect=409)
    pending = next(t for t in targets(r) if t["unacknowledged"])
    api.post(f"/rollouts/{r['id']}/targets/{pending['id']}/acknowledge", {"comment": "fine for one more week"})
    api.post(f"/rollouts/{r['id']}/resume")
    r = run_until(api, r["id"], {"completed", "paused"})
    assert r["status"] == "completed"


def test_rbac_and_lifecycle_rules(api: Api):
    release_seeded_tei_rollout(api)
    # Model owners can only manage their own team's models.
    api.post("/model-versions/mv_coder_3_2/lifecycle", {"to": "production", "reason": "x"}, persona="u_marcus", expect=403)
    api.post("/model-versions/mv_coder_3_2/lifecycle", {"to": "production", "reason": "evals passed"}, persona="u_ana")
    # Retired is terminal; and in-use versions cannot be retired.
    api.post("/model-versions/mv_atlas_1_8/lifecycle", {"to": "production", "reason": "x"}, persona="u_marcus", expect=409)
    err = api.post("/model-versions/mv_atlas_2_1/lifecycle", {"to": "deprecated", "reason": "2.2 soon"}, persona="u_marcus")
    assert err["lifecycle"] == "deprecated"
    api.post("/model-versions/mv_atlas_2_1/lifecycle", {"to": "retired", "reason": "x"}, persona="u_marcus", expect=409)
    # Viewers can't draft rollouts; security engineers can draft but not submit.
    pv = api.post("/rollouts/preview", {"kind": "engine", "target_engine_version_id": "ev_tei_1_7",
                                        "deployment_ids": [api.deployment("lumen-embed", "dev-use-h100-1")["id"]]})
    body = {"title": "t", "kind": "engine", "target_engine_version_id": "ev_tei_1_7", "waves": pv["suggested_waves"],
            "justifications": {}, "submit": False}
    api.post("/rollouts", body, persona="u_priya", expect=403)
    draft = api.post("/rollouts", body, persona="u_riley")
    api.post(f"/rollouts/{draft['id']}/submit", persona="u_riley", expect=403)
    api.post(f"/rollouts/{draft['id']}/submit", persona="u_jordan")


def test_overview_attention_is_explicit_about_unknowns(api: Api):
    ov = api.get("/overview")
    cats = {i["category"] for i in ov["attention"]}
    assert {"vulnerability", "drift", "unmanaged", "freshness", "health", "rollout"} <= cats
    assert ov["counts"]["freshness"].get("unknown", 0) + ov["counts"]["freshness"].get("stale", 0) >= 7
    never = api.deployment("atlas-chat", "prd-apne-mi300-bm")
    assert never["health"] == "unknown" and never["convergence"]["state"] == "unverifiable"
