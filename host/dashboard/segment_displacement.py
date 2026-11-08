"""Stop-to-stop displacement from one device's raw IMU samples."""
from bisect import bisect_left, bisect_right
from math import atan2, cos, degrees, hypot, isfinite, radians, sin
from statistics import mean
from typing import NamedTuple

from .body_math import IDENTITY, multiply, rotate, slerp
from .fusion import euler_degrees, euler_quaternion, normalize
from .kinematics import Vector, sub


GRAVITY = 9.80665
FACES = ("+X", "-X", "+Y", "-Y", "+Z", "-Z")
TARGET_ERROR = .02
MOTION_CSV_NAME = "single_node_motion.csv"


class MotionPoint(NamedTuple):
    time_s: float
    attitude: tuple[float, float, float, float]
    velocity: Vector
    position: Vector


def sample_times(samples):
    if not samples:
        raise ValueError("没有可用 IMU 样本")
    identity = {(sample.node_id, sample.boot_id) for sample in samples}
    if len(identity) != 1:
        raise ValueError("同一段必须来自同一设备、同一次启动")
    for sample in samples:
        if (not sample.sensor_flags & 1
                or len(sample.accel) != 3 or len(sample.gyro) != 3
                or any(not isfinite(v) for v in (*sample.accel, *sample.gyro))
                or any(type(v) is not int or not 0 <= v < 2**32
                       for v in (sample.device_us, sample.sequence))):
            raise ValueError("需要有效六轴样本、设备采样时钟和帧序号")
    times = [0.]
    elapsed_us = 0
    for previous, current in zip(samples, samples[1:]):
        delta_us = (current.device_us - previous.device_us) % 2**32
        if (current.sequence - previous.sequence) % 2**32 != 1 or not 1000 <= delta_us <= 80000:
            raise ValueError(f"采样不连续，帧序号 {previous.sequence} → {current.sequence}")
        elapsed_us += delta_us
        times.append(elapsed_us / 1_000_000)
    return times


def _static_means(accel, gyro, label):
    if len(accel) < 12:
        raise ValueError(f"{label}的静置样本太少")
    gravity = tuple(map(mean, zip(*accel)))
    bias = tuple(map(mean, zip(*gyro)))
    if (not .8 <= hypot(*gravity) <= 1.2 or hypot(*bias) > 5
            or max(hypot(*sub(v, gravity)) for v in accel) > .025
            or max(hypot(*sub(v, bias)) for v in gyro) > 1.5):
        raise ValueError(f"{label}未通过静置检查，请确认板卡完全停稳")
    return gravity, bias


def fit_accelerometer(faces):
    means = {}
    for face in FACES:
        axis = "XYZ".index(face[1])
        samples = faces[face]
        if sample_times(samples)[-1] < .8:
            raise ValueError(f"{face}静置记录需至少 0.8 秒")
        vector, _ = _static_means([s.accel for s in samples], [s.gyro for s in samples], face)
        expected = 1 if face[0] == "+" else -1
        if expected * vector[axis] < .88 or any(abs(v) > .14 for i, v in enumerate(vector) if i != axis):
            raise ValueError(f"{face}朝向不符，请确认原始传感器轴竖直朝上")
        means[face] = vector
    bias = tuple((means["+" + axis][i] + means["-" + axis][i]) / 2 for i, axis in enumerate("XYZ"))
    scale = tuple((means["+" + axis][i] - means["-" + axis][i]) / 2 for i, axis in enumerate("XYZ"))
    if any(abs(b) > .1 for b in bias) or any(not .90 <= s <= 1.10 for s in scale):
        raise ValueError("加速度零偏或比例超出首轮标定范围")
    return bias, scale


def _integrate(acceleration, times, bias):
    velocity = position = (0., 0., 0.)
    states = [(velocity, position)]
    for a, b, t0, t1 in zip(acceleration, acceleration[1:], times, times[1:]):
        dt = t1 - t0
        next_velocity = tuple(v + ((x + y) / 2 - e) * dt for v, x, y, e in zip(velocity, a, b, bias))
        position = tuple(p + (v + w) * dt / 2 for p, v, w in zip(position, velocity, next_velocity))
        velocity = next_velocity
        states.append((velocity, position))
    return states


def whole_second_rows(trajectory):
    times = [point.time_s for point in trajectory]
    for second in range(int(times[-1]) + 1):
        index = bisect_left(times, second)
        right = trajectory[index]
        if right.time_s == second:
            attitude, velocity, position = right.attitude, right.velocity, right.position
        else:
            left = trajectory[index - 1]
            elapsed = second - left.time_s
            fraction = elapsed / (right.time_s - left.time_s)
            attitude = slerp(left.attitude, right.attitude, fraction)
            velocity = tuple(a + (b - a) * fraction for a, b in zip(left.velocity, right.velocity))
            position = tuple(p + (a + b) * elapsed / 2 for p, a, b in zip(left.position, left.velocity, velocity))
        yield second, *euler_degrees(attitude), *velocity, *position


