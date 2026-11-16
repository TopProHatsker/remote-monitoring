"""Приёмка живого Compose-стека и восстановление после отказа сборщика."""

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = os.getenv("BASE_URL", "http://127.0.0.1:8080")


def get(path, body=None):
    payload = json.dumps(body).encode() if body else None
    request = urllib.request.Request(
        BASE + path,
        data=payload,
        headers={"Content-Type": "application/json"} if payload else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def wait_status(expected):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if get("/health")[0] == expected:
                return
        except OSError:
            pass
        time.sleep(1)
    raise AssertionError(f"/health did not become {expected}")


def compose(*args):
    subprocess.run(["docker", "compose", "-f", "compose.yaml", *args], cwd=ROOT, check=True)


if __name__ == "__main__":
    wait_status(200)
    assert get("/")[0] == 200
    catalog = json.loads(get("/api/catalog")[1])
    assert any(m["id"] == "cpu.usage" for m in catalog["metrics"])
    assert any(m["id"] == "memory.usage" for m in catalog["metrics"])
    snapshot = json.loads(get("/api/snapshot", {"ids": ["cpu.usage", "memory.usage"]})[1])
    assert 0 <= snapshot["values"]["memory.usage"] <= 100
    assert time.time() - snapshot["sample_time"] < 10
    compose(
        "exec",
        "-T",
        "app",
        "python",
        "-c",
        "import os,pathlib,shutil; assert os.getuid()!=0; "
        "assert shutil.which('node') is None; "
        "assert not pathlib.Path('/app/.git').exists(); "
        "assert not pathlib.Path('/app/frontend').exists()",
    )
    try:
        compose("stop", "node-exporter")
        wait_status(503)
        assert get("/")[0] == 200
        assert get("/api/snapshot", {"ids": ["cpu.usage"]})[0] == 503
    finally:
        compose("start", "node-exporter")
    wait_status(200)
    print("PASS: real metrics, runtime image, dependency failure and recovery")
