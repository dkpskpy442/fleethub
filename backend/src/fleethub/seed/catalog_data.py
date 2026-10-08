"""Static synthetic catalog + topology. All names, CVE ids and digests are fictional."""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime

T0 = int(datetime(2026, 10, 8, 9, 0, tzinfo=UTC).timestamp())
DAY = 86400


def digest(name: str) -> str:
    return "sha256:" + hashlib.sha256(name.encode()).hexdigest()


TEAMS = [
    ("team_fm", "Foundation Models", "foundation-models"),
    ("team_aml", "Applied ML", "applied-ml"),
    ("team_infra", "Inference Platform", "inference-platform"),
    ("team_sec", "Product Security", "product-security"),
    ("team_rel", "Release Engineering", "release-engineering"),
]

USERS = [
    # id, name, email, title, role, team
    ("u_priya", "Priya Shah", "priya@example.test", "Product Analyst", "viewer", "team_aml"),
    ("u_marcus", "Marcus Lee", "marcus@example.test", "Model Owner, Atlas", "model_owner", "team_fm"),
    ("u_ana", "Ana Ruiz", "ana@example.test", "Model Owner, Forge & Lumen", "model_owner", "team_aml"),
    ("u_jordan", "Jordan Kim", "jordan@example.test", "Platform Engineer", "platform_engineer", "team_infra"),
    ("u_sam", "Sam Okafor", "sam@example.test", "Platform Engineer", "platform_engineer", "team_infra"),
    ("u_riley", "Riley Chen", "riley@example.test", "Security Engineer", "security_engineer", "team_sec"),
    ("u_taylor", "Taylor Brooks", "taylor@example.test", "Release Manager", "release_approver", "team_rel"),
    ("u_alex", "Alex Morgan", "alex@example.test", "Platform Lead (admin)", "admin", "team_infra"),
]

HARDWARE = [
    ("hw_h100", "H100-80GB", "NVIDIA", 80, "cuda"),
    ("hw_a100", "A100-80GB", "NVIDIA", 80, "cuda"),
    ("hw_l4", "L4-24GB", "NVIDIA", 24, "cuda"),
    ("hw_mi300x", "MI300X-192GB", "AMD", 192, "rocm"),
]
CUDA_HW = ["hw_h100", "hw_a100", "hw_l4"]

# family id, name, slug, modality, owner, description, engine slug used by default
FAMILIES = [
    ("fam_atlas", "Atlas Chat", "atlas-chat", "text-generation", "team_fm", "Flagship 70B assistant model."),
    ("fam_mini", "Atlas Chat Mini", "atlas-chat-mini", "text-generation", "team_fm", "8B distilled assistant for latency-sensitive traffic."),
    ("fam_guard", "Sentinel Guard", "sentinel-guard", "classification", "team_fm", "Safety classifier applied to prompts and completions."),
    ("fam_coder", "Forge Coder", "forge-coder", "code-generation", "team_aml", "Code completion and repair model."),
    ("fam_embed", "Lumen Embed", "lumen-embed", "embeddings", "team_aml", "Text embeddings for retrieval."),
    ("fam_iris", "Iris VL", "iris-vl", "vision-language", "team_aml", "Vision-language model for document understanding."),
]

# family, version, lifecycle, params_b, ctx, quant, released days ago
MODEL_VERSIONS = [
    ("fam_atlas", "1.8", "retired", 70, 32768, "bf16", 240),
    ("fam_atlas", "2.0", "deprecated", 70, 65536, "bf16", 150),
    ("fam_atlas", "2.1", "production", 70, 131072, "bf16", 60),
    ("fam_atlas", "2.2", "experimental", 72, 131072, "bf16", 6),
    ("fam_mini", "1.0", "deprecated", 8, 32768, "bf16", 200),
    ("fam_mini", "1.1", "production", 8, 65536, "bf16", 90),
    ("fam_mini", "1.2", "production", 8, 131072, "fp8", 25),
    ("fam_guard", "1.0", "production", 3, 8192, "bf16", 120),
    ("fam_guard", "1.1", "production", 3, 8192, "fp8", 30),
    ("fam_coder", "3.0", "production", 34, 32768, "bf16", 110),
    ("fam_coder", "3.1", "production", 34, 65536, "bf16", 20),
    ("fam_coder", "3.2", "experimental", 34, 65536, "awq-int4", 4),
    ("fam_embed", "2.0", "production", 0.6, 8192, "fp16", 180),
    ("fam_embed", "2.1", "production", 0.6, 8192, "fp16", 45),
    ("fam_iris", "0.9", "experimental", 12, 32768, "bf16", 70),
    ("fam_iris", "1.0", "production", 12, 32768, "bf16", 35),
]

