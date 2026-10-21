from __future__ import annotations

import json
import math
import random
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
COCO_JSON = BASE_DIR / "annotations.json"
IMAGE_DIR = BASE_DIR / "images_source"
OUTPUT_DIR = BASE_DIR / "yolo_dataset"
VAL_RATIO = 0.2
RANDOM_SEED = 42


def _safe_relative_path(value: str) -> Path:
    relative = Path(value.replace("\\", "/"))
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError(f"Unsafe image path in COCO JSON: {value}")
    return relative


def _valid_polygon(points: Any, width: float, height: float) -> list[float] | None:
    if not isinstance(points, list) or len(points) < 6 or len(points) % 2:
        return None
    try:
        coordinates = [float(value) for value in points]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in coordinates):
        return None
    normalized: list[float] = []
    for index in range(0, len(coordinates), 2):
        x = min(max(coordinates[index], 0.0), width) / width
        y = min(max(coordinates[index + 1], 0.0), height) / height
        normalized.extend((x, y))
    if len(set(zip(normalized[::2], normalized[1::2]))) < 3:
        return None
    return normalized


def _annotation_rows(annotation: dict[str, Any], width: float, height: float) -> list[str]:
    class_id = int(annotation["category_id"]) - 1
    segmentation = annotation.get("segmentation")
    if isinstance(segmentation, list):
        polygons = [
            polygon for item in segmentation
            if (polygon := _valid_polygon(item, width, height)) is not None
        ]
        if polygons:
            return [
                f"{class_id} " + " ".join(f"{coordinate:.6f}" for coordinate in polygon)
                for polygon in polygons
            ]

    bbox = annotation.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        print(
            f"Warning: annotation {annotation.get('id', '<unknown>')} has neither a valid polygon nor bbox; skipped.",
            file=sys.stderr,
        )
        return []
    try:
        x, y, box_width, box_height = (float(value) for value in bbox)
    except (TypeError, ValueError):
        print(
            f"Warning: annotation {annotation.get('id', '<unknown>')} has an invalid bbox; skipped.",
            file=sys.stderr,
        )
        return []
    if not all(math.isfinite(value) for value in (x, y, box_width, box_height)):
        print(
            f"Warning: annotation {annotation.get('id', '<unknown>')} has a non-finite bbox; skipped.",
            file=sys.stderr,
        )
        return []
    left = min(max(x, 0.0), width)
    top = min(max(y, 0.0), height)
    right = min(max(x + box_width, 0.0), width)
    bottom = min(max(y + box_height, 0.0), height)
    if right <= left or bottom <= top:
        print(
            f"Warning: annotation {annotation.get('id', '<unknown>')} has an empty bbox; skipped.",
            file=sys.stderr,
        )
        return []
    center_x = ((left + right) / 2) / width
    center_y = ((top + bottom) / 2) / height
    normalized_width = (right - left) / width
    normalized_height = (bottom - top) / height
    return [f"{class_id} {center_x:.6f} {center_y:.6f} {normalized_width:.6f} {normalized_height:.6f}"]


def _validate_coco(data: Any) -> tuple[list[dict[str, Any]], dict[Any, dict[str, Any]], dict[Any, list[dict[str, Any]]]]:
    if not isinstance(data, dict):
        raise ValueError("COCO JSON root must be an object.")
    images = data.get("images")
    categories = data.get("categories")
    annotations = data.get("annotations")
    if not isinstance(images, list) or not isinstance(categories, list) or not isinstance(annotations, list):
        raise ValueError("COCO JSON must contain images, categories, and annotations arrays.")
    if not categories:
        raise ValueError("COCO JSON must contain at least one category.")

    category_ids: set[int] = set()
    for category in categories:
        try:
            category_id = int(category["id"])
            name = str(category["name"]).strip()
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("COCO category is missing a valid id or name.") from error
        if category_id in category_ids or not name:
            raise ValueError(f"Duplicate category ID or empty category name: {category_id}")
        category_ids.add(category_id)
        category["id"] = category_id
        category["name"] = name
    if category_ids != set(range(1, len(categories) + 1)):
        raise ValueError("This converter expects category_id values to be contiguous and start at 1.")

    image_by_id: dict[Any, dict[str, Any]] = {}
    for image in images:
        try:
            image_id = image["id"]
            image["width"] = float(image["width"])
            image["height"] = float(image["height"])
            _safe_relative_path(str(image["file_name"]))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"COCO image record is invalid: {image!r}") from error
        if image_id in image_by_id:
            raise ValueError(f"Duplicate COCO image ID: {image_id}")
        if not math.isfinite(image["width"]) or not math.isfinite(image["height"]) or image["width"] <= 0 or image["height"] <= 0:
            raise ValueError(f"Invalid dimensions for COCO image ID {image_id}.")
        image_by_id[image_id] = image

    annotations_by_image: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for annotation in annotations:
        try:
            if int(annotation.get("iscrowd", 0)) == 1:
                continue
            image_id = annotation["image_id"]
            category_id = int(annotation["category_id"])
        except (KeyError, TypeError, ValueError) as error:
            print(f"Warning: invalid COCO annotation skipped: {annotation!r}", file=sys.stderr)
            continue
        if image_id not in image_by_id or category_id not in category_ids:
            print(
                f"Warning: annotation {annotation.get('id', '<unknown>')} references an unknown image/category; skipped.",
                file=sys.stderr,
            )
            continue
        annotations_by_image[image_id].append(annotation)
    return categories, image_by_id, annotations_by_image


