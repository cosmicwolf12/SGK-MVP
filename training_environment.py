from __future__ import annotations

import importlib
import shutil
import subprocess
from typing import Any


def _detect_nvidia_smi() -> tuple[bool, str | None]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return False, None
    try:
        result = subprocess.run(
            [executable, "--query-gpu=name", "--format=csv,noheader"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return True, f"Не удалось опросить NVIDIA GPU через nvidia-smi: {error}"
    devices = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return bool(devices), ", ".join(devices) if devices else None


def get_training_environment() -> dict[str, Any]:
    nvidia_detected, nvidia_details = _detect_nvidia_smi()
    info: dict[str, Any] = {
        "torch_available": False,
        "torch_version": None,
        "cuda_available": False,
        "devices": [],
        "nvidia_detected": nvidia_detected,
        "nvidia_details": nvidia_details,
        "error": None,
    }
    try:
        torch = importlib.import_module("torch")
    except (ImportError, OSError, RuntimeError) as error:
        info["error"] = str(error)
        return info

    info["torch_available"] = True
    info["torch_version"] = str(torch.__version__)
    try:
        info["cuda_available"] = bool(torch.cuda.is_available())
        if info["cuda_available"]:
            info["devices"] = [
                {"index": index, "name": str(torch.cuda.get_device_name(index))}
                for index in range(torch.cuda.device_count())
            ]
            info["cuda_available"] = bool(info["devices"])
    except (AttributeError, OSError, RuntimeError) as error:
        info["error"] = str(error)
        info["cuda_available"] = False
        info["devices"] = []
    return info


def resolve_training_device(requested: str | None) -> tuple[str, str | None]:
    if requested == "cpu":
        return "cpu", None

    environment = get_training_environment()
    if not environment["torch_available"]:
        raise RuntimeError(
            "PyTorch не установлен или не загружается. Установите зависимости проекта "
            "командой `py -3 -m pip install -r requirements.txt`."
        )

    if requested in (None, "auto"):
        if environment["cuda_available"]:
            return "0", None
        if environment["nvidia_detected"]:
            detail = environment["error"] or (
                f"Найден NVIDIA GPU ({environment['nvidia_details']}), "
                f"но установлен PyTorch {environment['torch_version']} без доступной CUDA."
            )
            return "cpu", f"{detail} Обучение автоматически продолжится на CPU. "
            "Для GPU установите CUDA-сборку PyTorch с https://pytorch.org/get-started/locally/."
        if environment["error"]:
            return "cpu", f"CUDA недоступна ({environment['error']}); используется CPU."
        return "cpu", None

    if requested.startswith("cuda:"):
        requested = requested.removeprefix("cuda:")
    if requested.isdigit():
        device_index = int(requested)
        devices = environment["devices"]
        if environment["cuda_available"] and device_index < len(devices):
            return str(device_index), None
        detail = environment["error"] or "PyTorch не видит CUDA-устройства."
        return "cpu", f"GPU {device_index} недоступен ({detail}); обучение автоматически продолжится на CPU."

    raise ValueError(f"Неподдерживаемое устройство обучения: {requested}")
