from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import shutil
import stat
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024
MAX_UNPACKED_BYTES = 50 * 1024 * 1024 * 1024
MAX_ARCHIVE_FILES = 100_000
MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024 * 1024
MAX_ANNOTATION_BYTES = 1024 * 1024 * 1024
SPLIT_NAMES = {
    "train": {"train", "training"},
    "val": {"val", "valid", "validation"},
    "test": {"test", "testing"},
}


class DatasetError(ValueError):
    pass


def training_root() -> Path:
    data_root = Path(os.environ.get("INSPECTION_DATA_DIR", Path(__file__).parent / "inspection_data"))
    return data_root.expanduser().resolve() / "training"


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _safe_member_path(root: Path, name: str) -> Path:
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    if member.is_absolute() or not member.parts or any(part in ("", ".", "..") for part in member.parts):
        raise DatasetError(f"В архиве есть недопустимый путь: {name}")
    if member.parts[0].endswith(":"):
        raise DatasetError(f"В архиве есть абсолютный путь: {name}")
    destination = root.joinpath(*member.parts).resolve()
    if not destination.is_relative_to(root):
        raise DatasetError(f"Путь архива выходит за пределы каталога: {name}")
    return destination


def _extract_archive(archive_path: Path, destination: Path) -> Path:
    archive_path = archive_path.resolve()
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise DatasetError("ZIP-архив датасета превышает лимит 10 ГБ.")

    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    total_size = 0
    file_count = 0
    seen_paths: set[Path] = set()

    try:
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            for entry in entries:
                target = _safe_member_path(root, entry.filename)
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise DatasetError(f"Символические ссылки в архиве запрещены: {entry.filename}")
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if target in seen_paths:
                    raise DatasetError(f"В архиве повторяется путь: {entry.filename}")
                seen_paths.add(target)
                file_count += 1
                total_size += entry.file_size
                if file_count > MAX_ARCHIVE_FILES:
                    raise DatasetError(f"В архиве более {MAX_ARCHIVE_FILES} файлов.")
                if entry.file_size > MAX_SINGLE_FILE_BYTES:
                    raise DatasetError(f"Файл {entry.filename} превышает лимит 10 ГБ.")
                if total_size > MAX_UNPACKED_BYTES:
                    raise DatasetError("Распакованный архив превышает лимит 50 ГБ.")

            if shutil.disk_usage(root).free < total_size + 1024 * 1024 * 1024:
                raise DatasetError("Недостаточно места на диске: освободите место для распаковки и оставьте запас 1 ГБ.")

            actual_total_size = 0
            for entry in entries:
                if entry.is_dir():
                    continue
                target = _safe_member_path(root, entry.filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                actual_file_size = 0
                with archive.open(entry) as source, target.open("xb") as output:
                    while chunk := source.read(8 * 1024 * 1024):
                        actual_file_size += len(chunk)
                        actual_total_size += len(chunk)
                        if actual_file_size > MAX_SINGLE_FILE_BYTES or actual_total_size > MAX_UNPACKED_BYTES:
                            raise DatasetError("Фактический размер распакованных данных превышает допустимый лимит.")
                        output.write(chunk)
                if actual_file_size != entry.file_size:
                    raise DatasetError(f"Размер файла в ZIP не совпадает с заголовком: {entry.filename}")
    except zipfile.BadZipFile as error:
        shutil.rmtree(destination, ignore_errors=True)
        raise DatasetError("Не удалось открыть ZIP-архив датасета.") from error
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return root


def _validate_yolo_dataset(root: Path, destination: Path, yaml_path: Path) -> dict[str, Any]:
    root = root.resolve()
    yaml_path = yaml_path.resolve()
    if not yaml_path.is_relative_to(root):
        raise DatasetError("data.yaml находится за пределами распакованного архива.")

    try:
        config = yaml.safe_load(yaml_path.read_text(encoding="utf-8-sig"))
    except (OSError, yaml.YAMLError) as error:
        raise DatasetError(f"Не удалось прочитать конфигурацию датасета: {error}") from error
    if not isinstance(config, dict):
        raise DatasetError("Файл data.yaml должен содержать YAML-объект.")

    dataset_root = yaml_path.parent.resolve()
    configured_root = config.get("path", ".")
    if not isinstance(configured_root, str) or Path(configured_root).is_absolute():
        raise DatasetError("Путь `path` в data.yaml должен быть относительным.")
    resolved_root = (dataset_root / configured_root).resolve()
    if not resolved_root.is_relative_to(root):
        raise DatasetError("Путь `path` в data.yaml выходит за пределы архива.")

    names = config.get("names")
    if isinstance(names, dict):
        try:
            names = [names[index] for index in range(len(names))]
        except KeyError as error:
            raise DatasetError("Индексы names в data.yaml должны идти подряд начиная с 0.") from error
    if not isinstance(names, list) or not names or not all(isinstance(name, str) and name.strip() for name in names):
        raise DatasetError("В data.yaml укажите непустой список имён классов в поле names.")

    normalized: dict[str, Any] = {"path": str(resolved_root), "names": names}
    split_counts: dict[str, int] = {}
    total_boxes = 0
    for split in ("train", "val"):
        split_value = config.get(split)
        if isinstance(split_value, str):
            split_values = [split_value]
        elif isinstance(split_value, list) and split_value and all(isinstance(item, str) for item in split_value):
            split_values = split_value
        else:
            raise DatasetError(f"В data.yaml укажите путь или список путей для `{split}`.")

        resolved_splits = []
        image_paths: list[Path] = []
        for value in split_values:
            split_path = Path(value)
            if split_path.is_absolute():
                raise DatasetError(f"Путь `{split}` в data.yaml должен быть относительным.")
            resolved_split = (resolved_root / split_path).resolve()
            if not resolved_split.is_relative_to(root) or not resolved_split.is_dir():
                raise DatasetError(f"Каталог `{split}` не найден внутри архива: {value}")
            resolved_splits.append(resolved_split)
            image_paths.extend(
                image for image in resolved_split.rglob("*")
                if image.is_file() and image.suffix.lower() in IMAGE_EXTENSIONS
            )
        if not image_paths:
            raise DatasetError(f"В наборе `{split}` не найдено изображений.")

        label_count = 0
        for split_path, image_root in zip(split_values, resolved_splits):
            parts = list(Path(split_path).parts)
            image_component = next((index for index, part in enumerate(parts) if part.lower() == "images"), None)
            if image_component is None:
                label_root = image_root.parent.parent / "labels" / image_root.name
            else:
                parts[image_component] = "labels"
                label_root = (resolved_root / Path(*parts)).resolve()
            if not label_root.is_relative_to(root):
                raise DatasetError(f"Путь меток `{split}` выходит за пределы архива.")

            for image in (
                candidate for candidate in image_root.rglob("*")
                if candidate.is_file() and candidate.suffix.lower() in IMAGE_EXTENSIONS
            ):
                label_path = label_root / image.relative_to(image_root).with_suffix(".txt")
                if not label_path.is_file():
                    continue
                for line_number, line in enumerate(label_path.read_text(encoding="utf-8-sig").splitlines(), 1):
                    if not line.strip():
                        continue
                    fields = line.split()
                    if len(fields) != 5:
                        raise DatasetError(
                            f"Ожидается YOLO detection-разметка из 5 значений: {label_path.name}, строка {line_number}."
                        )
                    try:
                        class_id = int(fields[0])
                        coords = [float(value) for value in fields[1:]]
                    except ValueError as error:
                        raise DatasetError(f"Некорректная разметка в {label_path.name}, строка {line_number}.") from error
                    if class_id < 0 or class_id >= len(names):
                        raise DatasetError(
                            f"Индекс класса {class_id} вне диапазона names в {label_path.name}, строка {line_number}."
                        )
                    if not all(math.isfinite(value) and 0 <= value <= 1 for value in coords):
                        raise DatasetError(
                            f"Координаты должны быть числами от 0 до 1: {label_path.name}, строка {line_number}."
                        )
                    if coords[2] <= 0 or coords[3] <= 0:
                        raise DatasetError(f"Ширина и высота рамки должны быть больше 0: {label_path.name}.")
                    label_count += 1

        if label_count == 0:
            raise DatasetError(f"В наборе `{split}` не найдено ни одной размеченной рамки.")
        split_counts[split] = len(image_paths)
        total_boxes += label_count
        normalized[split] = [str(path) for path in resolved_splits]

    if config.get("test") is not None:
        test_value = config["test"]
        test_values = [test_value] if isinstance(test_value, str) else test_value
        if not isinstance(test_values, list) or not all(isinstance(item, str) for item in test_values):
            raise DatasetError("Поле `test` в data.yaml должно быть строкой или списком путей.")
        test_paths = []
        for value in test_values:
            test_path = Path(value)
            if test_path.is_absolute():
                raise DatasetError("Путь `test` в data.yaml должен быть относительным.")
            resolved = (resolved_root / test_path).resolve()
            if not resolved.is_relative_to(root) or not resolved.is_dir():
                raise DatasetError(f"Каталог `test` не найден внутри архива: {value}")
            test_paths.append(str(resolved))
        normalized["test"] = test_paths

    normalized_yaml = destination / "training-data.yaml"
    normalized_yaml.write_text(yaml.safe_dump(normalized, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return {
        "yaml_path": str(normalized_yaml),
        "names": names,
        "train_images": split_counts["train"],
        "val_images": split_counts["val"],
        "labeled_boxes": total_boxes,
        "dataset_root": str(resolved_root),
    }


def _split_hint(path: Path, default: str = "unspecified") -> str:
    for part in reversed(path.parts):
        normalized = re.sub(r"\d+$", "", part.casefold())
        for split, names in SPLIT_NAMES.items():
            if normalized in names:
                return split
    return default


def _resolve_image(root: Path, base: Path, name: str, image_index: dict[str, list[Path]]) -> Path:
    relative = Path(name.replace("\\", "/"))
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise DatasetError(f"Недопустимый путь к изображению в разметке: {name}")
    for candidate in (base / relative, root / relative):
        resolved = candidate.resolve()
        if resolved.is_relative_to(root) and resolved.is_file() and resolved.suffix.lower() in IMAGE_EXTENSIONS:
            return resolved
    matches = image_index.get(relative.name.casefold(), [])
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        preferred_split = _split_hint(base.relative_to(root))
        if preferred_split != "unspecified":
            split_matches = [
                match for match in matches
                if _split_hint(match.relative_to(root)) == preferred_split
            ]
            if len(split_matches) == 1:
                return split_matches[0]
        raise DatasetError(f"Имя изображения неоднозначно, укажите относительный путь: {name}")
    raise DatasetError(f"Не найден файл изображения из разметки: {name}")


def _read_image_index(root: Path) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = {}
    for image in root.rglob("*"):
        if image.is_file() and image.suffix.lower() in IMAGE_EXTENSIONS:
            index.setdefault(image.name.casefold(), []).append(image.resolve())
    if not index:
        raise DatasetError("В архиве не найдены изображения.")
    return index


def _read_annotation_json(path: Path) -> dict[str, Any]:
    if path.stat().st_size > MAX_ANNOTATION_BYTES:
        raise DatasetError(f"Файл разметки {path.name} превышает лимит 1 ГБ.")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise DatasetError(f"Не удалось прочитать {path.name}: {error}") from error
    if not isinstance(value, dict):
        raise DatasetError(f"Файл разметки {path.name} должен содержать JSON-объект.")
    return value


def _add_record(
    records: dict[Path, dict[str, Any]],
    image_path: Path,
    width: float,
    height: float,
    boxes: list[tuple[str, float, float, float, float]],
    split: str,
) -> None:
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise DatasetError(f"Некорректные размеры изображения: {image_path.name}")
    record = records.get(image_path)
    if record is None:
        records[image_path] = {"width": width, "height": height, "boxes": boxes, "split": split}
        return
    if record["width"] != width or record["height"] != height:
        raise DatasetError(f"Разные размеры изображения в повторной разметке: {image_path.name}")
    if record["split"] != "unspecified" and split != "unspecified" and record["split"] != split:
        raise DatasetError(f"Изображение {image_path.name} одновременно попало в разные выборки.")
    if record["split"] == "unspecified":
        record["split"] = split
    record["boxes"].extend(boxes)


def _parse_coco(
    root: Path, json_files: list[Path], image_index: dict[str, list[Path]]
) -> tuple[list[str], dict[Path, dict[str, Any]]]:
    category_names: dict[int, str] = {}
    parsed: list[tuple[Path, dict[str, Any], dict[int, str]]] = []
    for annotation_path in json_files:
        data = _read_annotation_json(annotation_path)
        categories = data.get("categories")
        images = data.get("images")
        annotations = data.get("annotations")
        if not all(isinstance(value, list) for value in (categories, images, annotations)):
            raise DatasetError(f"Некорректная структура COCO в {annotation_path.name}.")
        local_categories: dict[int, str] = {}
        for category in categories:
            try:
                category_id = int(category["id"])
                name = str(category["name"]).strip()
            except (KeyError, TypeError, ValueError) as error:
                raise DatasetError(f"Некорректная категория COCO в {annotation_path.name}.") from error
            if not name or (category_id in local_categories and local_categories[category_id] != name):
                raise DatasetError(f"Повторный или пустой класс COCO в {annotation_path.name}.")
            local_categories[category_id] = name
            if category_id in category_names and category_names[category_id] != name:
                raise DatasetError(f"ID класса COCO {category_id} соответствует разным именам.")
            category_names[category_id] = name
        parsed.append((annotation_path, data, local_categories))

    names = [category_names[key] for key in sorted(category_names)]
    if not names:
        raise DatasetError("В COCO-разметке не заданы категории.")
    records: dict[Path, dict[str, Any]] = {}
    for annotation_path, data, categories in parsed:
        image_records: dict[Any, tuple[Path, float, float, list[tuple[str, float, float, float, float]]]] = {}
        for image in data["images"]:
            try:
                image_id = image["id"]
                name = str(image["file_name"])
                width, height = float(image["width"]), float(image["height"])
            except (KeyError, TypeError, ValueError) as error:
                raise DatasetError(f"Некорректное изображение COCO в {annotation_path.name}.") from error
            image_path = _resolve_image(root, annotation_path.parent, name, image_index)
            image_records[image_id] = (image_path, width, height, [])
        hint = _split_hint(annotation_path.relative_to(root), _split_hint(Path(annotation_path.stem)))
        for annotation in data["annotations"]:
            try:
                image_id = annotation["image_id"]
                category_id = int(annotation["category_id"])
                x, y, width, height = map(float, annotation["bbox"])
            except (KeyError, TypeError, ValueError) as error:
                raise DatasetError(f"Некорректная рамка COCO в {annotation_path.name}.") from error
            if image_id not in image_records or category_id not in categories:
                raise DatasetError(f"Рамка COCO ссылается на неизвестное изображение или категорию в {annotation_path.name}.")
            image_path, image_width, image_height, boxes = image_records[image_id]
            boxes.append((categories[category_id], x, y, x + width, y + height))
        for image_path, width, height, boxes in image_records.values():
            _add_record(records, image_path, width, height, boxes, _split_hint(image_path.relative_to(root), hint))
    return names, records


def _parse_voc(
    root: Path, xml_files: list[Path], image_index: dict[str, list[Path]]
) -> tuple[list[str], dict[Path, dict[str, Any]]]:
    names: set[str] = set()
    records: dict[Path, dict[str, Any]] = {}
    for annotation_path in xml_files:
        try:
            element = ET.parse(annotation_path).getroot()
        except (ET.ParseError, OSError) as error:
            raise DatasetError(f"Некорректный Pascal VOC XML {annotation_path.name}: {error}") from error
        if element.tag.casefold() != "annotation":
            continue
        filename = element.findtext("filename")
        size = element.find("size")
        if not filename or size is None:
            raise DatasetError(f"В Pascal VOC {annotation_path.name} отсутствуют filename или size.")
        try:
            width = float(size.findtext("width", ""))
            height = float(size.findtext("height", ""))
        except ValueError as error:
            raise DatasetError(f"Некорректные размеры в {annotation_path.name}.") from error
        image_path = _resolve_image(root, annotation_path.parent, filename, image_index)
        boxes = []
        for obj in element.findall("object"):
            name = (obj.findtext("name") or "").strip()
            box = obj.find("bndbox")
            if not name or box is None:
                raise DatasetError(f"Объект без имени класса или рамки в {annotation_path.name}.")
            try:
                left, top, right, bottom = (
                    float(box.findtext(key, "")) for key in ("xmin", "ymin", "xmax", "ymax")
                )
            except ValueError as error:
                raise DatasetError(f"Некорректная Pascal VOC рамка в {annotation_path.name}.") from error
            boxes.append((name, left, top, right, bottom))
            names.add(name)
        _add_record(
            records, image_path, width, height, boxes,
            _split_hint(annotation_path.relative_to(root), _split_hint(image_path.relative_to(root))),
        )
    if not names:
        raise DatasetError("В Pascal VOC XML не найдены размеченные объекты.")
    return sorted(names), records


def _parse_labelme(
    root: Path, json_files: list[Path], image_index: dict[str, list[Path]]
) -> tuple[list[str], dict[Path, dict[str, Any]]]:
    names: set[str] = set()
    records: dict[Path, dict[str, Any]] = {}
    for annotation_path in json_files:
        data = _read_annotation_json(annotation_path)
        shapes = data.get("shapes")
        if not isinstance(shapes, list):
            continue
        image_name = data.get("imagePath") or next(
            (f"{annotation_path.stem}{ext}" for ext in IMAGE_EXTENSIONS
             if image_index.get(f"{annotation_path.stem}{ext}".casefold())),
            None,
        )
        if not image_name:
            raise DatasetError(f"В LabelMe {annotation_path.name} не указано изображение.")
        image_path = _resolve_image(root, annotation_path.parent, str(image_name), image_index)
        try:
            width, height = float(data["imageWidth"]), float(data["imageHeight"])
        except (KeyError, TypeError, ValueError) as error:
            raise DatasetError(f"В LabelMe {annotation_path.name} отсутствуют размеры изображения.") from error
        boxes = []
        for shape in shapes:
            label = str(shape.get("label", "")).strip()
            points = shape.get("points")
            if not label or not isinstance(points, list) or len(points) < 2:
                raise DatasetError(f"Некорректная фигура в LabelMe {annotation_path.name}.")
            if shape.get("shape_type", "polygon") not in {"polygon", "rectangle", "rotation", "circle"}:
                raise DatasetError(
                    f"Тип фигуры {shape.get('shape_type')} в LabelMe не поддерживается для detection."
                )
            try:
                xs = [float(point[0]) for point in points]
                ys = [float(point[1]) for point in points]
            except (IndexError, TypeError, ValueError) as error:
                raise DatasetError(f"Некорректные координаты LabelMe в {annotation_path.name}.") from error
            boxes.append((label, min(xs), min(ys), max(xs), max(ys)))
            names.add(label)
        _add_record(
            records, image_path, width, height, boxes,
            _split_hint(annotation_path.relative_to(root), _split_hint(image_path.relative_to(root))),
        )
    if not names:
        raise DatasetError("В LabelMe JSON не найдены размеченные объекты.")
    return sorted(names), records


def _parse_cvat(
    root: Path, xml_files: list[Path], image_index: dict[str, list[Path]]
) -> tuple[list[str], dict[Path, dict[str, Any]]]:
    names: list[str] = []
    records: dict[Path, dict[str, Any]] = {}
    parsed_files = 0
    for annotation_path in xml_files:
        try:
            element = ET.parse(annotation_path).getroot()
        except (ET.ParseError, OSError) as error:
            raise DatasetError(f"Некорректный CVAT XML {annotation_path.name}: {error}") from error
        if element.tag.casefold() != "annotations":
            continue
        images = element.findall("image")
        meta_labels = [
            (label.findtext("name") or "").strip()
            for label in element.findall("./meta/task/labels/label")
        ]
        is_cvat = bool(images) or bool(meta_labels)
        if not is_cvat:
            continue
        parsed_files += 1
        for name in meta_labels:
            if name and name not in names:
                names.append(name)
        for image in images:
            image_name = image.get("name")
            if not image_name:
                raise DatasetError(f"В CVAT {annotation_path.name} у изображения отсутствует name.")
            image_path = _resolve_image(root, annotation_path.parent, image_name, image_index)
            try:
                width, height = float(image.attrib["width"]), float(image.attrib["height"])
            except (KeyError, ValueError) as error:
                raise DatasetError(f"В CVAT {annotation_path.name} отсутствуют размеры изображения.") from error
            boxes = []
            for box in image.findall("box"):
                label = (box.get("label") or "").strip()
                try:
                    left, top, right, bottom = (
                        float(box.attrib[key]) for key in ("xtl", "ytl", "xbr", "ybr")
                    )
                except (KeyError, ValueError) as error:
                    raise DatasetError(f"Некорректная рамка CVAT в {annotation_path.name}.") from error
                if not label:
                    raise DatasetError(f"У рамки CVAT не указан класс в {annotation_path.name}.")
                boxes.append((label, left, top, right, bottom))
                if label not in names:
                    names.append(label)
            _add_record(
                records, image_path, width, height, boxes,
                _split_hint(image_path.relative_to(root), _split_hint(annotation_path.relative_to(root))),
            )
    if parsed_files == 0 or not names:
        raise DatasetError("Не удалось найти CVAT XML с метками классов.")
    return names, records


def _assign_splits(records: dict[Path, dict[str, Any]]) -> tuple[list[Path], list[Path]]:
    train = sorted(path for path, item in records.items() if item["split"] == "train")
    val = sorted(path for path, item in records.items() if item["split"] == "val")
    unspecified = sorted(path for path, item in records.items() if item["split"] == "unspecified")
    if not val:
        candidates = train if len(train) >= 2 else unspecified
        if len(candidates) < 2:
            raise DatasetError("Для автоматического train/val-разделения нужны минимум 2 размеченных изображения.")
        shuffled = list(candidates)
        random.Random(42).shuffle(shuffled)
        validation_count = max(1, round(len(shuffled) * 0.2))
        val = shuffled[:validation_count]
        train = shuffled[validation_count:] if candidates is train else train + shuffled[validation_count:]
        if candidates is unspecified:
            train = shuffled[validation_count:]
    else:
        train.extend(unspecified)
    if not train or not val:
        raise DatasetError("В датасете должны быть непустые выборки train и val.")
    if not any(records[path]["boxes"] for path in train):
        raise DatasetError("В train-выборке нет ни одной рамки.")
    if not any(records[path]["boxes"] for path in val):
        raise DatasetError("В val-выборке нет ни одной рамки.")
    return train, val


def _link_image(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _convert_records_to_yolo(
    records: dict[Path, dict[str, Any]],
    names: list[str],
    destination: Path,
    source_format: str,
) -> dict[str, Any]:
    if not names:
        raise DatasetError("В аннотациях не заданы классы.")
    train, val = _assign_splits(records)
    class_ids = {name: index for index, name in enumerate(names)}
    total_boxes = 0

    for split, paths in (("train", train), ("val", val)):
        for source in paths:
            item = records[source]
            image_id = hashlib.sha256(str(source).encode("utf-8")).hexdigest()[:16]
            filename = f"{image_id}_{source.name}"
            image_target = destination / "images" / split / filename
            label_target = destination / "labels" / split / f"{Path(filename).stem}.txt"
            _link_image(source, image_target)
            lines = []
            width, height = item["width"], item["height"]
            for class_name, x1, y1, x2, y2 in item["boxes"]:
                if class_name not in class_ids:
                    raise DatasetError(f"Класс `{class_name}` не попал в список classes.")
                values = (x1, y1, x2, y2)
                if not all(math.isfinite(value) for value in values):
                    raise DatasetError(f"Некорректная рамка в {source.name}.")
                x1 = min(max(x1, 0.0), width)
                y1 = min(max(y1, 0.0), height)
                x2 = min(max(x2, 0.0), width)
                y2 = min(max(y2, 0.0), height)
                box_width = x2 - x1
                box_height = y2 - y1
                if box_width <= 0 or box_height <= 0:
                    raise DatasetError(f"Пустая или некорректная рамка в {source.name}.")
                center_x = (x1 + x2) / 2 / width
                center_y = (y1 + y2) / 2 / height
                lines.append(
                    f"{class_ids[class_name]} {center_x:.8f} {center_y:.8f} "
                    f"{box_width / width:.8f} {box_height / height:.8f}"
                )
            label_target.parent.mkdir(parents=True, exist_ok=True)
            label_target.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
            total_boxes += len(lines)

    data_yaml = destination / "data.yaml"
    data_yaml.write_text(
        yaml.safe_dump(
            {"path": ".", "train": "images/train", "val": "images/val", "names": names},
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return {
        "source_format": source_format,
        "converted_images": len(records),
        "converted_boxes": total_boxes,
        "class_mapping": {name: class_id for name, class_id in class_ids.items()},
        "data_yaml": str(data_yaml),
    }


def extract_yolo_dataset(archive_path: Path, destination: Path) -> dict[str, Any]:
    root = _extract_archive(archive_path, destination)
    try:
        yaml_files = list(root.rglob("data.yaml")) + list(root.rglob("data.yml"))
        if len(yaml_files) == 1:
            result = _validate_yolo_dataset(root, root, yaml_files[0])
            result["source_format"] = "YOLO"
            result["converted_images"] = result["train_images"] + result["val_images"]
            return result
        if len(yaml_files) > 1:
            raise DatasetError("В архиве найдено несколько data.yaml/data.yml — оставьте один датасет.")

        image_index = _read_image_index(root)
        json_files = list(root.rglob("*.json"))
        coco_files = []
        labelme_files = []
        for annotation_path in json_files:
            if annotation_path.stat().st_size > MAX_ANNOTATION_BYTES:
                continue
            try:
                data = _read_annotation_json(annotation_path)
            except DatasetError:
                continue
            if all(isinstance(data.get(key), list) for key in ("images", "categories", "annotations")):
                coco_files.append(annotation_path)
            elif isinstance(data.get("shapes"), list) and (
                data.get("imagePath") or "imageWidth" in data
            ):
                labelme_files.append(annotation_path)

        xml_files = list(root.rglob("*.xml"))
        voc_files = []
        cvat_files = []
        for annotation_path in xml_files:
            try:
                tag = ET.parse(annotation_path).getroot().tag.casefold()
            except (ET.ParseError, OSError):
                continue
            if tag == "annotation":
                voc_files.append(annotation_path)
            elif tag == "annotations":
                cvat_files.append(annotation_path)

        candidates = [
            ("COCO", coco_files, _parse_coco),
            ("Pascal VOC", voc_files, _parse_voc),
            ("LabelMe", labelme_files, _parse_labelme),
            ("CVAT", cvat_files, _parse_cvat),
        ]
        detected = [(name, files, parser) for name, files, parser in candidates if files]
        if len(detected) != 1:
            if not detected:
                raise DatasetError(
                    "Формат не распознан. Поддерживаются YOLO (data.yaml), COCO JSON, "
                    "Pascal VOC XML, LabelMe JSON и CVAT XML."
                )
            formats = ", ".join(item[0] for item in detected)
            raise DatasetError(f"Найдено несколько форматов разметки ({formats}); оставьте в ZIP один формат.")

        source_format, files, parser = detected[0]
        names, records = parser(root, files, image_index)
        converted_root = root / "converted-yolo"
        converted_root.mkdir()
        conversion_info = _convert_records_to_yolo(records, names, converted_root, source_format)
        result = _validate_yolo_dataset(converted_root, converted_root, converted_root / "data.yaml")
        result.update(conversion_info)
        result["yaml_path"] = str(converted_root / "training-data.yaml")
        return result
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