def convert_dataset(
    coco_json: Path = COCO_JSON,
    images_dir: Path = IMAGE_DIR,
    output_dir: Path = OUTPUT_DIR,
    val_ratio: float = VAL_RATIO,
    seed: int = RANDOM_SEED,
) -> dict[str, int]:
    if not 0 < val_ratio < 1:
        raise ValueError("val_ratio must be between 0 and 1.")
    coco_json, images_dir, output_dir = map(Path, (coco_json, images_dir, output_dir))
    if not coco_json.is_file():
        raise FileNotFoundError(f"COCO JSON not found: {coco_json}")
    if not images_dir.is_dir():
        raise FileNotFoundError(f"Image directory not found: {images_dir}")

    with coco_json.open("r", encoding="utf-8-sig") as source:
        categories, image_by_id, annotations_by_image = _validate_coco(json.load(source))

    available: list[tuple[Any, dict[str, Any], Path, Path]] = []
    missing_images = 0
    for image_id, image in image_by_id.items():
        relative = _safe_relative_path(str(image["file_name"]))
        source_path = (images_dir / relative).resolve()
        if not source_path.is_relative_to(images_dir.resolve()):
            raise ValueError(f"Image path escapes source directory: {image['file_name']}")
        if not source_path.is_file():
            print(f"Warning: image file not found, skipped: {source_path}", file=sys.stderr)
            missing_images += 1
            continue
        available.append((image_id, image, source_path, relative))

    if not available:
        raise ValueError("No COCO images were found in the source image directory.")

    available.sort(key=lambda item: str(item[0]))
    random.Random(seed).shuffle(available)
    val_count = max(1, round(len(available) * val_ratio)) if len(available) > 1 else 0
    val_ids = {item[0] for item in available[:val_count]}
    counts = {"train_images": 0, "val_images": 0, "label_rows": 0, "missing_images": missing_images}

    for split in ("train", "val"):
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    for image_id, image, source_path, relative in available:
        split = "val" if image_id in val_ids else "train"
        output_image = output_dir / "images" / split / relative
        output_label = output_dir / "labels" / split / relative.with_suffix(".txt")
        output_image.parent.mkdir(parents=True, exist_ok=True)
        output_label.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, output_image)

        rows: list[str] = []
        for annotation in annotations_by_image.get(image_id, []):
            rows.extend(_annotation_rows(annotation, image["width"], image["height"]))
        output_label.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
        counts[f"{split}_images"] += 1
        counts["label_rows"] += len(rows)

    output_dir.mkdir(parents=True, exist_ok=True)
    names = [None] * len(categories)
    for category in categories:
        names[category["id"] - 1] = category["name"]
    data_yaml = [
        f"path: {json.dumps(output_dir.resolve().as_posix(), ensure_ascii=False)}",
        "train: images/train",
        "val: images/val",
        f"nc: {len(names)}",
        "names:",
        *(f"  {index}: {json.dumps(name, ensure_ascii=False)}" for index, name in enumerate(names)),
    ]
    (output_dir / "data.yaml").write_text("\n".join(data_yaml) + "\n", encoding="utf-8")
    return counts


def main() -> None:
    counts = convert_dataset()
    print(
        "Conversion complete: "
        f"train={counts['train_images']}, val={counts['val_images']}, "
        f"label rows={counts['label_rows']}, missing images={counts['missing_images']}"
    )
    print(f"YOLO dataset: {OUTPUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