ENGINES = [
    ("eng_vllm", "vLLM", "vllm", "team_infra", "High-throughput LLM serving engine.", "https://github.com/vllm-project/vllm"),
    ("eng_trt", "TensorRT-LLM", "trtllm", "team_infra", "NVIDIA-optimized LLM inference runtime.", "https://github.com/NVIDIA/TensorRT-LLM"),
    ("eng_sglang", "SGLang", "sglang", "team_infra", "Structured generation serving runtime.", "https://github.com/sgl-project/sglang"),
    ("eng_tei", "Text Embeddings Inference", "tei", "team_infra", "Embedding model server.", "https://github.com/huggingface/text-embeddings-inference"),
]

# engine, version, lifecycle, released days ago, rocm image?
ENGINE_VERSIONS = [
    ("eng_vllm", "0.8.5", "deprecated", 160, True),
    ("eng_vllm", "0.9.1", "supported", 95, True),
    ("eng_vllm", "0.9.2", "supported", 60, True),
    ("eng_vllm", "0.10.0", "supported", 21, True),
    ("eng_vllm", "0.10.1", "preview", 5, False),
    ("eng_trt", "0.17.0", "supported", 130, False),
    ("eng_trt", "0.18.1", "supported", 50, False),
    ("eng_trt", "0.19.0", "preview", 8, False),
    ("eng_sglang", "0.4.6", "supported", 100, True),
    ("eng_sglang", "0.4.8", "supported", 40, True),
    ("eng_tei", "1.6", "supported", 120, False),
    ("eng_tei", "1.7", "supported", 30, False),
]

ENVIRONMENTS = [("env_dev", "Development", "dev", 1), ("env_stg", "Staging", "staging", 2), ("env_prod", "Production", "prod", 3)]
REGIONS = [("reg_use", "us-east", "aws", 1), ("reg_usw", "us-west", "gcp", 2), ("reg_euw", "eu-west", "aws", 3), ("reg_apne", "ap-northeast", "on-prem", 4)]

# id, kind, name, description, interval, fresh, stale
SOURCES = [
    ("src_inv_use", "inventory", "k8s inventory exporter (us-east)", "Cluster agent reporting running workloads.", 300, 900, 21600),
    ("src_inv_usw", "inventory", "k8s inventory exporter (us-west)", "Cluster agent reporting running workloads.", 300, 900, 21600),
    ("src_inv_euw", "inventory", "k8s inventory exporter (eu-west)", "Cluster agent reporting running workloads.", 300, 900, 21600),
    ("src_inv_apne", "inventory", "k8s inventory exporter (ap-northeast)", "Cluster agent reporting running workloads.", 300, 900, 21600),
    ("src_inv_legacy", "inventory", "Bare-metal node exporter (legacy)", "Legacy exporter for the on-prem MI300X pool.", 300, 900, 21600),
    ("src_scanner", "scanner", "Container image scanner", "Scans registered engine images for known CVEs.", 1800, 3600, 86400),
    ("src_deployer", "deployer", "Deployment orchestrator (simulated)", "Applies desired state to clusters.", 60, 300, 3600),
]

# id/name, env, region, hardware, source
TARGETS = [
    ("dev-use-h100-1", "env_dev", "reg_use", "hw_h100", "src_inv_use"),
    ("stg-use-h100-1", "env_stg", "reg_use", "hw_h100", "src_inv_use"),
    ("stg-usw-mi300-1", "env_stg", "reg_usw", "hw_mi300x", "src_inv_usw"),
    ("prd-use-h100-1", "env_prod", "reg_use", "hw_h100", "src_inv_use"),
    ("prd-use-h100-2", "env_prod", "reg_use", "hw_h100", "src_inv_use"),
    ("prd-use-l4-1", "env_prod", "reg_use", "hw_l4", "src_inv_use"),
    ("prd-usw-h100-1", "env_prod", "reg_usw", "hw_h100", "src_inv_usw"),
    ("prd-usw-mi300-1", "env_prod", "reg_usw", "hw_mi300x", "src_inv_usw"),
    ("prd-euw-h100-1", "env_prod", "reg_euw", "hw_h100", "src_inv_euw"),
    ("prd-euw-a100-1", "env_prod", "reg_euw", "hw_a100", "src_inv_euw"),
    ("prd-apne-a100-1", "env_prod", "reg_apne", "hw_a100", "src_inv_apne"),
    ("prd-apne-mi300-bm", "env_prod", "reg_apne", "hw_mi300x", "src_inv_legacy"),
]

