from __future__ import annotations

import json
import tempfile
import sys
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from training_utils import DatasetError, extract_coco_json_dataset, extract_yolo_dataset
from training_worker import main as run_training


class DatasetValidationTests(unittest.TestCase):
    def _make_dataset(self, root: Path, *, invalid_member: str | None = None, invalid_label: str | None = None):
        archive_path = root / "dataset.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("project/data.yaml", "train: images/train\nval: images/val\nnames: [waste]\n")
            for split in ("train", "val"):
                archive.writestr(f"project/images/{split}/sample.jpg", b"test image bytes")
                label = invalid_label if invalid_label and split == "train" else "0 0.5 0.5 0.25 0.25\n"
                archive.writestr(f"project/labels/{split}/sample.txt", label)
            if invalid_member:
                archive.writestr(invalid_member, b"outside")
        return archive_path

    def test_extracts_and_normalizes_a_nested_yolo_dataset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self._make_dataset(root)
            info = extract_yolo_dataset(archive, root / "extracted")
            self.assertEqual(info["train_images"], 1)
            self.assertEqual(info["val_images"], 1)
            self.assertEqual(info["labeled_boxes"], 2)
            self.assertEqual(info["names"], ["waste"])
            self.assertTrue(Path(info["yaml_path"]).is_file())
            self.assertIn(str((root / "extracted" / "project").resolve()), Path(info["yaml_path"]).read_text())

    def test_rejects_zip_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self._make_dataset(root, invalid_member="../outside.txt")
            with self.assertRaises(DatasetError):
                extract_yolo_dataset(archive, root / "extracted")
            self.assertFalse((root / "outside.txt").exists())

    def test_rejects_invalid_detection_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self._make_dataset(root, invalid_label="0 0.5 2.0 0.25 0.25\n")
            with self.assertRaisesRegex(DatasetError, "от 0 до 1"):
                extract_yolo_dataset(archive, root / "extracted")

    def test_rejects_paths_escaping_dataset_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "escape.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("data.yaml", "path: ../outside\ntrain: images/train\nval: images/val\nnames: [waste]\n")
            with self.assertRaisesRegex(DatasetError, "выходит за пределы"):
                extract_yolo_dataset(archive_path, root / "extracted")

    def test_accepts_coco_json_with_separate_images_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            annotation_path = root / "annotations.json"
            annotation_path.write_text(json.dumps({
                "images": [
                    {"id": 1, "file_name": "images/a.jpg", "width": 100, "height": 80},
                    {"id": 2, "file_name": "images/b.jpg", "width": 100, "height": 80},
                    {"id": 3, "file_name": "images/missing.jpg", "width": 100, "height": 80},
                ],
                "categories": [{"id": 1, "name": "waste"}],
                "annotations": [
                    {"id": 1, "image_id": 1, "category_id": 1, "bbox": [10, 8, 30, 20],
                     "segmentation": [[10, 8, 40, 8, 40, 28]]},
                    {"id": 2, "image_id": 2, "category_id": 1, "bbox": [20, 10, 20, 20]},
                    {"id": 3, "image_id": 2, "category_id": 1, "iscrowd": 1, "bbox": [0, 0, 10, 10]},
                    {"id": 4, "image_id": 3, "category_id": 1, "bbox": [0, 0, 10, 10]},
                ],
            }), encoding="utf-8")
            images_archive = root / "images.zip"
            with zipfile.ZipFile(images_archive, "w") as archive:
                archive.writestr("images/a.jpg", b"a")
                archive.writestr("images/b.jpg", b"b")

            info = extract_coco_json_dataset(annotation_path, images_archive, root / "dataset")

            self.assertEqual(info["source_format"], "COCO JSON")
            self.assertEqual(info["train_images"], 1)
            self.assertEqual(info["val_images"], 1)
            self.assertEqual(info["labeled_boxes"], 2)
            label_files = list((Path(info["dataset_root"]) / "labels").rglob("*.txt"))
            self.assertEqual(len(label_files), 2)
            self.assertTrue(all(len(label.read_text().strip().split()) == 5 for label in label_files))

    def _convert_format_archive(self, root: Path, file_format: str) -> dict:
        archive_path = root / f"{file_format}.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            for split in ("train", "val"):
                archive.writestr(f"images/{split}/sample.jpg", b"test image bytes")

            if file_format == "COCO":
                for split in ("train", "val"):
                    annotation = {
                        "images": [{"id": 1, "file_name": f"images/{split}/sample.jpg", "width": 100, "height": 80}],
                        "categories": [{"id": 5, "name": "waste"}],
                        "annotations": [{"image_id": 1, "category_id": 5, "bbox": [10, 8, 30, 20]}],
                    }
                    archive.writestr(
                        f"annotations/instances_{split}.json",
                        json.dumps(annotation),
                    )
            elif file_format == "Pascal VOC":
                for split in ("train", "val"):
                    annotation = (
                        "<annotation><filename>sample.jpg</filename><size><width>100</width>"
                        "<height>80</height></size><object><name>waste</name><bndbox>"
                        "<xmin>10</xmin><ymin>8</ymin><xmax>40</xmax><ymax>28</ymax>"
                        "</bndbox></object></annotation>"
                    )
                    archive.writestr(f"annotations/{split}/sample.xml", annotation)
            elif file_format == "LabelMe":
                for split in ("train", "val"):
                    annotation = {
                        "imagePath": "sample.jpg",
                        "imageWidth": 100,
                        "imageHeight": 80,
                        "shapes": [{
                            "label": "waste",
                            "shape_type": "rectangle",
                            "points": [[10, 8], [40, 28]],
                        }],
                    }
                    archive.writestr(f"images/{split}/sample.json", json.dumps(annotation))
            elif file_format == "CVAT":
                image_nodes = "".join(
                    f'<image id="{i}" name="images/{split}/sample.jpg" width="100" height="80">'
                    '<box label="waste" xtl="10" ytl="8" xbr="40" ybr="28"/>'
                    "</image>"
                    for i, split in enumerate(("train", "val"))
                )
                archive.writestr(
                    "annotations/annotations.xml",
                    "<annotations><meta><task><labels><label><name>waste</name></label>"
                    "</labels></task></meta>" + image_nodes + "</annotations>",
                )
            else:
                raise AssertionError(file_format)
        return extract_yolo_dataset(archive_path, root / "extracted")

    def test_converts_coco_to_yolo_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            info = self._convert_format_archive(Path(temporary), "COCO")
            self.assertEqual(info["source_format"], "COCO")
            self.assertEqual(info["train_images"], 1)
            self.assertEqual(info["val_images"], 1)
            self.assertEqual(info["labeled_boxes"], 2)
            train_label = Path(info["dataset_root"]) / "labels" / "train"
            self.assertEqual(len(list(train_label.glob("*.txt"))), 1)
            self.assertIn("0 0.25000000 0.22500000 0.30000000 0.25000000", next(train_label.glob("*.txt")).read_text())

    def test_converts_pascal_voc_to_yolo_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            info = self._convert_format_archive(Path(temporary), "Pascal VOC")
            self.assertEqual(info["source_format"], "Pascal VOC")
            self.assertEqual(info["labeled_boxes"], 2)

    def test_converts_labelme_to_yolo_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            info = self._convert_format_archive(Path(temporary), "LabelMe")
            self.assertEqual(info["source_format"], "LabelMe")
            self.assertEqual(info["labeled_boxes"], 2)

    def test_converts_cvat_to_yolo_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            info = self._convert_format_archive(Path(temporary), "CVAT")
            self.assertEqual(info["source_format"], "CVAT")
            self.assertEqual(info["labeled_boxes"], 2)

    def test_splits_unpartitioned_labelme_data_deterministically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "unpartitioned.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                for index in range(10):
                    archive.writestr(f"images/sample-{index}.jpg", b"test image bytes")
                    annotation = {
                        "imagePath": f"sample-{index}.jpg",
                        "imageWidth": 100,
                        "imageHeight": 80,
                        "shapes": [{"label": "waste", "shape_type": "rectangle", "points": [[1, 2], [20, 30]]}],
                    }
                    archive.writestr(f"images/sample-{index}.json", json.dumps(annotation))
            info = extract_yolo_dataset(archive_path, root / "extracted")
            self.assertEqual(info["train_images"], 8)
            self.assertEqual(info["val_images"], 2)

    def test_rejects_mixed_annotation_formats(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "mixed.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("images/train/a.jpg", b"a")
                archive.writestr("images/val/b.jpg", b"b")
                archive.writestr("labels/train/a.json", json.dumps({
                    "imagePath": "a.jpg", "imageWidth": 10, "imageHeight": 10,
                    "shapes": [{"label": "waste", "points": [[1, 1], [5, 5]]}],
                }))
                archive.writestr("annotations/instances_train.json", json.dumps({
                    "images": [{"id": 1, "file_name": "images/train/a.jpg", "width": 10, "height": 10}],
                    "categories": [{"id": 1, "name": "waste"}],
                    "annotations": [{"image_id": 1, "category_id": 1, "bbox": [1, 1, 4, 4]}],
                }))
            with self.assertRaisesRegex(DatasetError, "несколько форматов"):
                extract_yolo_dataset(archive_path, root / "extracted")

    def test_training_worker_records_completed_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = root / "weights" / "best.pt"
            checkpoint.parent.mkdir()
            checkpoint.write_bytes(b"test-model")
            trainer = types.SimpleNamespace(
                epoch=0,
                epochs=1,
                tloss=None,
                metrics={"metrics/mAP50(B)": 0.75},
                best=str(checkpoint),
                save_dir=str(root),
            )

            class FakeYOLO:
                def __init__(self, _checkpoint):
                    self.callbacks = {}
                    self.trainer = trainer

                def add_callback(self, event, callback):
                    self.callbacks[event] = callback

                def train(self, **_kwargs):
                    self.callbacks["on_train_epoch_end"](trainer)
                    return object()

            config_path = root / "config.json"
            status_path = root / "status.json"
            config_path.write_text(
                json.dumps({
                    "checkpoint": str(root / "base.pt"),
                    "data_yaml": str(root / "data.yaml"),
                    "epochs": 1,
                    "imgsz": 640,
                    "batch": -1,
                    "workers": 0,
                    "project": str(root),
                    "run_name": "test-run",
                    "status_path": str(status_path),
                    "cancel_path": str(root / "cancel"),
                    "log_path": str(root / "training.log"),
                }),
                encoding="utf-8",
            )
            with patch.dict(sys.modules, {"ultralytics": types.SimpleNamespace(YOLO=FakeYOLO)}):
                self.assertEqual(run_training(config_path), 0)
            status = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(status["status"], "completed")
            self.assertEqual(status["best_model"], str(checkpoint))


if __name__ == "__main__":
    unittest.main()
