"""Guardrail outcomes for the seeded remediation scenario (vLLM 0.9.1 -> 0.10.0)."""
from __future__ import annotations

from fleethub.db.store import Store
from fleethub.domain import guardrails as G


def dep(store: Store, service: str, cluster: str) -> dict:
    return next(d for d in store.rows("deployments")
                if d["service_name"] == service and store.must("deployment_targets", d["target_id"])["name"] == cluster)


def outcome(store: Store, service: str, cluster: str, ev: str) -> G.GuardrailResult:
    d = dep(store, service, cluster)
    mv, _ = G.spec_for_change(store, d, "engine", None, ev)
    return G.evaluate(store, d, mv, ev)


def codes(res: G.GuardrailResult, level: str) -> set[str]:
    return {c.code for c in res.checks if c.level == level}


def test_certified_is_ok(store):
    res = outcome(store, "atlas-chat", "prd-use-h100-1", "ev_vllm_0_10_0")
    assert res.outcome == "ok" and res.image_id == "img_vllm_0_10_0_cuda"


def test_untested_hardware_warns(store):
    res = outcome(store, "atlas-chat", "prd-usw-mi300-1", "ev_vllm_0_10_0")
    assert "compat_untested" in codes(res, "warn") and res.image_id == "img_vllm_0_10_0_rocm"


def test_known_issues_warns(store):
    assert "compat_known_issues" in codes(outcome(store, "atlas-chat-mini", "prd-euw-a100-1", "ev_vllm_0_10_0"), "warn")


def test_incompatible_blocks(store):
    res = outcome(store, "sentinel-guard", "prd-use-l4-1", "ev_vllm_0_10_0")
    assert "compat_incompatible" in codes(res, "block")
    # ...while the preview release that fixes it only warns.
    res = outcome(store, "sentinel-guard", "prd-use-l4-1", "ev_vllm_0_10_1")
    assert codes(res, "block") == set() and "engine_preview_prod" in codes(res, "warn")


def test_unsupported_hardware_blocks(store):
    # 0.10.1 ships no ROCm image.
    assert "unsupported_hardware" in codes(outcome(store, "atlas-chat", "prd-usw-mi300-1", "ev_vllm_0_10_1"), "block")


def test_critical_vuln_blocks_target_image(store):
    assert "vuln_critical" in codes(outcome(store, "atlas-chat-batch", "prd-euw-h100-1", "ev_vllm_0_9_1"), "block")


def test_deprecated_model_and_stale_data_warn(store):
    res = outcome(store, "atlas-chat", "prd-apne-a100-1", "ev_vllm_0_10_0")
    assert "model_deprecated" in codes(res, "warn")
    res = outcome(store, "atlas-chat", "prd-euw-h100-1", "ev_vllm_0_10_0")
    assert "stale_target_data" in codes(res, "warn")


def test_retired_model_and_family_mismatch_block(store):
    d = dep(store, "atlas-chat", "prd-use-h100-1")
    assert "model_retired" in codes(G.evaluate(store, d, "mv_atlas_1_8", "ev_vllm_0_10_0"), "block")
    assert "family_mismatch" in codes(G.evaluate(store, d, "mv_mini_1_2", "ev_vllm_0_10_0"), "block")


def test_noop_detected(store):
    res = outcome(store, "atlas-chat", "prd-use-h100-1", "ev_vllm_0_9_1")
    assert res.noop
