"""Measure a short stop-to-stop motion from saved single-board sessions."""
import argparse
import csv
from decimal import Decimal, ROUND_HALF_UP
import io
import json
from math import isfinite
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
from dashboard.body_recording import SCHEMA
from dashboard.models import SensorSample
from dashboard.segment_displacement import (
    FACES, MOTION_CSV_NAME, compare_reference, fit_accelerometer, measure_segment, whole_second_rows,
)


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
    metadata = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    if (not isinstance(metadata, dict) or metadata.get("schema_version") != SCHEMA
            or metadata.get("status") != "complete"):
        raise ValueError(f"{folder.name} 需要是已停止并完整保存的动作会话")
    with (folder / "samples.jsonl").open(encoding="utf-8") as handle:
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("motion", type=Path, help="已保存的短动作会话目录")
    parser.add_argument("--faces", type=Path, required=True, nargs=6,
                        metavar=("XP", "XN", "YP", "YN", "ZP", "ZN"),
                        help="按 +X -X +Y -Y +Z -Z 原始轴朝上的顺序提供六个静置会话目录")
    parser.add_argument("--start-still", type=float, default=1., help="起点静置窗秒数，默认 1")
    parser.add_argument("--end-still", type=float, default=1., help="终点静置窗秒数，默认 1")
    parser.add_argument("--reference", type=float, nargs=3, metavar=("DX", "DY", "DZ"),
                        help="独立实测终点位移向量（米），只用于验收")
    args = parser.parse_args()
    try:
        if args.reference is not None and not all(isfinite(v) for v in args.reference):
            raise ValueError("参考位移须是三个有限数值")
        faces = {face: load_single_board(folder) for face, folder in zip(FACES, args.faces)}
        motion = load_single_board(args.motion)
        devices = {s.node_id for series in [motion, *faces.values()] for s in series}
        if len(devices) != 1:
            raise ValueError("六面静置和动作记录必须来自同一块板")
        calibration = fit_accelerometer(faces)
        report = measure_segment(motion, calibration, args.start_still, args.end_still)
        trajectory = report.pop("trajectory")
        report.update(device_id=motion[0].node_id, motion_session=args.motion.name,
                      face_sessions={face: folder.name for face, folder in zip(FACES, args.faces)},
                      acceleration_calibration={"bias_g": calibration[0], "scale": calibration[1]})
        if args.reference is not None:
            report["validation"] = compare_reference(report["displacement_m"], args.reference)
        report.update(motion_csv=MOTION_CSV_NAME, summary_file="single_node_motion_summary.json")
        summary = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
        _write_result(args.motion / MOTION_CSV_NAME, motion_csv(trajectory), "utf-8-sig")
        _write_result(args.motion / report["summary_file"], summary + "\n", "utf-8")
    except (KeyError, OSError, TypeError, ValueError) as exc:
        parser.error(str(exc))
    print(summary)


if __name__ == "__main__":
    main()
