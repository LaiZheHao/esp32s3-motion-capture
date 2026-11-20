"""Read and export short motion from saved single-board sessions."""
import csv
from decimal import Decimal, ROUND_HALF_UP
import io
import json
from math import isfinite
from pathlib import Path
from tempfile import NamedTemporaryFile

from .body_recording import SCHEMA
from .models import SensorSample
from .segment_displacement import (
    FACES, MOTION_CSV_NAME, compare_reference, fit_accelerometer, measure_segment, whole_second_rows,
)

SUMMARY_NAME = "single_node_motion_summary.json"

CSV_HEADER = (
    "时间（秒）", "横滚角（°）", "俯仰角（°）", "航向角（°）",
    "X轴速度（m/s）", "Y轴速度（m/s）", "Z轴速度（m/s）",
    "X轴相对位移（m）", "Y轴相对位移（m）", "Z轴相对位移（m）",
)


def _rounded(value, quantum):
    decimal = Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP)
    return format(decimal if decimal else abs(decimal), "f")


def motion_csv(trajectory):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(CSV_HEADER)
    angle_quantum, motion_quantum = Decimal("0.1"), Decimal("0.001")
    for row in whole_second_rows(trajectory):
        writer.writerow((row[0], *(_rounded(v, angle_quantum) for v in row[1:4]),
                         *(_rounded(v, motion_quantum) for v in row[4:])))
    return output.getvalue()


def _write_result(path, content, encoding):
    with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        temporary.write_bytes(content.encode(encoding))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_single_board(folder):
    metadata = json.loads(_session_file(folder, "metadata.json").read_text(encoding="utf-8"))
    if (not isinstance(metadata, dict) or metadata.get("schema_version") != SCHEMA
            or metadata.get("status") != "complete"):
        raise ValueError(f"{folder.name} 需要是已停止并完整保存的动作会话")
    with _session_file(folder, "samples.jsonl").open(encoding="utf-8") as handle:
        samples = []
        for line in handle:
            data = json.loads(line)["data"]
            if data["source"] != "real":
                raise ValueError(f"{folder.name} 含非实板采样")
            samples.append(SensorSample(**data["raw"]))
            if len(samples) > 5000:
                raise ValueError(f"{folder.name} 录制过长，请为每个静置面和动作单独录制")
    if not samples:
        raise ValueError(f"{folder.name} 没有实板原始采样")
    return samples


def _session_file(folder, name):
    path = (folder / name).resolve()
    if path.parent != folder.resolve():
        raise ValueError(f"{folder.name} 的 {name} 不在会话目录内")
    if not path.is_file():
        raise FileNotFoundError(f"{folder.name} 缺少 {name}")
    return path


def preview_motion(folder):
    path = folder / MOTION_CSV_NAME
    if not path.is_file():
        return {"columns": list(CSV_HEADER), "rows": [], "endpoint": None}
    with _session_file(folder, MOTION_CSV_NAME).open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        columns = next(reader, [])
        rows = list(reader)
    endpoint = None
    try:
        summary = json.loads(_session_file(folder, SUMMARY_NAME).read_text(encoding="utf-8"))
        vector = summary["displacement_m"]
        values = (*vector, summary["distance_m"], summary["duration_s"])
        if len(vector) == 3 and all(isinstance(v, (int, float)) and isfinite(v) for v in values):
            endpoint = {key: summary[key] for key in ("displacement_m", "distance_m", "duration_s")}
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return {"columns": columns, "rows": rows, "endpoint": endpoint}


def export_motion(motion_folder, face_folders, start_still=1., end_still=1., reference=None):
    if set(face_folders) != set(FACES):
        raise ValueError("请为 +X、−X、+Y、−Y、+Z、−Z 各选择一个静置会话")
    folders = {folder.resolve() for folder in face_folders.values()}
    if len(folders) != len(FACES) or motion_folder.resolve() in folders:
        raise ValueError("动作和六个标定面需要使用七条不同的会话")
    if reference is not None and not all(isfinite(v) for v in reference):
        raise ValueError("参考位移须是三个有限数值")

    faces = {face: load_single_board(face_folders[face]) for face in FACES}
    motion = load_single_board(motion_folder)
    devices = {sample.node_id for series in (motion, *faces.values()) for sample in series}
    if len(devices) != 1:
        raise ValueError("六面静置和动作记录必须来自同一块板")
    bias, scale = fit_accelerometer(faces)
    report = measure_segment(motion, (bias, scale), start_still, end_still)
    trajectory = report.pop("trajectory")
    report.update(
        device_id=motion[0].node_id,
        motion_session=motion_folder.name,
        face_sessions={face: face_folders[face].name for face in FACES},
        acceleration_calibration={"bias_g": bias, "scale": scale},
        motion_csv=MOTION_CSV_NAME,
        summary_file=SUMMARY_NAME,
    )
    if reference is not None:
        report["validation"] = compare_reference(report["displacement_m"], reference)
    summary = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
    csv_text = motion_csv(trajectory)
    _write_result(motion_folder / MOTION_CSV_NAME, csv_text, "utf-8-sig")
    _write_result(motion_folder / SUMMARY_NAME, summary + "\n", "utf-8")
    return {"summary": report, "csv": csv_text}
