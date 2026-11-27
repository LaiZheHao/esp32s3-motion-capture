import math
import unittest

from dashboard.arm_vqf import ArmExperiment, LineFramer, solve_arm
from dashboard.body_math import IDENTITY, angle_degrees, inverse, multiply


def ry(deg):
    return math.cos(math.radians(deg)/2),0,math.sin(math.radians(deg)/2),0


class ArmVQFTests(unittest.TestCase):
    def test_partial_serial_reads_do_not_become_invalid_frames(self):
        f=LineFramer()
        self.assertEqual(f.feed(b'IMU3,abc'),[])
        self.assertEqual(f.feed(b',rest\r\n[FUS'),['IMU3,abc,rest'])
        self.assertEqual(f.feed(b'ION1],1\nnext\n'),['[FUSION1],1','next'])
        with self.assertRaises(ValueError):f.feed(b'x'*1025)

    def test_known_right_angle_and_bone_lengths(self):
        s=solve_arm(IDENTITY,ry(-90))
        self.assertAlmostEqual(s['flexion_deg'],90)
        self.assertAlmostEqual(s['hinge_deg'],90)
        self.assertAlmostEqual(s['removed_rotation_deg'],0)
        self.assertAlmostEqual(math.dist(s['shoulder'],s['elbow']),.30)
        self.assertAlmostEqual(math.dist(s['elbow'],s['raw_wrist']),.26)
        for x,y in zip(s['raw_wrist'],(.26,0,-.30)):
            self.assertAlmostEqual(x,y)

    def test_constraints_remove_out_of_plane_and_limit_extension(self):
        roll=(math.cos(.3),math.sin(.3),0,0)
        s=solve_arm(IDENTITY,multiply(ry(-90),roll))
        self.assertGreater(s['removed_rotation_deg'],20)
        self.assertAlmostEqual(math.dist(s['elbow'],s['constrained_wrist']),.26)
        self.assertAlmostEqual(solve_arm(IDENTITY,ry(20))['limited_hinge_deg'],0)
        self.assertAlmostEqual(solve_arm(IDENTITY,ry(-170))['limited_hinge_deg'],150)
        self.assertTrue(solve_arm(IDENTITY,(0,1,0,0))['hinge_singular'])

    def make_engine(self):
        e=ArmExperiment(dict(upper='a',fore='b'))
        for role,dev in [('upper','a'),('fore','b')]:
            e.metadata(role,dev,'imu-slime-vqf-test','boot1')
            e.motion(role,dict(ready=True,linear_accel=[0,0,0]))
        return e

    def feed(self,e,t,q=IDENTITY,rest=True):
        for role in ['upper','fore']:
            e.fusion(role,dict(sequence=round(t*25)*4,device_us=round(t*1e6),quaternion=q,
                               gyro_bias_dps=[0,0,0],rest=rest),t)

    def calibrate(self,e):
        self.feed(e,1)
        e.begin_reference(1,[.30,.26])
        for i in range(1,33):self.feed(e,1+i*.04)
        return e.payload(2.28)

    def test_reference_interpolation_stale_and_reboot(self):
        e=self.make_engine()
        s=self.calibrate(e)
        self.assertTrue(s['calibrated'])
        self.assertIsNotNone(s['solution'])
        self.assertIsNone(e.payload(3)['solution'])
        self.assertFalse(e.payload(3)['valid'])
        e.metadata('upper','a','imu-slime-vqf-test','boot2')
        self.assertIsNone(e.reference)
        self.assertFalse(e.nodes['upper']['ready'])

    def test_stationarity_and_identity_are_required(self):
        e=self.make_engine()
        with self.assertRaises(ValueError):e.metadata('fore','a','imu-slime-vqf-test','boot1')
        with self.assertRaises(ValueError):e.metadata('upper','a','old-firmware','boot1')
        self.feed(e,1,rest=False)
        with self.assertRaises(ValueError):e.begin_reference(1,[.3,.26])
        self.feed(e,1.04)
        with self.assertRaises(ValueError):e.begin_reference(1.04,[float('nan'),.26])
        e.begin_reference(1.04,[.3,.26])
        for i in range(1,33):self.feed(e,1.04+i*.04,rest=False)
        self.assertFalse(e.payload(2.32)['calibrated'])

    def test_reset_invalidates_reference_and_frame_counts_start_on_connect(self):
        e=self.make_engine();self.calibrate(e)
        self.assertEqual(e.nodes['fore']['missing'],0)
        e.motion('fore',dict(ready=False,linear_accel=[0,0,0]))
        self.assertIsNone(e.reference)
        self.assertFalse(e.fusion('fore',dict(sequence=400),3))
        e.disconnect('upper','unplugged')
        self.assertEqual(len(e.nodes['upper']['history']),0)

    def test_independent_heading_frames_and_mounts_share_a_world(self):
        e=self.make_engine()
        rz=lambda d:(math.cos(math.radians(d)/2),0,0,math.sin(math.radians(d)/2))
        refs={'upper':rz(30),'fore':multiply(rz(-40),(.7071067811865476,.7071067811865476,0,0))}
        headings={'upper':rz(-30),'fore':rz(40)}
        def frame(t,bones=None):
            for role in ['upper','fore']:
                q=refs[role] if bones is None else multiply(multiply(multiply(inverse(headings[role]),bones[role]),headings[role]),refs[role])
                e.fusion(role,dict(sequence=round(t*25)*4,device_us=round(t*1e6),
                                   quaternion=q,gyro_bias_dps=[0,0,0],rest=True),t)
        frame(1);e.begin_reference(1,[.30,.26])
        for i in range(1,33):frame(1+i*.04)
        self.assertTrue(e.payload(2.28)['calibrated'])
        bones={'upper':ry(-20),'fore':ry(-110)}
        for i in range(33,40):frame(1+i*.04,bones)
        s=e.payload(2.56)['solution']
        self.assertIsNotNone(s)
        self.assertAlmostEqual(s['flexion_deg'],90)
        self.assertAlmostEqual(angle_degrees(s['relative_quaternion'],ry(-90)),0)
