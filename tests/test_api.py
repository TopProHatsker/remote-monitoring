import time
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import Monitor, app
from app.metrics import build_catalog, selector


@pytest.fixture
def client():
    state = {"up": True, "age": 0, "base": True, "prometheus": True, "expression": ""}

    def handler(request):
        if not state["prometheus"]:
            return httpx.Response(503)
        path = request.url.path
        if path.endswith("targets"):
            timestamp = datetime.fromtimestamp(time.time() - state["age"], timezone.utc).isoformat()
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "activeTargets": [
                            {
                                "labels": {"job": "host"},
                                "health": "up" if state["up"] else "down",
                                "lastScrape": timestamp,
                            }
                        ]
                    },
                },
            )
        expression = request.url.params.get("query", "")
        state["expression"] = expression
        if expression.startswith("count("):
            result = [{"metric": {}, "value": [time.time(), "1"]}] if state["base"] else []
        elif "query_range" in path:
            start = int(request.url.params["start"])
            step = int(request.url.params["step"])
            result = [{"metric": {}, "values": [[start, "NaN"], [start + step, "42"]]}]
            return httpx.Response(200, json={"status": "success", "data": {"result": result}})
        else:
            result = [{"metric": {}, "value": [time.time(), "42"]}] if "clamp(" in expression else []
        return httpx.Response(200, json={"status": "success", "data": {"result": result}})

    with TestClient(app) as web:
        upstream = httpx.AsyncClient(
            base_url="http://test-prometheus", transport=httpx.MockTransport(handler)
        )
        web.app.state.monitor = Monitor(upstream)
        yield web, state
        web.portal.call(upstream.aclose)


def test_health_requires_live_fresh_complete_source(client):
    web, state = client
    assert web.get("/health").status_code == 200
    for field, value in [("up", False), ("age", 30), ("base", False), ("prometheus", False)]:
        old = state[field]
        state[field] = value
        response = web.get("/health")
        assert response.status_code == 503
        assert response.json()["status"] == "metrics_unavailable"
        state[field] = old
    assert web.get("/health").status_code == 200


def test_catalog_and_snapshot_never_accept_client_promql(client):
    web, state = client
    catalog = web.get("/api/catalog").json()
    assert "cpu.usage" in [m["id"] for m in catalog["metrics"]]
    assert all("query" not in m for m in catalog["metrics"])
    response = web.post("/api/snapshot", json={"ids": ["cpu.usage", "arbitrary{query}"]})
    assert response.status_code == 200
    assert response.json()["values"] == {"cpu.usage": 42}
    assert "arbitrary" not in state["expression"]
    assert response.headers["cache-control"] == "no-store"


def test_history_limits_work_and_nan_is_a_gap(client):
    web, _ = client
    result = web.post("/api/history", json={"ids": ["cpu.usage"], "seconds": 300})
    assert result.status_code == 200
    assert result.json()["series"]["cpu.usage"][0][1] is None
    assert result.json()["series"]["cpu.usage"][1][1] == 42
    assert result.json()["series"]["cpu.usage"][2][1] is None
    for body in [{"ids": []}, {"ids": ["cpu.usage"] * 49}, {"ids": ["cpu.usage"], "seconds": 999999}]:
        assert web.post("/api/history", json=body).status_code == 422


def test_safe_device_labels_and_stable_identities():
    device = 'disk"\\name'
    expression = selector("metric", device=device)
    assert '\\"' in expression and "\\\\" in expression
    discovered = {
        "filesystem": [
            {"metric": {"mountpoint": "/data", "device": device, "fstype": "ext4"}, "value": [1, "100"]}
        ],
        "swap": [],
    }
    first = build_catalog(discovered)
    second = build_catalog(discovered)
    assert [m.id for m in first] == [m.id for m in second]
    assert not any(m.id.startswith("temperature") for m in first)
    assert not any(m.id == "swap.usage" for m in first)