def measure_segment(samples, calibration, start_still_s=1., end_still_s=1.):
    times = sample_times(samples)
    if not all(.5 <= value <= 5 for value in (start_still_s, end_still_s)):
        raise ValueError("起终点静置窗应为 0.5–5 秒")
    first = bisect_right(times, start_still_s) - 1
    # Compare the rest boundary below the device clock's one-microsecond resolution.
    last = bisect_left(times, times[-1] - end_still_s - 1e-9)
    if last <= first:
        raise ValueError("起终点静置窗重叠，无法划分动作")
    start_us = samples[first].device_us
    segment_times = [(sample.device_us - start_us) % 2**32 / 1_000_000
                     for sample in samples[first:last + 1]]
    duration = segment_times[-1]
    if not .25 <= duration <= 5.:
        raise ValueError("请保留两端静置窗，窗间片段需为 0.25–5 秒")
    bias, scale = calibration
    accel = [tuple((v - b) / s for v, b, s in zip(sample.accel, bias, scale)) for sample in samples]
    gyro = [sample.gyro for sample in samples]
    start_gravity, start_bias = _static_means(accel[:first + 1], gyro[:first + 1], "起点")
    end_gravity, end_bias = _static_means(accel[last:], gyro[last:], "终点")
    if any(not .97 <= hypot(*gravity) <= 1.03 for gravity in (start_gravity, end_gravity)):
        raise ValueError("静置重力模长偏离 1 g，请复查加速度标定")
    if hypot(*sub(end_bias, start_bias)) > .5:
        raise ValueError("起终点陀螺零偏变化过大")
    x, y, z = start_gravity
    if z / hypot(x, y, z) < .95:
        raise ValueError("起点需以原始 +Z 轴近似竖直朝上，并对齐板卡 +X 与实验 +X")
    attitudes = [euler_quaternion(atan2(y, z), atan2(-x, hypot(y, z)), 0.)]
    for i in range(first, last):
        dt = times[i + 1] - times[i]
        alpha = (times[i] - times[first] + dt / 2) / duration
        rotation = tuple(radians((v + w) / 2 - (b + alpha * (e - b))) * dt
                         for v, w, b, e in zip(gyro[i], gyro[i + 1], start_bias, end_bias))
        angle = hypot(*rotation)
        if angle:
            gain = sin(angle / 2) / angle
            attitudes.append(multiply(attitudes[-1], (cos(angle / 2), *(v * gain for v in rotation))))
        else:
            attitudes.append(attitudes[-1])

    # Correct accumulated tilt using only known rest windows. Gravity gives no yaw observation.
    x, y, z = rotate(end_gravity, attitudes[-1])
    tilt_error = degrees(atan2(hypot(x, y), z))
    if tilt_error > 5:
        raise ValueError("终点预测重力偏离竖直超过 5°，请检查标定和佩戴固定")
    tilt = normalize((hypot(x, y, z) + z, y, -x, 0.))
    acceleration = []
    corrected_attitudes = []
    for t, value, attitude in zip(segment_times, accel[first:last + 1], attitudes):
        corrected = multiply(slerp(IDENTITY, tilt, t / duration), attitude)
        corrected_attitudes.append(corrected)
        world = rotate(value, corrected)
        acceleration.append(tuple(GRAVITY * v for v in sub(world, (0., 0., 1.))))
    residual, uncorrected = _integrate(acceleration, segment_times, (0., 0., 0.))[-1]
    acceleration_bias = tuple(v / duration for v in residual)
    trajectory = [
        MotionPoint(t, attitude, velocity, position)
        for t, attitude, (velocity, position) in zip(
            segment_times, corrected_attitudes, _integrate(acceleration, segment_times, acceleration_bias)
        )
    ]
    displacement = trajectory[-1].position
    return {
        "algorithm": "stop-to-stop/1",
        "displacement_m": displacement,
        "distance_m": hypot(*displacement),
        "unconstrained_displacement_m": uncorrected,
        "end_velocity_before_constraint_m_s": residual,
        "mean_acceleration_correction_m_s2": acceleration_bias,
        "end_tilt_correction_deg": tilt_error,
        "segment_start_s": times[first],
        "segment_end_s": times[last],
        "duration_s": duration,
        "sample_count": len(segment_times),
        "trajectory": trajectory,
    }


def compare_reference(displacement, reference):
    error = hypot(*sub(displacement, reference))
    distance = hypot(*reference)
    relative = error / distance if distance else None
    return {
        "displacement_m": reference,
        "endpoint_error_m": error,
        "relative_error": relative,
        "target_relative_error": TARGET_ERROR,
        "within_target": relative <= TARGET_ERROR + 1e-12 if relative is not None else None,
    }
