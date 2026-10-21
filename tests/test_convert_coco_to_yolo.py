from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from convert_coco_to_yolo import convert_dataset


class CocoToYoloTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, Path]:
        coco_json = root / "annotations.json"
        images_dir = root / "source-images"
        output_dir = root / "dataset"
        images_dir.mkdir(parents=True)
        (images_dir / "seg.jpg").write_bytes(b"segmentation")
        (images_dir / "box.jpg").write_bytes(b"bbox")
        (images_dir / "background.jpg").write_bytes(b"background")
        coco_json.write_text(json.dumps({
            "images": [
                {"id": 1, "file_name": "seg.jpg", "width": 100, "height": 50},
                {"id": 2, "file_name": "box.jpg", "width": 100, "height": 50},
                {"id": 3, "file_name": "background.jpg", "width": 100, "height": 50},
                {"id": 4, "file_name": "missing.jpg", "width": 100, "height": 50},
            ],
            "categories": [
                {"id": 1, "name": "waste"},
                {"id": 2, "name": "plastic"},
            ],
            "annotations": [
                {"id": 11, "image_id": 1, "category_id": 2, "segmentation": [[10, 5, 50, 5, 50, 25, 10, 25]], "bbox": [10, 5, 40, 20]},
                {"id": 12, "image_id": 2, "category_id": 1, "segmentation": [], "bbox": [10, 5, 40, 20]},
                {"id": 13, "image_id": 3, "category_id": 1, "iscrowd": 1, "bbox": [0, 0, 10, 10]},
            ],
        }), encoding="utf-8")
        return coco_json, images_dir, output_dir

    def test_converts_segmentation_bbox_background_and_crowd(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            coco_json, images_dir, output_dir = self._fixture(root)
            counts = convert_dataset(coco_json, images_dir, output_dir, val_ratio=0.34, seed=1)
            self.assertEqual(counts, {
                "train_images": 2, "val_images": 1, "label_rows": 2, "missing_images": 1,
            })
            segmentation_label = next((output_dir / "labels").rglob("seg.txt"))
            self.assertEqual(segmentation_label.read_text(), "1 0.100000 0.100000 0.500000 0.100000 0.500000 0.500000 0.100000 0.500000\n")
            bbox_label = next((output_dir / "labels").rglob("box.txt"))
            self.assertEqual(bbox_label.read_text(), "0 0.300000 0.300000 0.400000 0.400000\n")
            background_label = next((output_dir / "labels").rglob("background.txt"))
            self.assertEqual(background_label.read_text(), "")
            for split in ("train", "val"):
                self.assertTrue((output_dir / "images" / split).is_dir())
                self.assertTrue((output_dir / "labels" / split).is_dir())
            yaml_text = (output_dir / "data.yaml").read_text(encoding="utf-8")
            self.assertIn("nc: 2", yaml_text)
            self.assertIn('0: "waste"', yaml_text)
            self.assertIn('1: "plastic"', yaml_text)

    def test_missing_images_are_reported_and_skipped_without_failing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            coco_json, images_dir, output_dir = self._fixture(root)
            with patch("sys.stderr") as stderr:
                result = convert_dataset(coco_json, images_dir, output_dir, val_ratio=0.5, seed=7)
            self.assertEqual(result["missing_images"], 1)
            self.assertTrue(any("missing.jpg" in str(call) for call in stderr.write.call_args_list))

    def test_same_seed_produces_same_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_json, first_images, first_output = self._fixture(root / "first")
            second_json, second_images, second_output = self._fixture(root / "second")
            convert_dataset(first_json, first_images, first_output, val_ratio=0.5, seed=123)
            convert_dataset(second_json, second_images, second_output, val_ratio=0.5, seed=123)
            first_names = sorted(path.relative_to(first_output).as_posix() for path in first_output.rglob("*") if path.is_file())
            second_names = sorted(path.relative_to(second_output).as_posix() for path in second_output.rglob("*") if path.is_file())
            self.assertEqual(first_names, second_names)
            for name in first_names:
                if name.endswith(".txt"):
                    self.assertEqual(
                        (first_output / name).read_bytes(),
                        (second_output / name).read_bytes(),
                    )

    def test_rejects_category_ids_not_starting_at_one(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            coco_json, images_dir, output_dir = self._fixture(root)
            data = json.loads(coco_json.read_text())
            data["categories"][0]["id"] = 0
            coco_json.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "contiguous and start at 1"):
                convert_dataset(coco_json, images_dir, output_dir)


if __name__ == "__main__":
    unittest.main()
