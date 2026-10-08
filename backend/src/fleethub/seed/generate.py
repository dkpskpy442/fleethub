"""Generate the demo seed by *running* FleetHub over ~30 simulated hours.

Static catalog/topology is inserted directly; everything with history (deployments, desired
revisions, requests, operations, observations, findings, rollouts, audit) is produced by the real
domain services and simulation, so the seeded state is internally consistent.

    uv run python -m fleethub.seed.generate      # writes seed_data.py + ../../../seed/seed.sql
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from ..db.sqlite_driver import SqliteDriver
from ..db.store import TABLE_ORDER, Store
from ..domain import rollouts, simulation, vulns
from ..domain.desired_state import create_revision, request_apply
from ..domain.rbac import SYSTEM, Actor
from ..domain.util import HOUR, MINUTE, jdump
from . import catalog_data as C
from .loader import to_sql

FAMILY_ENGINES = {
    "fam_atlas": ["eng_vllm"], "fam_mini": ["eng_vllm"], "fam_guard": ["eng_vllm"],
    "fam_coder": ["eng_trt", "eng_vllm"], "fam_embed": ["eng_tei"], "fam_iris": ["eng_sglang"],
}


def mv_id(fam: str, version: str) -> str:
    return f"mv_{fam[4:]}_{version.replace('.', '_')}"


def ev_id(eng: str, version: str) -> str:
    return f"ev_{eng[4:]}_{version.replace('.', '_')}"


def img_id(eng: str, version: str, accel: str) -> str:
    return f"img_{eng[4:]}_{version.replace('.', '_')}_{accel}"


def insert_static(s: Store, start: int) -> None:
    s.insert("sim_state", {"id": "sim", "now": start, "playing": 0, "speed": 60, "last_real_ms": None, "seq": 0})
    for i, n, slug in C.TEAMS:
        s.insert("teams", {"id": i, "name": n, "slug": slug})
    for i, n, e, title, role, team in C.USERS:
        s.insert("users", {"id": i, "name": n, "email": e, "title": title, "role": role, "team_id": team})
    for i, n, vendor, mem, accel in C.HARDWARE:
        s.insert("hardware_types", {"id": i, "name": n, "vendor": vendor, "memory_gb": mem, "accelerator": accel})
    for i, n, slug, modality, owner, desc in C.FAMILIES:
        s.insert("model_families", {"id": i, "name": n, "slug": slug, "description": desc, "modality": modality,
                                    "owner_team_id": owner, "created_at": C.T0 - 400 * C.DAY})
    for fam, ver, lc, params, ctx, quant, ago in C.MODEL_VERSIONS:
        slug = next(f[2] for f in C.FAMILIES if f[0] == fam)
        s.insert("model_versions", {
            "id": mv_id(fam, ver), "family_id": fam, "version": ver, "lifecycle": lc,
            "artifact_uri": f"s3://model-registry/{slug}/{ver}/", "artifact_digest": C.digest(f"{slug}:{ver}"),
            "format": "safetensors", "quantization": quant, "params_b": params, "context_len": ctx,
            "released_at": C.T0 - ago * C.DAY, "lifecycle_changed_at": C.T0 - max(1, ago // 2) * C.DAY, "notes": None,
        })
    for i, n, slug, owner, desc, repo in C.ENGINES:
        s.insert("engines", {"id": i, "name": n, "slug": slug, "description": desc, "owner_team_id": owner, "repo_url": repo})
    for eng, ver, lc, ago, rocm in C.ENGINE_VERSIONS:
        slug = next(e[2] for e in C.ENGINES if e[0] == eng)
        s.insert("engine_versions", {"id": ev_id(eng, ver), "engine_id": eng, "version": ver, "lifecycle": lc,
                                     "released_at": C.T0 - ago * C.DAY, "lifecycle_changed_at": C.T0 - ago * C.DAY,
                                     "release_notes": f"{slug} {ver} release."})
        for accel, hws in (("cuda", C.CUDA_HW), ("rocm", ["hw_mi300x"])):
            if accel == "rocm" and not rocm:
                continue
            iid = img_id(eng, ver, accel)
            s.insert("engine_images", {"id": iid, "engine_version_id": ev_id(eng, ver),
                                       "repo": f"registry.example.test/inference/{slug}",
                                       "tag": f"{ver}-{'cu124' if accel == 'cuda' else 'rocm6.2'}",
                                       "digest": C.digest(f"{slug}:{ver}:{accel}"), "accelerator": accel,
                                       "built_at": C.T0 - ago * C.DAY})
            for hw in hws:
                s.insert("engine_image_hardware", {"id": f"{iid}:{hw}", "image_id": iid, "hardware_type_id": hw})
    # Compatibility
    for fam, ver, lc, *_ in C.MODEL_VERSIONS:
        if lc == "retired":
            continue
        for eng in FAMILY_ENGINES[fam]:
            for e, ev_ver, ev_lc, _, rocm in C.ENGINE_VERSIONS:
                if e != eng:
                    continue
                hws = C.CUDA_HW + (["hw_mi300x"] if rocm else [])
                for hw in hws:
                    key = (fam, ver, eng, ev_ver, hw)
                    if key in C.COMPAT_OVERRIDES:
                        ov = C.COMPAT_OVERRIDES[key]
                        if ov is None:
                            continue
                        status, notes = ov
                    elif lc == "experimental" or ev_lc == "preview":
                        if hw != "hw_h100":
                            continue
                        status, notes = "compatible", "Early validation on H100 only."
                    elif eng == "eng_vllm" and fam == "fam_coder" and hw != "hw_mi300x":
                        continue  # coder only runs on vLLM for AMD
                    else:
                        status, notes = "certified", None
                    s.insert("compatibility_records", {
                        "id": f"cmp_{mv_id(fam, ver)[3:]}_{ev_id(eng, ev_ver)[3:]}_{hw[3:]}",
                        "model_version_id": mv_id(fam, ver), "engine_version_id": ev_id(eng, ev_ver),
                        "hardware_type_id": hw, "status": status,
                        "evidence_url": f"https://evals.example.test/{fam[4:]}-{ver}/{eng[4:]}-{ev_ver}/{hw[3:]}",
                        "notes": notes, "verified_by": "u_jordan", "verified_at": C.T0 - 10 * C.DAY,
                    })
    for i, n, tier, sort in C.ENVIRONMENTS:
        s.insert("environments", {"id": i, "name": n, "tier": tier, "sort": sort})
    for i, n, cloud, sort in C.REGIONS:
        s.insert("regions", {"id": i, "name": n, "cloud": cloud, "sort": sort})
    for i, kind, n, desc, interval, fresh, stale in C.SOURCES:
        s.insert("data_sources", {"id": i, "kind": kind, "name": n, "description": desc, "sync_interval_s": interval,
                                  "fresh_threshold_s": fresh, "stale_threshold_s": stale,
                                  "last_sync_at": start if kind == "deployer" else None,
                                  "last_sync_status": None, "last_error": None})
    for name, env, reg, hw, src in C.TARGETS:
        s.insert("deployment_targets", {"id": f"tgt_{name}", "name": name, "environment_id": env, "region_id": reg,
                                        "hardware_type_id": hw, "inventory_source_id": src, "deployer": "sim-deployer"})
    for ext, title, sev, cvss, pkg, desc, fix, affected, offset in C.CVE_FEED:
        digests = []
        for eng, ver, accel in affected:
            for a in ("cuda", "rocm"):
                if accel and a != accel:
                    continue
                img = s.get("engine_images", img_id(eng, ver, a))
                if img:
                    digests.append(img["digest"])
        s.insert("sim_cve_feed", {
            "id": f"feed_{ext.lower().replace('-', '_')}", "external_id": ext,
            "payload_json": jdump({"external_id": ext, "title": title, "severity": sev, "cvss": cvss, "package": pkg,
                                   "description": desc, "fixed_in_note": fix}),
            "image_digests_json": jdump(digests), "publish_at": None if offset is None else C.T0 + offset, "published": 0,
        })
    # The legacy bare-metal exporter has never reported.
    s.insert("sim_faults", {"id": "fault_legacy_outage", "kind": "source_offline", "target_id": None,
                            "source_id": "src_inv_legacy", "remaining": -1, "created_at": start,
                            "note": "exporter never configured"})


def actor(s: Store, uid: str) -> Actor:
    u = s.must("users", uid)
    return Actor(u["id"], u["name"], u["role"], u["team_id"])


async def run_rollout(s: Store, ad: simulation.Adapters, *, title: str, kind: str, mv: str | None, ev: str | None,
                      creator: str, executor: str, deployment_ids: list[str], reason: str,
                      justifications: dict[str, str] | None = None, approve: bool = True, start: bool = True,
                      linked_vuln: str | None = None, canary_bake: int | None = None) -> dict[str, Any]:
    waves = rollouts.generate_waves(s, deployment_ids)
    for w in waves:
        if canary_bake and w["name"].startswith("Prod canary"):
            w["bake_minutes"] = canary_bake
    r = rollouts.create_draft(s, actor(s, creator), title=title, kind=kind, target_model_version_id=mv,
                              target_engine_version_id=ev, reason=reason, waves=waves,
                              justifications=justifications or {}, linked_vulnerability_id=linked_vuln)
    rollouts.submit(s, actor(s, creator), r)
    if approve and r["approval_status"] == "pending":
        rollouts.decide(s, actor(s, "u_taylor"), r, "approved", "Change window confirmed; canary metrics look good.")
    if start:
        rollouts.start(s, actor(s, executor), r)
    await simulation.run_cycle(s, ad)
    return r


def deps(s: Store, service: str, clusters: list[str] | None = None) -> list[str]:
    out = []
    for d in s.rows("deployments"):
        name = s.must("deployment_targets", d["target_id"])["name"]
        if d["service_name"] == service and (clusters is None or name in clusters):
            out.append(d["id"])
    return sorted(out, key=lambda i: s.must("deployment_targets", s.must("deployments", i)["target_id"])["name"])


async def build() -> SqliteDriver:
    db = SqliteDriver(":memory:")
    db.migrate()
    start = C.T0 - 30 * HOUR
    s = Store(db, seed=7)
    insert_static(s, start)
    await s.flush()
    s = await Store.open(db, seed=11)
    ad = simulation.adapters_for(s)

    # --- Base fleet: everything deployed through the normal desired-state pipeline.
    for cluster, service, fam, ver, eng, ever, replicas in C.BASE_DEPLOYMENTS:
        tgt = s.must("deployment_targets", f"tgt_{cluster}")
        hw = tgt["hardware_type_id"]
        accel = "rocm" if hw == "hw_mi300x" else "cuda"
        dep = s.insert("deployments", {"id": f"dep_{service}_{cluster}", "target_id": tgt["id"], "service_name": service,
                                       "model_family_id": fam, "managed": 1, "current_revision_id": None,
                                       "latest_observation_id": None, "created_at": start, "adopted_at": None})
        rev = create_revision(s, dep, model_version_id=mv_id(fam, ver), engine_version_id=ev_id(eng, ever),
                              image_id=img_id(eng, ever, accel), replicas=replicas, source="seed", actor=SYSTEM,
                              reason="Initial import of fleet into FleetHub")
        await request_apply(s, ad.deployer, dep, rev, actor=SYSTEM)
    await simulation.advance(s, ad, 30 * MINUTE)
    await s.flush()

    # --- Historical rollout: Sentinel Guard 1.0 -> 1.1 (completed).
    await run_rollout(s, ad, title="Sentinel Guard 1.1 (FP8) fleet-wide", kind="model", mv=mv_id("fam_guard", "1.1"),
                      ev=None, creator="u_marcus", executor="u_jordan", deployment_ids=deps(s, "sentinel-guard"),
                      reason="1.1 halves latency with FP8 weights; evals at parity.")
    await simulation.advance(s, ad, 5 * HOUR)
    await s.flush()

    # --- Time passes; CVE feed publishes; scanner reports findings.
    while s.must("sim_state", "sim")["now"] < C.T0 - 7 * HOUR:
        await simulation.advance(s, ad, min(12 * HOUR, (C.T0 - 7 * HOUR) - s.must("sim_state", "sim")["now"]))
    await s.flush()

    # --- Security triage.
    riley = actor(s, "u_riley")
    for f in s.rows("vulnerability_findings"):
        v = s.must("vulnerabilities", f["vulnerability_id"])
        if v["external_id"] == "SIM-2026-0119":
            vulns.triage(s, riley, f, "risk_accepted", "Not reachable: TLS terminates at the mesh sidecar. "
                         "Accepting until forge-coder eu-west moves to 0.18.1.", C.T0 + 2 * C.DAY)
        elif v["external_id"] == "SIM-2026-0133":
            vulns.triage(s, riley, f, "false_positive", "Vendored hub client is never invoked; models are "
                         "pre-staged from the registry.", None)
        elif v["external_id"] == "SIM-2026-0155":
            vulns.triage(s, riley, f, "in_progress", "Base image rebuild on cuda-12.6 tracked by platform team.", None)
        elif v["external_id"] == "SIM-2026-0142":
            vulns.triage(s, riley, f, "in_progress", "P0: remediation plan is to move to vLLM 0.10.0.", None)
    await s.flush()

    # --- Out-of-band activity.
    await simulation.advance(s, ad, 3 * HOUR)                                       # T0-4h
    alex = actor(s, "u_alex")
    simulation.add_manual_workload(s, alex, "tgt_stg-use-h100-1", "atlas-chat-eval", img_id("eng_vllm", "0.9.1", "cuda"),
                                   mv_id("fam_atlas", "2.2"), 1)
    simulation.add_manual_workload(s, alex, "tgt_prd-use-l4-1", "sentinel-guard-shadow",
                                   img_id("eng_vllm", "0.9.1", "cuda"), mv_id("fam_guard", "1.1"), 2)
    await simulation.advance(s, ad, 1 * HOUR)                                       # T0-3h
    simulation.set_source_offline(s, alex, "src_inv_euw", True)
    await simulation.advance(s, ad, 1 * HOUR)                                       # T0-2h
    simulation.inject_drift(s, alex, "dep_atlas-chat_prd-use-h100-2", "image_hotfix")
    await simulation.advance(s, ad, 45 * MINUTE)                                    # T0-75m
    await s.flush()

    # --- In-flight rollout: Forge Coder 3.0 -> 3.1 (mid canary at T0).
    coder = [d for d in deps(s, "forge-coder") if "mi300" not in d]
    euw = "dep_forge-coder_prd-euw-h100-1"
    await run_rollout(s, ad, title="Forge Coder 3.1 rollout", kind="model", mv=mv_id("fam_coder", "3.1"), ev=None,
                      creator="u_ana", executor="u_jordan", deployment_ids=coder,
                      reason="3.1 improves repair pass@1 by 6 points; same serving footprint.", canary_bake=60,
                      justifications={euw: "eu-west inventory exporter is down; proceeding, the wave will verify once it "
                                           "recovers. Known 0.17 latency issue accepted for one week."})
    await simulation.advance(s, ad, 35 * MINUTE)                                    # T0-40m
    simulation.inject_drift(s, alex, "dep_iris-vl_prd-usw-mi300-1", "unhealthy")
    await simulation.advance(s, ad, 10 * MINUTE)                                    # T0-30m

    # --- Awaiting approval: Lumen Embed onto TEI 1.7.
    await run_rollout(s, ad, title="Lumen Embed: TEI 1.6 -> 1.7 (SIM-2026-0101)", kind="engine", mv=None,
                      ev=ev_id("eng_tei", "1.7"), creator="u_sam", executor="u_sam",
                      deployment_ids=[d for d in deps(s, "lumen-embed") if "euw" not in d],
                      reason="Remediates SIM-2026-0101 (memory exhaustion).", approve=False, start=False,
                      linked_vuln=s.first("vulnerabilities", external_id="SIM-2026-0101")["id"])
    await simulation.advance(s, ad, C.T0 - s.must("sim_state", "sim")["now"])     # T0
    # A pre-armed fault for the demo: next deployment on prd-usw-h100-1 "succeeds" without changing anything.
    simulation.arm_fault(s, alex, "tgt_prd-usw-h100-1", "phantom_success")
    s.update("sim_state", "sim", playing=0, last_real_ms=None)
    await s.flush()
    return db


def export(db: SqliteDriver) -> dict[str, list[dict[str, Any]]]:
    data = {}
    for t in TABLE_ORDER:
        rows = db.conn.execute(f"SELECT * FROM {t}").fetchall()
        data[t] = [dict(r) for r in rows]
    return data


async def main() -> None:
    db = await build()
    data = export(db)
    here = Path(__file__).resolve().parent
    (here / "seed_data.py").write_text(
        '"""GENERATED by fleethub.seed.generate - do not edit."""\nimport json\n\nSEED = json.loads(' +
        repr(json.dumps(data, separators=(",", ":"))) + ")\n")
    sql_path = here.parents[2] / "seed" / "seed.sql"
    sql_path.parent.mkdir(exist_ok=True)
    sql_path.write_text("\n".join(to_sql(data)) + "\n")
    counts = {t: len(r) for t, r in data.items() if r}
    print(json.dumps(counts, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
