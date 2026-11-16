"""HTTP API дашборда и проверка готовности источника метрик."""

import asyncio
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.metrics import Metric, build_catalog


class Unavailable(Exception):
    pass


def number(value: str) -> float | None:
    result = float(value)
    return result if math.isfinite(result) else None


class MetricsRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=48)


class HistoryRequest(MetricsRequest):
    seconds: int = Field(default=900, ge=60, le=86400)


class Monitor:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.limit = asyncio.Semaphore(8)
        self.catalog: dict[str, Metric] = {}
        self.catalog_time = 0.0
        self.catalog_lock = asyncio.Lock()
        self.hostname = "Linux"

    async def request(self, path: str, params: dict | None = None) -> dict:
        try:
            async with self.limit:
                response = await self.client.get(path, params=params)
            response.raise_for_status()
            data = response.json()
            if data.get("status") != "success":
                raise ValueError("Prometheus rejected query")
            return data["data"]
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise Unavailable("Prometheus недоступен") from exc

    async def query(self, expression: str) -> list[dict]:
        data = await self.request("/api/v1/query", {"query": expression, "timeout": "2s"})
        return data["result"]

    async def readiness(self) -> float:
        data = await self.request("/api/v1/targets")
        targets = [t for t in data.get("activeTargets", []) if t.get("labels", {}).get("job") == "host"]
        if not targets or any(t.get("health") != "up" for t in targets):
            raise Unavailable("Сборщик метрик недоступен")
        try:
            stamp = min(
                datetime.fromisoformat(t["lastScrape"].replace("Z", "+00:00")).timestamp()
                for t in targets
            )
        except (KeyError, ValueError) as exc:
            raise Unavailable("Ещё нет измерений") from exc
        if not -5 <= time.time() - stamp <= 10:
            raise Unavailable("Измерения устарели")
        # Успешный scrape не гарантирует наличие нужных приложению показателей
        present = await self.query(
            'count(node_memory_MemTotal_bytes{job="host"}) > 0 and '
            'count(node_memory_MemAvailable_bytes{job="host"}) > 0 and '
            'count(node_cpu_seconds_total{job="host",mode="idle"}) > 0'
        )
        if not present:
            raise Unavailable("Базовые метрики ещё не готовы")
        return stamp

    async def get_catalog(self) -> dict[str, Metric]:
        async with self.catalog_lock:
            if self.catalog and time.monotonic() - self.catalog_time < 60:
                return self.catalog
            expressions = {
                "cpu": 'node_cpu_seconds_total{job="host",mode="idle"}',
                "filesystem": (
                    'node_filesystem_size_bytes{job="host",'
                    'fstype!~"tmpfs|devtmpfs|overlay|squashfs|nsfs"}'
                ),
                "network": (
                    'node_network_receive_bytes_total{job="host",device!~"lo|veth.*|docker.*|br-.*"}'
                    ' and on(device) (node_network_up{job="host"} == 1)'
                ),
                "disk": 'node_disk_read_bytes_total{job="host",device!~"loop.*|ram.*|sr.*"}',
                "temperature": 'node_hwmon_temp_celsius{job="host"}',
                "swap": 'node_memory_SwapTotal_bytes{job="host"}',
                "host": 'node_uname_info{job="host"}',
            }
            results = await asyncio.gather(*(self.query(q) for q in expressions.values()))
            discovered = dict(zip(expressions, results, strict=True))
            if discovered["host"]:
                self.hostname = discovered["host"][0]["metric"].get("nodename", "Linux")
            self.catalog = {m.id: m for m in build_catalog(discovered)}
            self.catalog_time = time.monotonic()
            return self.catalog

    async def resolve(self, ids: list[str]) -> list[Metric]:
        catalog = await self.get_catalog()
        # Исчезнувший датчик возвращается как отсутствующий, чужой PromQL не принимается
        return [catalog[key] for key in dict.fromkeys(ids) if key in catalog]


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(
        base_url=os.getenv("PROMETHEUS_URL", "http://prometheus:9090"),
        timeout=httpx.Timeout(2.5, connect=1),
        trust_env=False,
    ) as client:
        app.state.monitor = Monitor(client)
        yield


app = FastAPI(title="PC Monitor", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/", "/health")):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.exception_handler(Unavailable)
async def unavailable_handler(request: Request, exc: Unavailable):
    return JSONResponse(status_code=503, content={"status": "metrics_unavailable", "detail": str(exc)})


@app.get("/health")
async def health(request: Request):
    stamp = await request.app.state.monitor.readiness()
    return {"status": "ready", "sample_time": stamp}


@app.get("/api/catalog")
async def catalog(request: Request):
    monitor: Monitor = request.app.state.monitor
    await monitor.readiness()
    metrics = await monitor.get_catalog()
    return {"hostname": monitor.hostname, "metrics": [m.public() for m in metrics.values()]}


@app.post("/api/snapshot")
async def snapshot(body: MetricsRequest, request: Request):
    monitor: Monitor = request.app.state.monitor
    stamp = await monitor.readiness()
    metrics = await monitor.resolve(body.ids)
    results = await asyncio.gather(*(monitor.query(m.query) for m in metrics))
    values = {
        m.id: number(rows[0]["value"][1]) if rows else None
        for m, rows in zip(metrics, results, strict=True)
    }
    return {"status": "ready", "sample_time": stamp, "hostname": monitor.hostname, "values": values}


@app.post("/api/history")
async def history(body: HistoryRequest, request: Request):
    monitor: Monitor = request.app.state.monitor
    await monitor.readiness()
    metrics = await monitor.resolve(body.ids)
    step = max(2, math.ceil(body.seconds / 300))
    end = math.floor(time.time() / step) * step
    start = end - math.floor(body.seconds / step) * step

    async def series(metric: Metric):
        data = await monitor.request(
            "/api/v1/query_range",
            {
                "query": metric.query,
                "start": start,
                "end": end,
                "step": step,
                "timeout": "2s",
            },
        )
        rows = data["result"]
        points = {int(float(t)): number(v) for t, v in rows[0]["values"]} if rows else {}
        # Отсутствующие отсчёты остаются разрывами, а не соединяются линией
        return metric.id, [[t, points.get(t)] for t in range(start, end + 1, step)]

    return {"series": dict(await asyncio.gather(*(series(m) for m in metrics))), "step": step}


static = Path(os.getenv("STATIC_DIR", Path(__file__).parent / "static"))
if static.is_dir():
    app.mount("/", StaticFiles(directory=static, html=True), name="frontend")
