"""Synthetic two-node relative-position updates; no live dashboard/firmware changes.

Install tools/requirements-simulation.txt, then run this script from any directory.
The measurement is a known 3D relative vector in a common world frame, not distance
alone and not a zero-velocity update. Attitude estimation is deliberately excluded.
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np


METHODS = ("unconstrained", "position_reset", "position_velocity_bias_filter")


def simulate(seed=0, period=2., duration=60., dt=.01, measurement_sigma=.005):
    rng = np.random.default_rng(seed)
    steps = round(duration / dt)
    every = round(period / dt)
    if every < 1 or abs(every * dt - period) > 1e-8:
        raise ValueError("period must be an integer multiple of dt")
    t = np.arange(steps + 1) * dt
    # Every 2 s both nodes return to the SAME relative vector, with NONZERO
    # relative velocity. Their common center continues translating throughout.
    w = np.pi
    base = np.array([.5, .1, .2])
    amp = np.array([.18, .12, .08])
    rel = base + np.sin(w * t[:, None]) * amp
    rv = w * np.cos(w * t[:, None]) * amp
    center = np.column_stack((.1 * t, .05 * np.sin(.4 * t), .03 * np.cos(.3 * t)))
    cv = np.column_stack((np.full_like(t, .1), .02 * np.cos(.4 * t), -.009 * np.sin(.3 * t)))
    pos = np.stack((center - rel / 2, center + rel / 2), axis=1)
    vel = np.stack((cv - rv / 2, cv + rv / 2), axis=1)
    # World-frame acceleration after gravity removal. Each node has constant
    # residual bias, independent white noise, and independent random-walk bias.
    bias0 = np.array([[.012, -.008, .006], [-.009, .011, -.004]])
    walk = np.cumsum(rng.normal(0, .0002 * np.sqrt(dt), (steps, 2, 3)), axis=0)
    accel = np.diff(vel, axis=0) / dt + bias0 + walk + rng.normal(0, .02, (steps, 2, 3))
    measurements = rng.normal(0, measurement_sigma, (steps + 1, 3))
    # Relative states [position, velocity, acceleration bias], each row is XYZ.
    state = np.zeros((3, 3, 3))
    state[:, 0] = rel[0]
    state[:, 1] = rv[0]
    mean_p, mean_v = center[0].copy(), cv[0].copy()
    F = np.array([[1, dt, -.5 * dt**2], [0, 1, -dt], [0, 0, 1.]])
    G = np.array([.5 * dt**2, dt, 0])
    Q = np.outer(G, G) * (2 * .02**2)
    Q[2, 2] = 2 * .0002**2 * dt
    P = np.diag([.001**2, .005**2, .03**2])
    R = measurement_sigma**2
    errors = np.zeros((steps + 1, 3))
    absolute = np.zeros_like(errors)
    before = []
    records = []
    for i in range(1, steps + 1):
        a = accel[i - 1]
        da = a[1] - a[0]
        ma = a.mean(axis=0)
        mean_p += mean_v * dt + .5 * ma * dt**2
        mean_v += ma * dt
        for k in range(3):
            corrected = da - state[k, 2]
            state[k, 0] += state[k, 1] * dt + .5 * corrected * dt**2
            state[k, 1] += corrected * dt
        P = F @ P @ F.T + Q
        event = i % every == 0
        if event:
            before.append(np.linalg.norm(state[:, 0] - rel[i], axis=1))
            z = rel[i] + measurements[i]
            state[1, 0] = z  # Does NOT clear velocity or bias.
            gain = P[:, 0] / (P[0, 0] + R)
            state[2] += gain[:, None] * (z - state[2, 0])
            A = np.eye(3) - np.outer(gain, [1, 0, 0])
            P = A @ P @ A.T + np.outer(gain, gain) * R
        errors[i] = np.linalg.norm(state[:, 0] - rel[i], axis=1)
        for k in range(3):
            estimated = np.stack((mean_p - state[k, 0] / 2, mean_p + state[k, 0] / 2))
            absolute[i, k] = np.sqrt(np.mean(np.sum((estimated - pos[i])**2, axis=1)))
        if seed == 0:
            records.append([t[i], int(event), *rel[i], *accel[i-1].ravel(),
                            *state[:, 0].ravel(), *errors[i], *absolute[i]])
    metrics = {}
    for k, name in enumerate(METHODS):
        metrics[name] = {
            "relative_rmse_m": float(np.sqrt(np.mean(errors[:, k]**2))),
            "relative_max_m": float(max(errors[:, k].max(), np.max(before, axis=0)[k])),
            "pre_update_rmse_m": float(np.sqrt(np.mean(np.array(before)[:, k]**2))),
            "absolute_node_rmse_m": float(np.sqrt(np.mean(absolute[:, k]**2))),
        }
    return t, errors, absolute, records, metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("output/relative-reset-simulation"))
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("runs must be positive")
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    example = None
    for period in (1., 2., 5.):
        for seed in range(args.runs):
            run = simulate(seed, period)
            results.append({"period_s": period, "seed": seed, "metrics": run[-1]})
            if period == 2 and seed == 0:
                example = run
    summary = {
        "synthetic_only": True, "duration_s": 60, "sample_rate_hz": 100,
        "seeds": list(range(args.runs)), "measurement_sigma_per_axis_m": .005,
        "acceleration_noise_sigma_per_sample_m_s2": .02,
        "bias_random_walk_m_s2_per_sqrt_s": .0002,
        "constant_acceleration_bias_node_xyz_m_s2": [[.012, -.008, .006], [-.009, .011, -.004]],
        "assumptions": ["Exact initial position and velocity; synchronized clocks; world frame known",
                        "No attitude errors, magnetic disturbances, packet loss or calibration latency",
                        "Full signed XYZ relative-position measurement, NOT distance-only",
                        "2-second returns occur at nonzero relative velocity; velocity is never zeroed",
                        "1s/5s sensitivity supplies the correct vector at those times (not necessarily same return pose)",
                        "Both nodes share an unobservable common translation; no absolute fixes"],
        "runs": results, "median_metrics": {},
    }
    for period in (1., 2., 5.):
        subset = [r for r in results if r["period_s"] == period]
        summary["median_metrics"][str(period)] = {
            method: {key: float(np.median([r["metrics"][method][key] for r in subset]))
                     for key in subset[0]["metrics"][method]} for method in METHODS}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    t, errors, absolute, records, _ = example
    with (args.output / "timeseries-seed0.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time_s", "relative_fix", *[f"true_relative_{a}_m" for a in "xyz"],
                         *[f"node{n}_measured_accel_{a}_m_s2" for n in (1, 2) for a in "xyz"],
                         *[f"{m}_relative_{a}_m" for m in METHODS for a in "xyz"],
                         *[f"{m}_relative_error_m" for m in METHODS],
                         *[f"{m}_absolute_node_error_m" for m in METHODS]])
        writer.writerows(records)
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.lib.colors import HexColor
    from reportlab.graphics import renderPDF, renderSVG
    import pypdfium2
    drawing = Drawing(1000, 740)
    drawing.add(String(500, 718, "Two-node periodic relative-position fixes | SYNTHETIC DATA", textAnchor="middle", fontSize=16))
    drawing.add(String(500, 697, "60 s, 100 Hz, 2 s fixes at NONZERO velocity; 5 mm per-axis observation noise; seed=0", textAnchor="middle", fontSize=10))
    colors = [HexColor(c) for c in ["#B54D00", "#0072B2", "#007B63"]]
    labels = ["No fixes", "Position reset only", "Position + velocity/bias filter"]
    panels = [(errors, "Relative error (m), full scale", None),
              (errors, "Filtered relative error ONLY (m), expanded scale", .15),
              (absolute, "Absolute node position RMS error (m)", None)]
    for j in range(4):
        x, y = 65 + (j % 2) * 490, 410 - (j // 2) * 320
        chart = LinePlot()
        chart.x, chart.y, chart.width, chart.height = x, y, 400, 220
        if j < 3:
            values, title, limit = panels[j]
            # All 100 Hz samples retained: no smoothing or decimation.
            chart.data = [list(zip(t.tolist(), values[:, k].tolist())) for k in range(3)]
            if j == 1:
                chart.data = [chart.data[2]]
            chart.xValueAxis.valueMin, chart.xValueAxis.valueMax = 0, 60
            chart.xValueAxis.valueStep = 10
            maximum = float(values.max()) if limit is None else limit
        else:
            title = f"Pre-fix relative RMSE (m): median across {args.runs} seeds"
            chart.data = [[(p, summary["median_metrics"][str(p)][m]["pre_update_rmse_m"]) for p in (1., 2., 5.)] for m in METHODS]
            chart.xValueAxis.valueMin, chart.xValueAxis.valueMax = 0, 5
            chart.xValueAxis.valueStep = 1
            maximum = max(v for line in chart.data for _, v in line)
        chart.yValueAxis.valueMin = 0
        chart.yValueAxis.valueMax = maximum if j == 1 else maximum * 1.05
        chart.yValueAxis.labelTextFormat = lambda value: f"{value:.3g}"
        for k, color in enumerate(colors):
            chart.lines[k].strokeColor = color
            chart.lines[k].strokeWidth = 1.2
            chart.lines[k].strokeDashArray = [4, 3] if k == 0 else ([7, 2, 1, 2] if k == 1 else [])
        if j == 1:
            chart.lines[0].strokeColor = colors[2]
            chart.lines[0].strokeDashArray = []
        drawing.add(chart)
        drawing.add(String(x, y + 240, title, fontSize=10))
        drawing.add(String(x + 200, y - 32, "Fix interval (s)" if j == 3 else "Time (s)", textAnchor="middle", fontSize=10))
    for k, (label, color) in enumerate(zip(labels, colors)):
        drawing.add(String(80 + k * 300, 30, label, fillColor=color, fontSize=11))
    renderPDF.drawToFile(drawing, str(args.output / "comparison.pdf"))
    renderSVG.drawToFile(drawing, str(args.output / "comparison.svg"))
    pdf = pypdfium2.PdfDocument(str(args.output / "comparison.pdf"))
    pdf[0].render(scale=1.6).to_pil().save(args.output / "comparison.png")
    pdf.close()
    print(json.dumps(summary["median_metrics"]["2.0"], indent=2))


if __name__ == "__main__":
    main()
