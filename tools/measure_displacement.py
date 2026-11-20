"""Measure a short stop-to-stop motion from saved single-board sessions."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
from dashboard.motion_export import export_motion, load_single_board, motion_csv
from dashboard.segment_displacement import FACES


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
        result = export_motion(
            args.motion, dict(zip(FACES, args.faces)), args.start_still, args.end_still, args.reference)
    except (KeyError, OSError, TypeError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
