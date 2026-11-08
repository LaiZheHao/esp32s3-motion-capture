from dataclasses import replace
from math import cos, degrees, pi, radians, sin
import unittest

from dashboard.body_math import inverse, rotate
from dashboard.fusion import euler_quaternion
from dashboard.models import SensorSample
from dashboard.segment_displacement import (
    FACES, GRAVITY, MotionPoint, compare_reference, fit_accelerometer, measure_segment, whole_second_rows,
)


BIAS = (.02, -.03, .01)
SCALE = (1.02, .98, 1.04)
GYRO_BIAS = (.25, -.35, .5)


def sample(index, acceleration, pitch_rate=0.):
    return SensorSample(
        accel=tuple(v * s + b for v, s, b in zip(acceleration, SCALE, BIAS)),
        gyro=(GYRO_BIAS[0], GYRO_BIAS[1] + degrees(pitch_rate), GYRO_BIAS[2]),
        mag=(300., 20., 50.), temperature=25., aux_temperature=25.,
        node_id="board-1", boot_id="boot-1",
        sequence=(2**32 - 150 + index) % 2**32,
        device_us=(2**32 - 1_500_000 + 10_000 * index) % 2**32,
    )


def stationary_faces():
    return {
        face: [sample(i, tuple(sign if axis == face[1] else 0. for axis in "XYZ"))
               for i in range(101)]
        for face, sign in zip(FACES, (1., -1.) * 3)
    }


def motion(displacement, pitch=0., drift=0., movement_ticks=200):
    samples = []
    duration = movement_ticks / 100
    for index in range(movement_ticks + 201):
        u = min(1., max(0., (index - 100) / movement_ticks))
        pitch_angle = pitch * (u - sin(2 * pi * u) / (2 * pi))
        pitch_rate = pitch * (1 - cos(2 * pi * u)) / duration
        acceleration = [v * (2 * pi / duration**2) * sin(2 * pi * u) / GRAVITY for v in displacement]
        if 0 < u < 1:
            acceleration[0] += drift / GRAVITY
        acceleration[2] += 1
        raw_frame = rotate(acceleration, inverse(euler_quaternion(0., pitch_angle, 0.)))
        samples.append(sample(index, raw_frame, pitch_rate))
    return samples


class SegmentDisplacementTests(unittest.TestCase):
    def setUp(self):
        self.calibration = fit_accelerometer(stationary_faces())

    def test_six_face_scale_and_bias_and_rejects_mislabeled_face(self):
        for found, expected in zip(self.calibration, (BIAS, SCALE)):
            for value, truth in zip(found, expected):
                self.assertAlmostEqual(value, truth)
        faces = stationary_faces()
        faces["+X"] = faces["-X"]
        with self.assertRaisesRegex(ValueError, "朝向不符"):
            fit_accelerometer(faces)

    def test_measures_three_axes_while_tilting_across_timestamp_wrap(self):
        reference = (.3, -.2, .25)
        result = measure_segment(motion(reference, pitch=.6), self.calibration)
        error = compare_reference(result["displacement_m"], reference)
        self.assertTrue(error["within_target"])
        self.assertLess(error["endpoint_error_m"], .001)

    def test_endpoint_constraint_corrects_previous_drift(self):
        reference = (.5, 0., 0.)
        result = measure_segment(motion(reference, drift=.15), self.calibration)
        self.assertAlmostEqual(result["end_velocity_before_constraint_m_s"][0], .2985)
        self.assertGreater(result["unconstrained_displacement_m"][0], .75)
        self.assertTrue(compare_reference(result["displacement_m"], reference)["within_target"])

    def test_rotation_in_place_uses_absolute_error_only(self):
        reference = (0., 0., 0.)
        result = measure_segment(motion(reference, pitch=.6), self.calibration)
        error = compare_reference(result["displacement_m"], reference)
        self.assertLess(error["endpoint_error_m"], .001)
        self.assertIsNone(error["within_target"])

    def test_missing_frame_restart_or_unstable_finish_rejects_measurement(self):
        samples = motion((.5, 0., 0.))
        with self.assertRaisesRegex(ValueError, "不连续"):
            measure_segment(samples[:200] + samples[201:], self.calibration)
        restarted = samples[:200] + [replace(s, boot_id="boot-2") for s in samples[200:]]
        with self.assertRaisesRegex(ValueError, "同一次启动"):
            measure_segment(restarted, self.calibration)
        samples[-5] = replace(samples[-5], gyro=(0., 15., 0.))
        with self.assertRaisesRegex(ValueError, "终点未通过静置检查"):
            measure_segment(samples, self.calibration)

    def test_two_percent_uses_vector_error_and_inclusive_boundary(self):
        self.assertTrue(compare_reference((.51, 0., 0.), (.5, 0., 0.))["within_target"])
        self.assertFalse(compare_reference((.5, .011, 0.), (.5, 0., 0.))["within_target"])

    def test_2_4_seconds_exports_only_whole_seconds_and_keeps_full_endpoint(self):
        reference = (.5, -.2, .1)
        result = measure_segment(motion(reference, pitch=.6, movement_ticks=240), self.calibration)
        rows = list(whole_second_rows(result["trajectory"]))
        self.assertEqual([row[0] for row in rows], [0, 1, 2])
        self.assertEqual(rows[0][3:], (0.,) * 7)
        self.assertAlmostEqual(rows[0][1], 0.)
        self.assertAlmostEqual(rows[0][2], 0.)
        self.assertEqual(result["duration_s"], 2.4)
        self.assertLess(rows[1][5], 0.)
        self.assertLess(rows[1][8], 0.)
        expected_speed = reference[0] * (1 - cos(2 * pi / 2.4)) / 2.4
        self.assertAlmostEqual(rows[1][4], expected_speed, delta=.0002)
        self.assertNotAlmostEqual(rows[-1][7], result["displacement_m"][0])
        self.assertTrue(compare_reference(result["displacement_m"], reference)["within_target"])

    def test_whole_second_interpolation_uses_instantaneous_velocity_and_shortest_yaw(self):
        yaw = lambda angle: euler_quaternion(0., 0., radians(angle))
        trajectory = [
            MotionPoint(0., yaw(0), (0., 0., 0.), (0., 0., 0.)),
            MotionPoint(.98, yaw(179), (1., 0., 0.), (.49, 0., 0.)),
            MotionPoint(1.02, yaw(-179), (3., 0., 0.), (.57, 0., 0.)),
        ]
        row = list(whole_second_rows(trajectory))[1]
        self.assertAlmostEqual(abs(row[3]), 180.)
        self.assertAlmostEqual(row[4], 2.)
        self.assertAlmostEqual(row[7], .52)
