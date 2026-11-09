"""Connection loss excludes offline gaps but preserves lifetime evidence."""
from dataclasses import replace
import unittest

from dashboard.body_engine import BodyEngine
from dashboard.models import SensorSample


def frame(sequence, now=100., boot="boot1", device="one"):
    return SensorSample((0.,0.,1.), (0.,0.,0.), (300.,0.,80.), 25.,0.,
                        received_monotonic=now, received_unix=now+100000,
                        node_id=device, sequence=sequence,
                        device_us=(sequence*10000) % 2**32 if sequence is not None else None,
                        boot_id=boot, protocol_version="IMU3")


class ConnectionQualityTests(unittest.TestCase):
    def test_first_frame_and_reconnect_exclude_offline_sequence_jump(self):
        engine=BodyEngine()
        for seq in (9000,9001,9004):
            engine.ingest(frame(seq,100+(seq-9000)*.01),"wifi")
        node=engine.devices["one"]
        quality=node.snapshot(100.04)["quality"]
        self.assertEqual(quality["connection"]["first_sequence"],9000)
        self.assertEqual(quality["connection"]["missing_frames"],2)
        self.assertAlmostEqual(quality["connection"]["loss_percent"],40.)
        node.stability.calibrated=True
        node.stability.bias=(.02,0.,0.)
        engine.disconnect_endpoint("wifi")
        engine.ingest(frame(50000,120.),"wifi")
        quality=node.snapshot(120.)["quality"]
        self.assertGreater(quality["missing_frames"],40000)
        self.assertGreater(quality["loss_percent"],99.)
        self.assertEqual(quality["connection"]["valid_frames"],1)
        self.assertEqual(quality["connection"]["missing_frames"],0)
        self.assertEqual(quality["connection"]["loss_percent"],0.)
        self.assertEqual(quality["connection"]["first_sequence"],50000)
        self.assertTrue(node.stability.calibrated)
        self.assertEqual(node.stability.bias,(.02,0.,0.))
        engine.ingest(frame(50003,120.03),"wifi")
        quality=node.snapshot(120.03)["quality"]
        self.assertEqual(quality["connection"]["missing_frames"],2)
        self.assertEqual(quality["connection"]["loss_percent"],50.)

    def test_restart_and_sequence_wrap(self):
        engine=BodyEngine()
        engine.ingest(frame(2**32-1),"wifi")
        engine.ingest(frame(0,100.01),"wifi")
        node=engine.devices["one"]
        self.assertEqual(node.snapshot(100.01)["quality"]["connection"]["valid_frames"],2)
        self.assertEqual(node.missing_frames,0)
        engine.ingest(frame(3,100.04),"wifi")
        self.assertEqual(node.missing_frames,2)
        engine.ingest(frame(0,101.,boot="boot2"),"wifi")
        quality=node.snapshot(101.)["quality"]
        self.assertEqual(quality["connection"]["valid_frames"],1)
        self.assertEqual(quality["connection"]["loss_percent"],0.)
        self.assertEqual(quality["missing_frames"],2)
        self.assertEqual(quality["restarts"],1)

    def test_source_selection_duplicate_isolation_and_device_independence(self):
        engine=BodyEngine()
        engine.ingest(frame(100),"wifi")
        engine.ingest(frame(102,100.02),"wifi")
        engine.ingest(frame(102,100.02),"usb")
        engine.ingest(frame(10,100.02,device="other"),"other-wifi")
        node=engine.devices["one"]
        self.assertEqual(node.snapshot(100.02)["quality"]["connection"]["missing_frames"],1)
        engine.choose_source("one","usb")
        self.assertFalse(node.snapshot(100.02)["quality"]["connection"]["has_samples"])
        engine.ingest(frame(70000,100.03),"usb")
        self.assertEqual(node.snapshot(100.03)["quality"]["connection"]["loss_percent"],0.)
        self.assertEqual(node.missing_frames,1)
        self.assertEqual(engine.devices["other"].snapshot(100.03)["quality"]["connection"]["first_sequence"],10)

    def test_invalid_initial_frame_and_legacy_unknown_sequence(self):
        engine=BodyEngine()
        engine.ingest(replace(frame(1),accel=(float("nan"),0.,1.)),"wifi")
        node=engine.devices["one"]
        self.assertFalse(node.snapshot(100.)["quality"]["connection"]["has_samples"])
        self.assertIsNone(node.snapshot(100.)["quality"]["connection"]["loss_percent"])
        engine.ingest(frame(2,100.01),"wifi")
        self.assertEqual(node.snapshot(100.01)["quality"]["connection"]["loss_percent"],0.)
        self.assertEqual(node.invalid_frames,1)
        engine.ingest(frame(None,100.02,device="legacy"),"legacy")
        self.assertIsNone(engine.devices["legacy"].snapshot(100.02)["quality"]["connection"]["loss_percent"])
