from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import streamlit as st

from training_utils import (
    MAX_ARCHIVE_BYTES,
    MAX_CHECKPOINT_BYTES,
    DatasetError,
    extract_coco_json_dataset,
    extract_yolo_dataset,
    read_json,
    training_root,
    write_json_atomic,
)
from training_environment import get_training_environment

st.set_page_config(
    page_title="Дообучение модели · Inspection AI",
    page_icon="⚙",
    layout="wide",
)

TRAINING_ROOT = training_root()
JOBS_ROOT = TRAINING_ROOT / "jobs"
ACTIVE_JOB_PATH = TRAINING_ROOT / "active-job.json"
MODEL_PATH_DEFAULT = os.environ.get(
    "YOLO_MODEL_PATH",
    "",
)

st.markdown(
    """
    <style>
      .block-container { max-width: 1180px; padding-top: 2rem; }
      .hero { padding: 1.5rem 1.8rem; border-radius: 18px; color: white;
        background: linear-gradient(115deg,#14253d,#2475a8); margin-bottom: 1.5rem; }
      .hero h1 { color: white; margin: 0 0 .4rem; }
      .hero p { color: #dceaf5; margin: 0; }
      div[data-testid="stMetric"] { background: #f5f8fb; padding: 1rem;
        border-radius: 12px; border: 1px solid #e3eaf1; }
      .hint { color: #596b80; font-size: .92rem; }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(
    """
    <div class="hero">
      <h1>Дообучение модели YOLO</h1>
      <p>Подготовьте размеченный датасет, выберите базовые веса и запустите обучение.</p>
    </div>
    """,
    unsafe_allow_html=True,
)

st.warning(
    "Дообучение создаёт новую модель и не заменяет автоматически рабочие веса сайта. "
    "После обучения проверьте качество и вручную укажите полученный best.pt для инференса."
)
st.info(
    "Можно загрузить готовый ZIP-датасет или отдельно COCO JSON и ZIP с изображениями, "
    "на которые ссылается JSON. Для обычного ZIP также поддерживаются YOLO, COCO, "
    "Pascal VOC, LabelMe и CVAT. Обучение сайта выполняется в режиме Detection: "
    "для COCO используются bbox, сегментационные полигоны не обучаются. "
    "Лимит COCO JSON — 1 ГБ."
)
st.warning(
    "Лимит одного файла — 10 ГБ. Streamlit временно держит загруженный файл в памяти, "
    "поэтому для файлов такого размера нужны большой объём RAM и свободное место на диске. "
    "Распаковка ограничена 50 ГБ."
)

training_environment = get_training_environment()
if not training_environment["torch_available"]:
    st.error(
        "PyTorch не установлен или не загружается в текущем Python. "
        "Установите зависимости командой `py -3 -m pip install -r requirements.txt`."
    )
elif training_environment["cuda_available"]:
    gpu_list = ", ".join(
        f"GPU {device['index']}: {device['name']}"
        for device in training_environment["devices"]
    )
    st.success(f"Обнаружен PyTorch {training_environment['torch_version']} с CUDA. {gpu_list}")
elif training_environment["nvidia_detected"]:
    st.warning(
        f"Найдена видеокарта NVIDIA ({training_environment['nvidia_details']}), "
        f"но текущая сборка PyTorch {training_environment['torch_version']} не видит CUDA. "
        "Обучение автоматически переключится на CPU. Для GPU установите подходящую "
        "[сборку PyTorch](https://pytorch.org/get-started/locally/)."
    )
else:
    cpu_message = f"CUDA-видеокарта не обнаружена. Будет использоваться CPU (PyTorch {training_environment['torch_version']})."
    if training_environment["error"]:
        cpu_message += f" Проверка CUDA: {training_environment['error']}"
    st.info(cpu_message)

with st.form("training-form", clear_on_submit=False):
    st.subheader("1. Датасет и базовая модель")
    dataset_file = st.file_uploader(
        "Готовый датасет (.zip), необязательно если загружаете COCO отдельно",
        type=["zip"],
        help="Поддерживаются YOLO, COCO, Pascal VOC, LabelMe и CVAT. Лимит ZIP — 10 ГБ.",
    )
    coco_json_file = st.file_uploader(
        "COCO-разметка (.json)",
        type=["json"],
        help="COCO JSON с массивами images, categories и annotations. Лимит файла — 1 ГБ.",
    )
    coco_images_file = st.file_uploader(
        "ZIP с изображениями из COCO JSON",
        type=["zip"],
        help="Архив должен содержать изображения, имена/пути которых указаны в file_name. Лимит — 10 ГБ.",
    )
    checkpoint_file = st.file_uploader(
        "Базовые веса (.pt), необязательно",
        type=["pt"],
        help="Лимит файла 10 ГБ. Загружайте только доверенный checkpoint PyTorch.",
    )
    checkpoint_path = st.text_input(
        "Или путь к базовым весам на этом компьютере",
        value=MODEL_PATH_DEFAULT,
        help="Если загружен файл .pt, используется он; иначе берётся указанный путь.",
    )

    st.subheader("2. Параметры обучения")
    column_a, column_b, column_c, column_d = st.columns(4)
    with column_a:
        epochs = st.number_input("Эпохи", min_value=1, max_value=300, value=50, step=1)
    with column_b:
        image_size = st.select_slider(
            "Размер изображения",
            options=[320, 416, 512, 640, 768, 896, 1024, 1280],
            value=640,
        )
    with column_c:
        batch_size = st.selectbox("Размер batch", options=[-1, 2, 4, 8, 16, 32], index=0,
                                  format_func=lambda value: "Авто" if value == -1 else str(value))
    with column_d:
        device_options = ["Авто (GPU если доступен, иначе CPU)", "CPU"]
        device_options.extend(
            f"GPU {device['index']}: {device['name']}"
            for device in training_environment["devices"]
        )
        device = st.selectbox("Устройство", device_options, index=0)

    submitted = st.form_submit_button("Проверить датасет и запустить обучение", type="primary")

if submitted:
    has_coco_upload = bool(coco_json_file or coco_images_file)
    if bool(dataset_file) == has_coco_upload:
        st.error("Загрузите либо один готовый ZIP-датасет, либо COCO JSON вместе с ZIP изображений.")
    elif dataset_file and dataset_file.size > MAX_ARCHIVE_BYTES:
        st.error("ZIP-архив превышает лимит 10 ГБ.")
    elif coco_json_file and coco_json_file.size > 1024 * 1024 * 1024:
        st.error("COCO JSON превышает лимит 1 ГБ.")
    elif coco_images_file and coco_images_file.size > MAX_ARCHIVE_BYTES:
        st.error("ZIP изображений превышает лимит 10 ГБ.")
    elif has_coco_upload and (not coco_json_file or not coco_images_file):
        st.error("Для COCO загрузите и JSON-разметку, и ZIP с изображениями.")
    elif checkpoint_file and checkpoint_file.size > MAX_CHECKPOINT_BYTES:
        st.error("Файл модели превышает лимит 10 ГБ.")
    else:
        checkpoint_source = None
        if checkpoint_file:
            checkpoint_source = "upload"
        elif checkpoint_path.strip():
            checkpoint_source = Path(checkpoint_path.strip()).expanduser()
        if checkpoint_source == "upload":
            checkpoint_is_available = True
        else:
            checkpoint_is_available = bool(
                checkpoint_source and checkpoint_source.is_file()
                and checkpoint_source.suffix.lower() == ".pt"
            )
        if not checkpoint_is_available:
            st.error("Укажите существующий файл весов .pt или загрузите его.")
        else:
            job_dir = None
            worker_started = False
            try:
                TRAINING_ROOT.mkdir(parents=True, exist_ok=True)
                if ACTIVE_JOB_PATH.exists():
                    current = read_json(ACTIVE_JOB_PATH) or {}
                    current_status = read_json(Path(current.get("status_path", ""))) if current.get("status_path") else None
                    if current_status and current_status.get("status") == "running":
                        raise DatasetError("Обучение уже запущено. Дождитесь его завершения или остановите текущую задачу.")

                job_id = uuid.uuid4().hex
                job_dir = JOBS_ROOT / job_id
                job_dir.mkdir(parents=True, exist_ok=False)
                dataset_root = job_dir / "dataset"
                if dataset_file:
                    archive_path = job_dir / "dataset.zip"
                    dataset_file.seek(0)
                    with archive_path.open("wb") as archive_output:
                        shutil.copyfileobj(dataset_file, archive_output, length=8 * 1024 * 1024)
                    dataset_info = extract_yolo_dataset(archive_path, dataset_root)
                else:
                    annotation_path = job_dir / "annotations.json"
                    coco_json_file.seek(0)
                    with annotation_path.open("wb") as annotation_output:
                        shutil.copyfileobj(coco_json_file, annotation_output, length=8 * 1024 * 1024)
                    images_archive_path = job_dir / "coco-images.zip"
                    coco_images_file.seek(0)
                    with images_archive_path.open("wb") as images_output:
                        shutil.copyfileobj(coco_images_file, images_output, length=8 * 1024 * 1024)
                    dataset_info = extract_coco_json_dataset(
                        annotation_path,
                        images_archive_path,
                        dataset_root,
                    )

                if checkpoint_file:
                    checkpoint = job_dir / "base-model.pt"
                    checkpoint_file.seek(0)
                    with checkpoint.open("wb") as checkpoint_output:
                        shutil.copyfileobj(checkpoint_file, checkpoint_output, length=8 * 1024 * 1024)
                else:
                    checkpoint = Path(checkpoint_path.strip()).expanduser().resolve()

                run_name = f"finetune-{job_id[:8]}"
                run_dir = TRAINING_ROOT / "runs"
                status_path = job_dir / "status.json"
                log_path = job_dir / "training.log"
                cancel_path = job_dir / "cancel.requested"
                config_path = job_dir / "config.json"
                config = {
                    "checkpoint": str(checkpoint),
                    "data_yaml": dataset_info["yaml_path"],
                    "epochs": int(epochs),
                    "imgsz": int(image_size),
                    "batch": int(batch_size),
                    "workers": 0,
                    "device": (
                        "auto" if device.startswith("Авто")
                        else "cpu" if device == "CPU"
                        else device.split(":", 1)[0].replace("GPU ", "")
                    ),
                    "project": str(run_dir),
                    "run_name": run_name,
                    "status_path": str(status_path),
                    "log_path": str(log_path),
                    "cancel_path": str(cancel_path),
                }
                config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
                write_json_atomic(status_path, {
                    "status": "starting",
                    "epoch": 0,
                    "epochs": int(epochs),
                    "dataset": dataset_info,
                    "run_name": run_name,
                    "started_at": time.time(),
                })
                write_json_atomic(ACTIVE_JOB_PATH, {
                    "job_id": job_id,
                    "status_path": str(status_path),
                    "log_path": str(log_path),
                    "cancel_path": str(cancel_path),
                    "config_path": str(config_path),
                    "checkpoint": str(checkpoint),
                    "run_name": run_name,
                    "dataset": dataset_info,
                })
                with log_path.open("ab") as log_handle:
                    creation_flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    process = subprocess.Popen(
                        [sys.executable, "-u", str(Path(__file__).with_name("training_worker.py")), str(config_path)],
                        cwd=str(Path(__file__).parent),
                        stdin=subprocess.DEVNULL,
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        creationflags=creation_flags,
                    )
                worker_started = True
                st.success(
                    f"Задача {run_name} запущена. Формат: {dataset_info['source_format']}. "
                    f"Датасет проверен: "
                    f"{dataset_info['train_images']} фото train, {dataset_info['val_images']} фото val, "
                    f"{dataset_info['labeled_boxes']} рамок."
                )
                st.rerun()
            except (DatasetError, OSError) as error:
                if job_dir and not worker_started:
                    shutil.rmtree(job_dir, ignore_errors=True)
                st.error(str(error))
            except Exception as error:
                if job_dir and not worker_started:
                    shutil.rmtree(job_dir, ignore_errors=True)
                st.error(f"Не удалось запустить обучение: {error}")

active_job = read_json(ACTIVE_JOB_PATH) if ACTIVE_JOB_PATH.exists() else None
if active_job and active_job.get("status_path"):
    status_path = Path(active_job["status_path"])
    log_path = Path(active_job.get("log_path", ""))
    cancel_path = Path(active_job.get("cancel_path", ""))

    st.divider()
    st.subheader(f"Состояние обучения · {active_job.get('run_name', 'задача')}")

    if st.button("Остановить после текущей эпохи", type="secondary"):
        cancel_path.parent.mkdir(parents=True, exist_ok=True)
        cancel_path.touch(exist_ok=True)
        st.info("Запрос на остановку сохранён. Обучение остановится после текущей эпохи.")

    @st.fragment(run_every="2s")
    def render_training_status():
        status = read_json(status_path) or {"status": "unknown"}
        current_status = status.get("status", "unknown")
        epoch = int(status.get("epoch", 0))
        total_epochs = max(1, int(status.get("epochs", 1)))
        st.progress(min(epoch / total_epochs, 1.0), text=f"Эпоха {epoch} из {total_epochs}")

        labels = {
            "starting": "Подготовка процесса обучения…",
            "running": "Модель обучается",
            "completed": "Обучение завершено",
            "cancelled": "Обучение остановлено",
            "failed": "Ошибка обучения",
        }
        st.write(labels.get(current_status, current_status))
        dataset = status.get("dataset") or active_job.get("dataset", {})
        if dataset:
            metrics = st.columns(3)
            metrics[0].metric("Изображения train", dataset.get("train_images", "—"))
            metrics[1].metric("Изображения val", dataset.get("val_images", "—"))
            metrics[2].metric("Размеченные рамки", dataset.get("labeled_boxes", "—"))
            st.caption(f"Исходный формат: {dataset.get('source_format', 'YOLO')}")
            if dataset.get("class_mapping"):
                st.json(dataset["class_mapping"], expanded=False)
        if status.get("metrics"):
            st.json(status["metrics"], expanded=False)
        if status.get("error"):
            st.error(status["error"])
        if status.get("device_used"):
            st.caption(f"Фактически используется: {status['device_used']}")
        if status.get("device_note"):
            st.warning(status["device_note"])
        if status.get("best_model") and Path(status["best_model"]).is_file():
            best_model = Path(status["best_model"])
            st.success(f"Лучшая модель сохранена: {best_model}")
            st.download_button(
                "Скачать best.pt",
                data=best_model.read_bytes(),
                file_name="best.pt",
                mime="application/octet-stream",
            )
        if log_path.is_file():
            try:
                with log_path.open("rb") as log_file:
                    log_file.seek(max(0, log_file.seek(0, os.SEEK_END) - 12_000))
                    tail = log_file.read().decode("utf-8", errors="replace")
                with st.expander("Журнал обучения"):
                    st.code(tail[-12_000:] or "Журнал пока пуст.", language="text")
            except OSError as error:
                st.warning(f"Не удалось прочитать журнал обучения: {error}")

    render_training_status()

st.caption("Обучение выполняется на этом компьютере. Для GPU нужны совместимые драйверы и сборка PyTorch с CUDA.")
