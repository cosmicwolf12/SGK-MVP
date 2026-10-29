from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path

import cv2
from ultralytics import YOLO


DEFAULT_MODEL = Path(r"C:\Users\sasak\Desktop\best.pt")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Обработка фотографий и видео YOLO-моделью с сохранением результатов."
    )
    parser.add_argument(
        "source",
        type=Path,
        help="Путь к фото, видео или папке с медиафайлами.",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"Путь к модели .pt (по умолчанию: {DEFAULT_MODEL}).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("runs/predict"),
        help="Папка для обработанных файлов (по умолчанию: runs/predict).",
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.25,
        help="Минимальная уверенность детекции от 0 до 1 (по умолчанию: 0.25).",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="Размер входного изображения модели (по умолчанию: 640).",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Устройство для инференса, например cpu или 0 для первой GPU.",
    )
    args = parser.parse_args()

    if not args.model.is_file():
        parser.error(f"Файл модели не найден: {args.model}")
    if not args.source.exists():
        parser.error(f"Источник не найден: {args.source}")
    if not 0 <= args.conf <= 1:
        parser.error("--conf должен быть в диапазоне от 0 до 1.")
    if args.imgsz <= 0:
        parser.error("--imgsz должен быть положительным числом.")

    args.output = args.output.resolve()
    return args


def main() -> None:
    args = parse_args()
    model = YOLO(str(args.model))

    predict_options = {
        "source": str(args.source),
        "conf": args.conf,
        "imgsz": args.imgsz,
        "save": True,
        "stream": True,
        "project": str(args.output.parent),
        "name": args.output.name,
        "exist_ok": True,
    }
    if args.device is not None:
        predict_options["device"] = args.device

    processed_count = 0
    detection_count = 0
    detection_frames_count = 0
    source_frame_counts: dict[str, int] = defaultdict(int)
    for result in model.predict(**predict_options):
        processed_count += 1
        boxes_count = len(result.boxes)
        detection_count += boxes_count
        if boxes_count:
            source_path = Path(result.path)
            source_key = str(source_path.resolve())
            source_frame_counts[source_key] += 1
            frame_path = (
                args.output
                / "detection_frames"
                / source_path.stem
                / f"frame_{source_frame_counts[source_key]:06d}.jpg"
            )
            frame_path.parent.mkdir(parents=True, exist_ok=True)
            if not cv2.imwrite(str(frame_path), result.plot(labels=False, conf=False)):
                raise OSError(f"Не удалось сохранить кадр с детекцией: {frame_path}")
            detection_frames_count += 1

    print(f"Обработано изображений/кадров: {processed_count}")
    print(f"Найдено объектов: {detection_count}")
    print(f"Кадров с детекциями сохранено: {detection_frames_count}")
    print(f"Кадры с детекциями сохранены в: {args.output / 'detection_frames'}")
    print(f"Результаты сохранены в: {args.output}")


if __name__ == "__main__":
    main()
