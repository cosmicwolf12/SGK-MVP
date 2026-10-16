from __future__ import annotations

import json
import sys
import traceback
from collections import defaultdict
from contextlib import redirect_stdout
from pathlib import Path

import cv2
from ultralytics import YOLO


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        config = json.loads(sys.stdin.readline())
        source = config["source"]
        source_root = Path(config["source_root"]).resolve()
        output_dir = Path(config["output_dir"]).resolve()
        model_path = Path(config["model_path"]).resolve()
        if not model_path.is_file():
            raise FileNotFoundError(f"Файл модели не найден: {model_path}")

        with redirect_stdout(sys.stderr):
            model = YOLO(str(model_path))
        is_stream = config["kind"] == "stream"
        is_video = config["kind"] in {"video", "stream", "drive"}
        fps = duration = 0.0
        if is_video and not is_stream and isinstance(source, str):
            capture = cv2.VideoCapture(source)
            if not capture.isOpened():
                raise ValueError(f"Не удалось открыть видео: {Path(source).name}")
            fps = capture.get(cv2.CAP_PROP_FPS)
            frame_total = capture.get(cv2.CAP_PROP_FRAME_COUNT)
            if fps > 0 and frame_total > 0:
                duration = frame_total / fps
            capture.release()

        options = {
            "source": source,
            "conf": config["conf"],
            "imgsz": config["imgsz"],
            "stream": True,
            "save": True,
            "project": str(output_dir.parent),
            "name": output_dir.name,
            "exist_ok": True,
            "verbose": False,
        }
        frame_count = detection_count = detection_frame_count = 0
        detection_frame_indexes: dict[str, int] = defaultdict(int)
        results = iter(model.predict(**options))
        while True:
            try:
                with redirect_stdout(sys.stderr):
                    result = next(results)
            except StopIteration:
                break
            frame_count += 1
            boxes = result.boxes
            detections = []
            if boxes is not None and len(boxes):
                detection_count += len(boxes)
                detection_frame_count += 1
                result_path = Path(result.path).resolve()
                try:
                    source_file = result_path.relative_to(source_root).as_posix()
                except ValueError:
                    source_file = result_path.name
                detection_frame_indexes[source_file] += 1
                source_rel = Path(source_file)
                image_rel = (
                    Path("detection_frames")
                    / source_rel.parent
                    / source_rel.stem
                    / f"frame_{detection_frame_indexes[source_file]:06d}.jpg"
                )
                image_path = output_dir / image_rel
                image_path.parent.mkdir(parents=True, exist_ok=True)
                if not cv2.imwrite(str(image_path), result.plot()):
                    raise OSError(f"Не удалось сохранить кадр с детекцией: {image_path}")
                names = result.names
                for coords, score, class_id in zip(
                    boxes.xyxy.cpu().tolist(),
                    boxes.conf.cpu().tolist(),
                    boxes.cls.int().cpu().tolist(),
                ):
                    class_name = (
                        names.get(class_id, str(class_id))
                        if isinstance(names, dict)
                        else names[class_id]
                    )
                    detections.append({
                        "class_name": str(class_name),
                        "confidence": float(score),
                        "x1": float(coords[0]),
                        "y1": float(coords[1]),
                        "x2": float(coords[2]),
                        "y2": float(coords[3]),
                    })
                emit({
                    "type": "frame",
                    "frame_index": frame_count,
                    "source_file": source_file,
                    "time_seconds": (frame_count - 1) / fps if fps > 0 else 0.0,
                    "image_rel": image_rel.as_posix(),
                    "detections": detections,
                })
            else:
                emit({"type": "progress", "frame_count": frame_count})

        emit({
            "type": "done",
            "frame_count": frame_count,
            "detection_count": detection_count,
            "detection_frame_count": detection_frame_count,
            "duration_seconds": duration,
        })
        return 0
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        emit({"type": "error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