# cluster, service, family, model version, engine, engine version, replicas
BASE_DEPLOYMENTS = [
    # Atlas Chat (vLLM)
    ("dev-use-h100-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 1),
    ("stg-use-h100-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 2),
    ("stg-usw-mi300-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 2),
    ("prd-use-h100-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 8),
    ("prd-use-h100-2", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 8),
    ("prd-usw-h100-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 6),
    ("prd-usw-mi300-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 4),
    ("prd-euw-h100-1", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 6),
    ("prd-apne-a100-1", "atlas-chat", "fam_atlas", "2.0", "eng_vllm", "0.9.1", 4),
    ("prd-apne-mi300-bm", "atlas-chat", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 4),
    # Atlas Chat batch tier
    ("prd-use-h100-1", "atlas-chat-batch", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 4),
    ("prd-use-h100-2", "atlas-chat-batch", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 4),
    ("prd-usw-h100-1", "atlas-chat-batch", "fam_atlas", "2.1", "eng_vllm", "0.9.1", 3),
    ("prd-euw-h100-1", "atlas-chat-batch", "fam_atlas", "2.1", "eng_vllm", "0.9.2", 3),
    # Atlas Chat Mini (vLLM)
    ("dev-use-h100-1", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.9.1", 1),
    ("stg-use-h100-1", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.9.1", 2),
    ("prd-use-l4-1", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.9.1", 12),
    ("prd-use-h100-2", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.9.1", 4),
    ("prd-usw-h100-1", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.9.1", 4),
    ("prd-euw-a100-1", "atlas-chat-mini", "fam_mini", "1.1", "eng_vllm", "0.9.1", 6),
    ("prd-apne-a100-1", "atlas-chat-mini", "fam_mini", "1.2", "eng_vllm", "0.8.5", 4),
    # Sentinel Guard (vLLM) - starts on 1.0, upgraded to 1.1 by a historical rollout
    ("dev-use-h100-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 1),
    ("stg-use-h100-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 2),
    ("prd-use-l4-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 6),
    ("prd-usw-h100-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 3),
    ("prd-euw-a100-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 3),
    ("prd-apne-a100-1", "sentinel-guard", "fam_guard", "1.0", "eng_vllm", "0.9.1", 2),
    # Forge Coder (TRT-LLM on NVIDIA, vLLM on AMD)
    ("dev-use-h100-1", "forge-coder", "fam_coder", "3.0", "eng_trt", "0.18.1", 1),
    ("stg-use-h100-1", "forge-coder", "fam_coder", "3.0", "eng_trt", "0.18.1", 2),
    ("prd-use-h100-1", "forge-coder", "fam_coder", "3.0", "eng_trt", "0.18.1", 6),
    ("prd-usw-h100-1", "forge-coder", "fam_coder", "3.0", "eng_trt", "0.18.1", 4),
    ("prd-euw-h100-1", "forge-coder", "fam_coder", "3.0", "eng_trt", "0.17.0", 4),
    ("prd-usw-mi300-1", "forge-coder", "fam_coder", "3.0", "eng_vllm", "0.9.1", 2),
    # Lumen Embed (TEI)
    ("dev-use-h100-1", "lumen-embed", "fam_embed", "2.1", "eng_tei", "1.6", 1),
    ("stg-use-h100-1", "lumen-embed", "fam_embed", "2.1", "eng_tei", "1.6", 2),
    ("prd-use-l4-1", "lumen-embed", "fam_embed", "2.1", "eng_tei", "1.6", 8),
    ("prd-usw-h100-1", "lumen-embed", "fam_embed", "2.1", "eng_tei", "1.6", 4),
    ("prd-euw-a100-1", "lumen-embed", "fam_embed", "2.0", "eng_tei", "1.6", 4),
    ("prd-apne-a100-1", "lumen-embed", "fam_embed", "2.1", "eng_tei", "1.6", 3),
    # Iris VL (SGLang)
    ("dev-use-h100-1", "iris-vl", "fam_iris", "1.0", "eng_sglang", "0.4.8", 1),
    ("stg-use-h100-1", "iris-vl", "fam_iris", "1.0", "eng_sglang", "0.4.8", 1),
    ("stg-usw-mi300-1", "iris-vl", "fam_iris", "1.0", "eng_sglang", "0.4.8", 1),
    ("prd-use-h100-1", "iris-vl", "fam_iris", "1.0", "eng_sglang", "0.4.8", 4),
    ("prd-usw-mi300-1", "iris-vl", "fam_iris", "1.0", "eng_sglang", "0.4.6", 3),
]

# Compatibility overrides: (family, model version, engine, engine version, hardware) -> (status, notes)
# Everything else follows the default rule in generate.py; absent = untested.
COMPAT_OVERRIDES = {
    ("fam_atlas", "2.1", "eng_vllm", "0.10.0", "hw_mi300x"): None,  # deliberately untested
    ("fam_mini", "1.1", "eng_vllm", "0.10.0", "hw_a100"): ("known_issues", "Tokenizer regression with prompts >32k tokens; mitigate with --max-model-len 32768."),
    ("fam_guard", "1.1", "eng_vllm", "0.10.0", "hw_l4"): ("incompatible", "FP8 KV-cache kernel missing for L4 in 0.10.0; fixed in 0.10.1."),
    ("fam_guard", "1.1", "eng_vllm", "0.10.1", "hw_l4"): ("certified", "Verified with FP8 KV-cache on L4."),
    ("fam_atlas", "2.0", "eng_vllm", "0.10.0", "hw_a100"): ("compatible", "Functional; not benchmarked for 2.0."),
    ("fam_iris", "1.0", "eng_sglang", "0.4.8", "hw_mi300x"): ("compatible", "Passes eval suite; 8% lower throughput than H100."),
    ("fam_coder", "3.1", "eng_trt", "0.17.0", "hw_h100"): ("known_issues", "Speculative decoding disabled on 0.17.x; ~15% higher latency."),
    ("fam_coder", "3.1", "eng_vllm", "0.9.1", "hw_mi300x"): ("compatible", None),
}

# Synthetic CVE feed: id, title, severity, cvss, package, description, fixed note, affected (engine, version, accel|None), publish offset (s from T0) or None
CVE_FEED = [
    ("SIM-2026-0142", "Unsafe deserialization in multimodal input loader allows remote code execution", "critical", 9.8,
     "vllm (multimodal loader)", "Crafted image payloads can trigger deserialization of attacker-controlled objects in the API server process.",
     "Fixed in vLLM 0.10.0", [("eng_vllm", "0.8.5", None), ("eng_vllm", "0.9.1", None)], -20 * 3600),
    ("SIM-2026-0167", "Prefix-cache timing side channel leaks prompt tokens across tenants", "high", 7.4,
     "vllm (prefix cache)", "Shared prefix cache hits are observable via response latency.",
     "Fixed in vLLM 0.10.0", [("eng_vllm", "0.9.2", None)], -26 * 3600),
    ("SIM-2026-0101", "Unbounded batch size enables memory exhaustion", "medium", 5.9,
     "text-embeddings-inference", "Requests with very large input arrays can exhaust host memory.",
     "Fixed in TEI 1.7", [("eng_tei", "1.6", None)], -27 * 3600),
    ("SIM-2026-0119", "OpenSSL in base image vulnerable to certificate parsing overflow", "high", 7.5,
     "openssl 3.0.13 (base image)", "Base image ships an OpenSSL version with a known parsing overflow.",
     "Rebuilt base in TensorRT-LLM 0.18.1", [("eng_trt", "0.17.0", None)], -27 * 3600),
    ("SIM-2026-0123", "Log injection via request headers", "low", 3.1, "sglang (http server)",
     "Unsanitized headers can forge log lines.", "Fixed in SGLang 0.4.8", [("eng_sglang", "0.4.6", None)], -27 * 3600),
    ("SIM-2026-0155", "glibc iconv buffer overflow in CUDA base images", "medium", 6.5, "glibc 2.35",
     "Affects images built on the cuda-12.4 base.", "Rebuild on cuda-12.6 base",
     [("eng_vllm", "0.9.1", "cuda"), ("eng_sglang", "0.4.6", "cuda")], -27 * 3600),
    ("SIM-2026-0133", "Path traversal in model download helper", "high", 7.1, "text-embeddings-inference (hub client)",
     "Scanner match on vendored hub client; helper is not reachable in our deployment.", "n/a",
     [("eng_tei", "1.7", None)], -27 * 3600),
    ("SIM-2026-0171", "Heap overflow in image preprocessing (Pillow-SIMD)", "critical", 9.1, "pillow-simd 9.5",
     "Malformed TIFF images trigger a heap overflow during preprocessing.", "Fixed upstream; no SGLang release yet",
     [("eng_sglang", "0.4.8", None)], None),  # unpublished: use demo controls to publish
]
