"""Offline end-to-end checks: no COM ports or non-loopback network endpoints."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import tempfile
from time import monotonic
import unittest
from unittest.mock import patch

from dashboard.body_runtime import BodyRuntime
from dashboard.body_recording import catalog
from dashboard.models import SensorSample


class BodyRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.runtime = BodyRuntime(recording_dir=Path(self.folder.name))

    async def asyncTearDown(self):
        await self.runtime.close()
        self.folder.cleanup()

    async def test_three_sources_and_saved_replay_are_exclusive(self):
        runtime = self.runtime
        await runtime.command({"action":"simulate", "path":"pose", "count":1,
                               "slot":"left_upper_arm", "angle_deg":45})
        await asyncio.sleep(.03)
        await runtime.tick()
        state = runtime.payload()
        self.assertEqual(len(state["slots"]), 14)
        self.assertEqual(len(state["devices"]), 1)
        self.assertEqual(state["live_device_count"], 0)
        await runtime.command({"action":"record_start"})
        await runtime.tick()
        await runtime.command({"action":"bind", "device_id":state["devices"][0]["device_id"], "body_slot":"head"})
        self.assertIn("停止", runtime.message)
        await runtime.command({"action":"replay_open", "session":runtime.recorder.session})
        self.assertEqual(runtime.mode, "LIVE")
        await asyncio.sleep(.01)
        await runtime.tick()
        await runtime.command({"action":"record_stop"})
        session = runtime.recorder.session
        self.assertEqual(catalog(runtime.recorder.root)[0]["status"], "complete")
        await runtime.command({"action":"replay_open", "session":session})
        self.assertEqual(runtime.mode, "REPLAY")
        saved = runtime.payload()["body_frame"]
        # A newer live pose exists and is accepted while playback is active,
        # but cannot write the displayed body frame.
        runtime.engine.ingest_pose("new-device", "pelvis", (0.,1.,0.,0.), endpoint_id="other")
        self.assertEqual(runtime.payload()["body_frame"], saved)
        await runtime.command({"action":"record_start"})
        self.assertFalse(runtime.recorder.active)
        await runtime.command({"action":"initialize", "stage":"begin"})
        self.assertIn("回放", runtime.message)
        await runtime.command({"action":"replay_close"})
        self.assertEqual(runtime.mode, "LIVE")
        self.assertNotEqual(runtime.payload()["body_frame"], saved)

    async def test_raw_sensor_path_records_every_sample_and_no_implicit_right_hand(self):
        runtime = self.runtime
        raw = SensorSample((0.,0.,1.),(0.,0.,0.),(300.,0.,100.),25.,0.,
                           node_id="boardA", sequence=0, device_us=0, protocol_version="IMU2")
        runtime.consume(raw, "usb")
        state = runtime.payload()
        self.assertIsNone(state["devices"][0]["body_slot"])
        self.assertFalse(any(s.get("measured") for s in state["body_frame"]["segments"]))
        await runtime.command({"action":"bind", "device_id":"boardA", "body_slot":"left_hand", "override":True})
        await runtime.command({"action":"record_start"})
        for seq in range(1, 101):
            runtime.consume(replace(raw, sequence=seq, device_us=seq*10000,
                                    received_monotonic=monotonic()+seq*.01), "usb")
        await runtime.tick()
        await runtime.command({"action":"record_stop"})
        folder = runtime.recorder.folder
        rows = [json.loads(line) for line in (folder/"samples.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 100)
        self.assertIn("raw", rows[-1]["data"])
        self.assertIn("quaternion", rows[-1]["data"])
        self.assertEqual(rows[-1]["data"]["body_slot"], "left_hand")
        self.assertFalse(runtime.motions)  # Binding/initialization never starts position integration.

    async def test_single_uninitialized_node_records_and_replays_board_pose(self):
        runtime=self.runtime
        now=monotonic()
        raw=SensorSample((0.,0.,1.),(0.,0.,30.),(300.,0.,80.),25.,0.,
                         node_id="single-offline-fixture",sequence=0,device_us=0,
                         received_monotonic=now,boot_id="single-boot",sensor_flags=1,
                         body_slot="right_forearm",protocol_version="IMU3")
        runtime.consume(raw,"offline",source="simulation_sensor")
        await runtime.command({"action":"record_start"})
        for seq in range(1,21):
            runtime.consume(replace(raw,sequence=seq,device_us=seq*10000,
                                    received_monotonic=now+seq*.01),"offline",source="simulation_sensor")
            if seq in (5,10,20):
                # Windows may give several rapid ticks the same clock value.
                # Distinct saved times make seeking a specific frame explicit.
                with patch("dashboard.body_recording.monotonic",return_value=runtime.recorder.started+seq*.01):
                    await runtime.tick()
        await runtime.command({"action":"record_stop"})
        folder=runtime.recorder.folder
        samples=[json.loads(line) for line in (folder/"samples.jsonl").read_text(encoding="utf-8").splitlines()]
        frames=[json.loads(line) for line in (folder/"body_frames.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(samples),20)
        self.assertEqual(len(frames),3)
        saved=frames[1]["data"]["devices"][0]
        self.assertFalse(saved["initialized"])
        self.assertEqual(len(frames[1]["data"]["devices"]),1)
        self.assertFalse(any(segment["measured"] for segment in frames[1]["data"]["body_frame"]["segments"]))
        self.assertNotEqual(frames[0]["data"]["devices"][0]["quaternion"],frames[-1]["data"]["devices"][0]["quaternion"])
        await runtime.command({"action":"replay_open","session":runtime.recorder.session})
        await runtime.command({"action":"replay_seek","time_s":frames[1]["time_s"]})
        self.assertEqual(runtime.payload()["devices"][0]["quaternion"],saved["quaternion"])
        runtime.consume(replace(raw,sequence=21,device_us=210000,received_monotonic=now+.21),"offline",source="simulation_sensor")
        self.assertEqual(runtime.payload()["devices"][0]["quaternion"],saved["quaternion"])
        await runtime.command({"action":"replay_close"})
        self.assertNotEqual(runtime.payload()["devices"][0]["quaternion"],saved["quaternion"])

    async def test_loopback_tcp_old_stream_and_invalid_frames(self):
        runtime = self.runtime
        release = asyncio.Event()
        peers = set()
        async def device(reader, writer):
            task = asyncio.current_task()
            peers.add(task)
            try:
                writer.write(b"IMU2,loopbackA,1,10000,3,0,0,1,0,0,0,25,300,0,100,0\nmalformed\n")
                await writer.drain()
                await release.wait()
            finally:
                writer.close()
                await writer.wait_closed()
                peers.discard(task)
        server = await asyncio.start_server(device,"127.0.0.1",0)
        try:
            await runtime.command({"action":"connect", "endpoint_id":"mock", "transport":"wifi",
                                   "host":"127.0.0.1", "tcp_port":server.sockets[0].getsockname()[1]})
            for _ in range(100):
                if runtime.payload()["devices"]:
                    break
                await asyncio.sleep(.01)
            state = runtime.payload()
            self.assertEqual(state["devices"][0]["device_id"],"loopbackA")
            self.assertEqual(state["endpoints"][0]["invalid_frames"],1)
            await runtime.command({"action":"disconnect", "endpoint_id":"mock"})
            self.assertEqual(runtime.endpoints["mock"]["status"], "closed")
        finally:
            release.set()
            server.close()
            await server.wait_closed()
            if peers:
                await asyncio.gather(*peers)

    async def test_fixed_root_does_not_depend_on_position_source(self):
        runtime = self.runtime
        before = runtime.payload()["body_frame"]
        await runtime.command({"action":"position", "source":"simulated", "position":[2,1,0]})
        after = runtime.payload()
        self.assertEqual(before["segments"], after["body_frame"]["segments"])
        self.assertEqual(after["position"]["position"], [2,1,0])
        self.assertEqual(after["position"]["source"], "simulated")

    async def test_pose_demo_cannot_overwrite_explicit_binding_or_reinitialize_conflict(self):
        runtime = self.runtime
        await runtime.command({"action":"simulate", "path":"pose", "count":3, "slot":"left_forearm"})
        await asyncio.sleep(.03)
        device_id = "sim-pose-left_forearm"
        await runtime.command({"action":"bind", "device_id":device_id, "body_slot":"head", "override":True})
        await asyncio.sleep(.03)
        state = runtime.payload()
        head = next(s for s in state["slots"] if s["id"]=="head")
        self.assertTrue(head["conflict"])
        self.assertFalse(head["measured"])
        await asyncio.sleep(.03)
        self.assertTrue(next(s for s in runtime.payload()["slots"] if s["id"]=="head")["conflict"])
        self.assertFalse(runtime.engine.devices[device_id].initialized)

    async def test_fourteen_simulated_devices_are_independent_and_mode_reset_is_clean(self):
        runtime = self.runtime
        await runtime.command({"action":"simulate", "path":"pose", "count":14, "slot":"left_upper_arm"})
        await asyncio.sleep(.04)
        state = runtime.payload()
        self.assertEqual(sum(d["valid"] for d in state["devices"]), 14)
        self.assertEqual(sum(s["measured"] for s in state["slots"]), 14)
        self.assertEqual(state["live_device_count"], 0)
        await runtime.command({"action":"simulate", "path":"sensor", "count":3, "slot":"left_forearm"})
        await asyncio.sleep(.04)
        state = runtime.payload()
        self.assertEqual(len(state["devices"]), 3)
        self.assertEqual(sum(d["valid"] for d in state["devices"]), 3)
        self.assertFalse(any(s["conflict"] for s in state["slots"]))
        self.assertFalse(any(s["measured"] for s in state["slots"]))
        await runtime.command({"action":"initialize", "stage":"begin"})
        self.assertEqual(runtime.payload()["initialization"]["status"], "prepared")
        await asyncio.sleep(.05)
        self.assertFalse(any(s["measured"] for s in runtime.payload()["slots"]))
        await runtime.command({"action":"initialize", "stage":"confirm"})
        await asyncio.sleep(1.12)
        state = runtime.payload()
        self.assertEqual(state["initialization"]["status"], "complete")
        self.assertEqual(sum(s["measured"] for s in state["slots"]), 3)
        device = next(d for d in state["devices"] if d["body_slot"]=="left_forearm")
        calibration_id = device["calibration_id"]
        await runtime.command({"action":"simulate", "path":"sensor", "count":3, "slot":"left_forearm", "angle_deg":90})
        await asyncio.sleep(.7)
        device = next(d for d in runtime.payload()["devices"] if d["body_slot"]=="left_forearm")
        self.assertEqual(device["calibration_id"], calibration_id)
        self.assertTrue(device["initialized"])
        self.assertGreater(abs(device["gyro"][0]), 20)


if __name__ == "__main__":
    unittest.main()
