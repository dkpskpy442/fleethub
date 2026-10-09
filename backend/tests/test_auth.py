from __future__ import annotations

from fastapi.testclient import TestClient

from fleethub.app import app


def test_shared_password_gate(api, monkeypatch):
    monkeypatch.setenv("DEMO_PASSWORD", "s3cret")
    c = TestClient(app)
    assert c.get("/api/auth/status").json() == {"required": True, "authenticated": False}
    assert c.get("/api/overview").status_code == 401
    assert c.post("/api/auth/login", json={"password": "nope"}).status_code == 400
    assert c.post("/api/auth/login", json={"password": "s3cret"}).status_code == 200
    assert c.get("/api/overview").status_code == 200  # cookie session
    assert c.get("/api/health").status_code == 200


def test_any_persona_can_reset_demo(api):
    for persona in ("u_priya", "u_marcus", "u_jordan", "u_riley", "u_taylor", "u_alex"):
        assert api.post("/sim/reset", persona=persona) == {"ok": True}
