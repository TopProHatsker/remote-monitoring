"""Разрешённые показатели и их привязка к обнаруженным устройствам."""

import hashlib
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Metric:
    id: str
    title: str
    group: str
    unit: str
    query: str
    device: str = "Вся машина"
    maximum: float | None = None

    def public(self) -> dict:
        data = asdict(self)
        del data["query"]
        return data


def selector(name: str, **labels: str) -> str:
    return (
        name
        + "{"
        + ",".join(f"{key}={json.dumps(value)}" for key, value in sorted(labels.items()))
        + "}"
    )


def identity(prefix: str, *labels: str) -> str:
    suffix = hashlib.sha256(json.dumps(labels).encode()).hexdigest()[:16]
    return f"{prefix}.{suffix}"


def build_catalog(discovered: dict[str, list[dict]]) -> list[Metric]:
    idle = 'node_cpu_seconds_total{job="host",mode="idle"}'
    metrics = [
        Metric(
            "cpu.usage",
            "Загрузка CPU",
            "Процессор",
            "%",
            f"clamp(100 * (1 - avg(rate({idle}[10s]))), 0, 100)",
            maximum=100,
        ),
        Metric(
            "memory.usage",
            "Загрузка памяти",
            "Память",
            "%",
            '(1 - node_memory_MemAvailable_bytes{job="host"} / '
            'node_memory_MemTotal_bytes{job="host"}) * 100',
            maximum=100,
        ),
        Metric(
            "memory.used",
            "Использовано RAM",
            "Память",
            "bytes",
            'node_memory_MemTotal_bytes{job="host"} - node_memory_MemAvailable_bytes{job="host"}',
        ),
        Metric(
            "memory.available",
            "Доступно RAM",
            "Память",
            "bytes",
            'node_memory_MemAvailable_bytes{job="host"}',
        ),
        Metric(
            "host.uptime",
            "Время работы",
            "Система",
            "seconds",
            'time() - node_boot_time_seconds{job="host"}',
        ),
    ]
    for item in discovered.get("cpu", []):
        cpu = item["metric"]["cpu"]
        q = selector("node_cpu_seconds_total", job="host", mode="idle", cpu=cpu)
        metrics.append(
            Metric(
                f"cpu.core.{cpu}",
                f"Загрузка CPU {cpu}",
                "Процессор",
                "%",
                f"clamp(100 * (1 - rate({q}[10s])), 0, 100)",
                f"CPU {cpu}",
                100,
            )
        )
    if any(float(row["value"][1]) > 0 for row in discovered.get("swap", [])):
        metrics.append(
            Metric(
                "swap.usage",
                "Загрузка swap",
                "Память",
                "%",
                '(1 - node_memory_SwapFree_bytes{job="host"} / '
                'node_memory_SwapTotal_bytes{job="host"}) * 100',
                maximum=100,
            )
        )
    for row in discovered.get("filesystem", []):
        labels = row["metric"]
        mount, device = labels["mountpoint"], labels["device"]
        if float(row["value"][1]) <= 0:
            continue
        match = dict(job="host", mountpoint=mount, device=device, fstype=labels["fstype"])
        size = selector("node_filesystem_size_bytes", **match)
        avail = selector("node_filesystem_avail_bytes", **match)
        free = selector("node_filesystem_free_bytes", **match)
        metrics += [
            Metric(
                identity("fs.usage", mount, device),
                "Занято на диске",
                "Файловые системы",
                "%",
                f"100 * ({size} - {free}) / clamp_min({size} - {free} + {avail}, 1)",
                mount,
                100,
            ),
            Metric(
                identity("fs.available", mount, device),
                "Доступно на диске",
                "Файловые системы",
                "bytes",
                avail,
                mount,
            ),
        ]
    for row in discovered.get("network", []):
        device = row["metric"]["device"]
        for direction, title in [("receive", "Приём"), ("transmit", "Передача")]:
            q = selector(f"node_network_{direction}_bytes_total", job="host", device=device)
            metrics.append(
                Metric(
                    identity(f"network.{direction}", device),
                    title,
                    "Сеть",
                    "bytes/s",
                    f"rate({q}[10s])",
                    device,
                )
            )
    for row in discovered.get("disk", []):
        device = row["metric"]["device"]
        for direction, title in [("read", "Чтение"), ("written", "Запись")]:
            q = selector(f"node_disk_{direction}_bytes_total", job="host", device=device)
            metrics.append(
                Metric(
                    identity(f"disk.{direction}", device),
                    title,
                    "Дисковый ввод-вывод",
                    "bytes/s",
                    f"rate({q}[10s])",
                    device,
                )
            )
    for row in discovered.get("temperature", []):
        labels = row["metric"]
        chip, sensor = labels.get("chip", ""), labels.get("sensor", "")
        q = selector("node_hwmon_temp_celsius", job="host", chip=chip, sensor=sensor)
        metrics.append(
            Metric(
                identity("temperature", chip, sensor),
                "Температура",
                "Датчики",
                "celsius",
                q,
                f"{chip} / {sensor}",
            )
        )
    return metrics
