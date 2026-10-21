from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from training_environment import resolve_training_device
from training_utils import read_json, write_json_atomic


class TrainingCancelled(Exception):
    pass


def main(config_path: Path) -> int:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    status_path = Path(config["status_path"])
    cancel_path = Path(config["cancel_path"])
    log_path = Path(config["log_path"])

    try:
        from ultralytics import YOLO

        requested_device = config.get("device")
        device, device_note = resolve_training_device(requested_device)
        device_info = {
            "device_requested": requested_device or "auto",
            "device_used": f"GPU {device}" if device.isdigit() else "CPU",
            "device_note": device_note,
        }
        if device_note:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(device_note + "\n")
        write_json_atomic(status_path, {
            "status": "running",
            "epoch": 0,
            "epochs": config["epochs"],
            "started_at": time.time(),
            **device_info,
        })

        model = YOLO(config["checkpoint"])

        def on_epoch_end(trainer):
            if cancel_path.exists():
                raise TrainingCancelled("Остановка запрошена пользователем.")
            metrics = getattr(trainer, "metrics", {}) or {}
            losses = getattr(trainer, "tloss", None)
            loss_values = []
            if losses is not None:
                try:
                    loss_values = [float(value) for value in losses.tolist()]
                except (AttributeError, TypeError, ValueError):
                    loss_values = []
            write_json_atomic(status_path, {
                "status": "running",
                "epoch": int(trainer.epoch) + 1,
                "epochs": int(trainer.epochs),
                "losses": loss_values,
                "metrics": {
                    key: float(value) for key, value in metrics.items()
                    if isinstance(value, (int, float))
                },
                "updated_at": time.time(),
                **device_info,
            })

        model.add_callback("on_train_epoch_end", on_epoch_end)
        train_args = {
            "data": config["data_yaml"],
            "epochs": config["epochs"],
            "imgsz": config["imgsz"],
            "batch": config["batch"],
            "workers": config["workers"],
            "project": config["project"],
            "name": config["run_name"],
            "exist_ok": True,
            "plots": True,
            "verbose": True,
        }
        train_args["device"] = device

        results = model.train(**train_args)
        if cancel_path.exists():
            raise TrainingCancelled("Остановка запрошена пользователем.")
        trainer = getattr(model, "trainer", None)
        best_path = Path(getattr(trainer, "best", "")) if trainer else None
        if not best_path or not best_path.is_file():
            save_dir = Path(getattr(trainer, "save_dir", config["project"])) if trainer else Path(config["project"])
            best_path = save_dir / "weights" / "best.pt"
        if not best_path.is_file():
            raise RuntimeError("Обучение завершилось, но файл weights/best.pt не найден.")

        write_json_atomic(status_path, {
            "status": "completed",
            "epoch": config["epochs"],
            "epochs": config["epochs"],
            "best_model": str(best_path.resolve()),
            "results_csv": str((best_path.parent.parent / "results.csv").resolve()),
            "finished_at": time.time(),
            "metrics": {
                key: float(value) for key, value in (getattr(trainer, "metrics", {}) or {}).items()
                if isinstance(value, (int, float))
            } if trainer else {},
            **device_info,
        })
        return 0
    except TrainingCancelled as error:
        write_json_atomic(status_path, {
            "status": "cancelled",
            "message": str(error),
            "finished_at": time.time(),
        })
        return 0
    except Exception as error:
        with log_path.open("a", encoding="utf-8") as log:
            log.write("\n\n" + traceback.format_exc())
        write_json_atomic(status_path, {
            "status": "failed",
            "error": f"{type(error).__name__}: {error}",
            "finished_at": time.time(),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1]).resolve()))
