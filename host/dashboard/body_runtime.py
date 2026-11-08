"""Unified transport, body pipeline and exclusive live/replay source for port 8000."""
from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
import json
import math
from pathlib import Path
from datetime import datetime
from uuid import uuid4
import re
from time import monotonic, time

from .body_engine import BodyEngine
from .body_recording import BodyRecorder, BodyReplay, DEFAULT_ROOT
from .coordinates import CoordinateSettings
from .fusion import euler_degrees, euler_quaternion
from .models import SensorSample
from .motion import DisplacementEstimator
from .protocol import CurrentCsvProtocol, FrameError
from .serial_transport import SerialTransport
from .tcp_transport import TcpTransport
from . import magnetometer
from . import session_library


class BodyRuntime:
    def __init__(self, recording_dir=DEFAULT_ROOT, engine=None):
        self.engine = engine or BodyEngine()
        self.recorder = BodyRecorder(recording_dir)
        self.replay = BodyReplay(recording_dir)
        self.protocol = CurrentCsvProtocol()
        self.mode = "LIVE"
        self.epoch = 0
        self.endpoints = {}
        self.clients = set()
        self.selected_device_id = None
        self.message = "等待手动连接设备；先确认端口与设备身份"
        self.command_result = None
        self.position = {"source": "off", "position": [0., 0., 0.], "experimental": False}
        self.motions = {}
        self._task = self._simulation_task = None
        self._lock = asyncio.Lock()
        self._last_state = None
        self._sim_generation = 0
        self._simulation_signature = None
        self._simulation_angle = 0.
        self._raw_by_device = {}
        self._direction_demo = None
        self._direction_saved_status = None
        self._direction_save_tasks = set()

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._heartbeat())

    async def close(self):
        for task in (self._task, self._simulation_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._task = self._simulation_task = None
        for endpoint_id in tuple(self.endpoints):
            await self.disconnect(endpoint_id)
        await asyncio.to_thread(self.recorder.stop)
        if self._direction_save_tasks:
            await asyncio.gather(*tuple(self._direction_save_tasks))
        self.replay.close()

    async def _heartbeat(self):
        while True:
            started = monotonic()
            await self.tick()
            await asyncio.sleep(max(.001, 1/30 - (monotonic()-started)))

    async def tick(self):
        state = self.payload()
        if self.mode == "LIVE":
            self.recorder.append_body_frame({k: state[k] for k in
                ("body_frame", "devices", "slots", "selected_device_id", "selected_node", "position", "config", "attitude_config", "initialization", "direction_calibration")})
        self._last_state = state
        if self.recorder.error:
            self.message = self.recorder.error
            async with self._lock:
                if self.recorder.error and self.recorder.busy:
                    await asyncio.to_thread(self.recorder.stop)
        if self.clients:
            payload = json.dumps(state, ensure_ascii=False, allow_nan=False)
            async def send(client):
                try:
                    await asyncio.wait_for(client.send_text(payload), .2)
                except Exception:
                    self.clients.discard(client)
            await asyncio.gather(*(send(c) for c in tuple(self.clients)))

    def _event(self, kind, **fields):
        self.recorder.append_event({"type": kind, "host_monotonic": monotonic(), "host_unix": time(), **fields})

    def _drain_events(self):
        for event in self.engine.pop_events():
            self.recorder.append_event(event)
            if event.get("type") in ("direction_calibration_failed", "direction_calibration_invalidated", "direction_neutral_accepted", "direction_candidate"):
                self._save_direction_evidence()
            if event.get("type") in ("device_restart", "inferred_restart", "clock_reference_reset", "reference_invalidated", "binding_changed", "reported_slot_changed", "source_changed", "source_selected", "device_config_changed", "coordinates_changed", "processing_changed", "magnetic_calibration_changed", "bias_calibration_complete", "invalid_fusion"):
                motion = self.motions.get(event.get("device_id"))
                if motion:
                    motion.reset()

    def payload(self):
        live = self.engine.snapshot()
        self._drain_events()
        live["position"] = dict(self.position)
        if self.position["source"] == "experimental":
            motion = self.motions.get(self.position.get("device_id"))
            if motion:
                live["position"]["position"] = list(motion.position)
        devices = live.get("devices", [])
        if isinstance(devices, dict):
            devices = list(devices.values())
            live["devices"] = devices
        if self.selected_device_id is None and devices:
            self.selected_device_id = devices[0]["device_id"]
        selected = next((d for d in devices if d["device_id"] == self.selected_device_id), None)
        live["selected_device_id"] = self.selected_device_id
        live["selected_node"] = selected
        if selected and self.selected_device_id in self.motions:
            selected["motion"] = self.motions[self.selected_device_id].payload(CoordinateSettings(), (1.,0.,0.,0.))
        state = live
        if self.mode == "REPLAY":
            try:
                saved = self.replay.advance()
            except (ValueError, OSError, KeyError) as exc:
                self.replay.close()
                self.mode = "LIVE"
                self.epoch += 1
                self.message = f"回放文件损坏，已停止回放并返回实时：{exc}"
                saved = None
            if saved:
                state = saved
                selection = next((d for d in state.get("devices", []) if d["device_id"] == self.selected_device_id), None)
                if selection:
                    state["selected_device_id"], state["selected_node"] = self.selected_device_id, selection
        return {**state, "type": "body_state", "mode": self.mode, "epoch": self.epoch,
                "timestamp": time(), "endpoints": [{k:v for k,v in e.items() if k not in ("transport_object", "generation", "reconnect_task")} for e in self.endpoints.values()],
                "recording": self.recorder.payload(), "replay": self.replay.payload(), "message": self.message,
                "command_result": self.command_result,
                "live_device_count": sum(d.get("source") == "real" and d.get("valid", False) for d in devices)}

    def _save_direction_evidence(self):
        """Durable calibration capture, even if no motion recording is active."""
        state = self.engine.direction.state
        token = (state.get("attempt_id"), state["status"], state.get("stage"))
        if self._direction_saved_status == token or not state.get("attempt_id"):
            return
        target_dir = self.recorder.root / "calibrations"
        name=datetime.now().strftime("%Y%m%d-%H%M%S-")+uuid4().hex[:10]+".json"
        target=target_dir/name
        data=self.engine.direction.evidence_snapshot()
        data.update(schema_version="functional-calibration-capture/1",
                    event={"status":state["status"],"stage":state.get("stage"),"reason":state.get("message")})
        self._direction_saved_status=token
        def write():
            target_dir.mkdir(parents=True,exist_ok=True)
            pending=target.with_suffix(".json.tmp")
            pending.write_text(json.dumps(data,ensure_ascii=False,allow_nan=False,separators=(",",":")),encoding="utf-8")
            pending.replace(target)
        async def persist():
            try:
                await asyncio.to_thread(write)
                state["saved_evidence"]=str(target)
            except (OSError,ValueError) as exc:
                self.message=f"方向标定证据保存失败，请勿视作已保存：{exc}"
                state["save_error"]=str(exc)
        task=asyncio.create_task(persist())
        self._direction_save_tasks.add(task)
        task.add_done_callback(self._direction_save_tasks.discard)

    async def connect(self, data):
        endpoint_id = str(data.get("endpoint_id") or f"endpoint-{len(self.endpoints)+1}")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", endpoint_id):
            raise ValueError("端点名称仅允许字母数字下划线和短横线")
        if endpoint_id in self.endpoints:
            await self.disconnect(endpoint_id)
        transport = data.get("transport", "wifi")
        if transport not in ("wifi", "serial"):
            raise ValueError("通信方式必须为 USB 串口或 Wi-Fi TCP")
        endpoint = {"endpoint_id": endpoint_id, "transport": transport, "status": "connecting",
                    "message": "", "invalid_frames": 0, "generation": object()}
        if transport == "wifi":
            host, port = str(data.get("host", "")).strip(), int(data.get("tcp_port", 9000))
            if not host or not all(c.isalnum() or c in ".-:" for c in host) or not 1 <= port <= 65535:
                raise ValueError("TCP 地址或端口无效")
            if any(e.get("host") == host and e.get("tcp_port") == port and e["status"] in ("connecting","connected") for e in self.endpoints.values()):
                raise ValueError("该 TCP 端点已连接；一块板只允许一个接收程序")
            endpoint.update(host=host, tcp_port=port)
        else:
            port = str(data.get("device") or data.get("port") or "").strip()
            if not port:
                raise ValueError("请选择当前串口")
            if any(e.get("device") == port and e["status"] in ("connecting","connected") for e in self.endpoints.values()):
                raise ValueError("该串口已连接")
            endpoint.update(device=port)
        self.endpoints[endpoint_id] = endpoint
        try:
            await self._open(endpoint)
            self.message = f"已连接 {endpoint_id}；旧流请显式绑定身体位置"
        except Exception as exc:
            endpoint.update(status="error", message=str(exc) or type(exc).__name__)
            raise ValueError(endpoint["message"]) from exc

    async def _open(self, endpoint):
        endpoint_id, generation = endpoint["endpoint_id"], endpoint["generation"]
        async def on_line(raw):
            if self.endpoints.get(endpoint_id, {}).get("generation") is generation:
                self.on_line(raw, endpoint_id)
        async def on_disconnect(reason):
            if self.endpoints.get(endpoint_id, {}).get("generation") is generation:
                endpoint.update(status="disconnected", message=reason)
                self.engine.disconnect_endpoint(endpoint_id)
                self._event("connection_lost", endpoint_id=endpoint_id, reason=reason)
                if endpoint["transport"] == "wifi":
                    endpoint["reconnect_task"] = asyncio.create_task(self._reconnect(endpoint))
        if endpoint["transport"] == "wifi":
            candidate = TcpTransport(endpoint["host"], endpoint["tcp_port"], on_line, on_disconnect)
        else:
            candidate = SerialTransport(endpoint["device"], 115200, on_line, on_disconnect)
        endpoint["transport_object"] = candidate
        await candidate.connect()
        endpoint["status"] = "connected"
        endpoint["message"] = ""
        self._event("connected", endpoint_id=endpoint_id, transport=endpoint["transport"])

    async def _reconnect(self, endpoint):
        for delay in (1, 2, 4):
            await asyncio.sleep(delay)
            if self.endpoints.get(endpoint["endpoint_id"]) is not endpoint or endpoint.get("status") == "closed":
                return
            endpoint["status"] = "connecting"
            try:
                await self._open(endpoint)
                return
            except Exception as exc:
                endpoint.update(status="error", message=str(exc))

    async def disconnect(self, endpoint_id):
        endpoint = self.endpoints.get(endpoint_id)
        if endpoint is None:
            return
        endpoint["status"], endpoint["generation"] = "closed", object()
        task = endpoint.get("reconnect_task")
        if task and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        obj = endpoint.get("transport_object")
        if obj:
            await obj.disconnect()
        self.engine.disconnect_endpoint(endpoint_id)
        self._event("disconnected", endpoint_id=endpoint_id)

    def on_line(self, raw, endpoint_id):
        try:
            sample = self.protocol.parse(raw.decode("utf-8"))
            if sample is not None:
                return self.consume(sample, endpoint_id)
        except (FrameError, UnicodeDecodeError, ValueError) as exc:
            self.endpoints[endpoint_id]["invalid_frames"] += 1
            self.engine.invalid_frame(endpoint_id, str(exc))
            self._event("invalid_frame", endpoint_id=endpoint_id, reason=str(exc))

    def consume(self, sample, endpoint_id, source="real"):
        record = self.engine.ingest(sample, endpoint_id, source)
        self._drain_events()
        if record is not None:
            self.recorder.append_sample(record)
            device_id = record.get("device_id", sample.node_id)
            self._raw_by_device[device_id] = sample
            motion = self.motions.get(device_id)
            if motion and motion.active:
                q = record.get("fused_quaternion", record.get("quaternion"))
                if q:
                    processor = self.engine.devices[device_id]
                    corrected = processor.stability.corrected(processor.mapped_sample)
                    motion.update(corrected, q)
        return record

    def _editable(self):
        if self.mode != "LIVE":
            raise ValueError("回放中不可修改实时绑定、参考或校准；先返回实时")
        if self.recorder.active:
            raise ValueError("记录中禁止改绑定、参考、校准和输入模式，请先停止并保存")

    def session_busy_reason(self, session):
        if self.recorder.session == session and self.recorder.busy:
            return "请先停止录制并等待保存完成"
        if self.replay.session == session:
            return "请先退出该会话的回放"
        return None

    async def recycle_session(self, session):
        async with self._lock:
            if reason := self.session_busy_reason(session):
                raise session_library.SessionConflict(reason)
            await asyncio.to_thread(session_library.recycle, self.recorder.root, session)

    async def restore_session(self, trash_id):
        async with self._lock:
            return await asyncio.to_thread(session_library.restore, self.recorder.root, trash_id)

    async def protect_session(self, session, protected):
        async with self._lock:
            if reason := self.session_busy_reason(session):
                raise session_library.SessionConflict(reason)
            await asyncio.to_thread(session_library.set_calibration, self.recorder.root, session, protected)

    async def command(self, data):
        async with self._lock:
            request_id = data.get("request_id") if isinstance(data, dict) else None
            try:
                if not isinstance(data, dict):
                    raise ValueError("命令必须为 JSON 对象")
                await self._command(data)
                if data.get("action") not in ("select", "replay_seek"):
                    message = "已开始定姿采样，请保持静止" if data.get("action") == "direction_start" else "操作已完成"
                    self.command_result = {"request_id": request_id, "ok": True, "message": message}
            except (ValueError, TypeError, KeyError, OSError) as exc:
                self.message = f"操作失败：{exc}"
                self.command_result = {"request_id": request_id, "ok": False, "message": self.message}

    async def _command(self, data):
        action = data.get("action")
        device_id = data.get("device_id") or self.selected_device_id
        if action == "connect":
            await self.connect(data)
        elif action == "disconnect":
            await self.disconnect(data["endpoint_id"])
        elif action == "select":
            self.selected_device_id = data["device_id"]
        elif action == "direction_start":
            self._editable()
            if self.engine.initialization["status"] == "collecting":
                raise ValueError("先结束中立初始化，再采集方向动作")
            self.engine.direction_start(data["stage"], data.get("device_ids"))
            self.message = self.engine.direction.state["message"]
        elif action == "direction_finish":
            self._editable()
            result = self.engine.direction_finish()
            self.message = result["message"]
            self._save_direction_evidence()
        elif action == "direction_apply":
            self._editable()
            self.engine.direction_apply()
            self.message = self.engine.direction.state["message"]
            self._save_direction_evidence()
        elif action == "direction_cancel":
            self._editable()
            self.engine.direction_cancel()
            self.message = self.engine.direction.state["message"]
        elif action == "direction_demo":
            self._editable()
            if any(d.source=="real" and d.connected for d in self.engine.devices.values()):
                raise ValueError("已有真实设备连接；离线方向演示不会替换或断开真实输入，请使用独立测试服务")
            await self.stop_simulation()
            self.engine.clear_simulations()
            from .direction_demo import DirectionDemo
            self._direction_demo = DirectionDemo(self,data.get("scenario","valid"))
            self._direction_demo.feed()
            self.selected_device_id = self._direction_demo.cases[0][0]
            async def feed_direction():
                while True:
                    self._direction_demo.feed()
                    await asyncio.sleep(.01)
            self._simulation_task=asyncio.create_task(feed_direction())
            self.message = "离线方向真值场景已加载：两路不同安装和融合参考；仅AHRS输出注入已知几何，硬件在线数仍为0。请手动走标定步骤"
        elif action == "direction_demo_pose":
            if not self._direction_demo:
                raise ValueError("请先加载离线方向演示")
            self._direction_demo.set_validation(data["pose"])
        elif action == "choose_source":
            self._editable()
            self.engine.choose_source(device_id, data["endpoint_id"])
            self.message = "设备主来源已切换；请重新初始化"
        elif action == "bind":
            self._editable()
            if data.get("body_slot") is None and not data.get("override", False):
                self.engine.clear_override(device_id)
            else:
                self.engine.bind(device_id, data.get("body_slot"), override=bool(data.get("override", True)))
            self._event("binding_changed", device_id=device_id, body_slot=data.get("body_slot"), temporary_override=True)
            self.message = "位置绑定已更新；请重新进行中立站姿初始化"
        elif action == "initialize":
            self._editable()
            if data.get("stage") == "begin":
                self.engine.begin_initialization(data.get("device_ids"))
                self.message = "目标站姿仅为引导；保持静止采集窗口后点击确认"
            elif data.get("stage") == "confirm":
                self.engine.finish_initialization()
                self.message = "初始化结果已更新；归零不消除漂移、不启动位置积分"
            else:
                raise ValueError("请选择开始引导或确认站姿")
        elif action in ("calibrate", "set_coordinates", "reset_reference"):
            self._editable()
            if action == "calibrate":
                self.engine.calibrate_bias(device_id)
            elif action == "set_coordinates":
                self.engine.set_coordinates(device_id, CoordinateSettings.parse(data.get("coordinates")))
            else:
                self.engine.invalidate(device_id, "用户重新佩戴或更换参考")
            if device_id in self.motions:
                self.motions[device_id].reset()
            self.message = "处理参考已改变；需重新中立站姿初始化"
        elif action == "cancel_calibration":
            self._editable()
            self.engine.cancel_calibration(device_id)
            self.message = "校准已取消；旧成功零偏保留，安装参考仍需重新初始化"
        elif action == "set_magnetic_calibration":
            self._editable()
            node = self.engine.devices[device_id]
            candidate = magnetometer.validate(data["calibration"])
            if candidate.get("source_device_id",device_id)!=device_id:
                raise ValueError("磁校准物理设备身份不匹配")
            candidate = await asyncio.to_thread(magnetometer.save,device_id,candidate)
            self.engine.set_magnetic_calibration(node.device_id,candidate)
            self.message = "三维磁校准已应用并保存；需重新确认安装/中立参考"
        elif action == "set_processing":
            self._editable()
            self.engine.set_processing(device_id,data["profile"])
            self.message = "融合策略已切换；仅作用选中设备，需重新中立初始化"
        elif action == "set_stability":
            self._editable()
            self.engine.set_stability(device_id,data["enabled"])
            self.message = "停稳保持已更新；慢动作诊断可关闭此阈值约束"
        elif action == "simulate":
            self._editable()
            await self.start_simulation(data)
        elif action == "simulate_stop":
            self._editable()
            await self.stop_simulation()
        elif action == "position":
            self._editable()
            source = data.get("source", "off")
            if source not in ("off", "simulated", "experimental"):
                raise ValueError("位置来源无效")
            value = data.get("position", [0,0,0])
            if not isinstance(value,(list,tuple)) or len(value)!=3 or not all(isinstance(v,(int,float)) and math.isfinite(v) and abs(v)<=100 for v in value):
                raise ValueError("位置应为三个有限米制数值")
            if source == "experimental":
                self._start_motion(device_id, data)
            self.position = {"source":source, "position":list(value), "experimental":source=="experimental", "device_id":device_id}
            self._event("position_source", **self.position)
        elif action in ("start_motion", "stop_motion", "reset_motion"):
            self._editable()
            if action == "start_motion":
                self._start_motion(device_id, data)
            elif action == "stop_motion" and device_id in self.motions:
                self.motions[device_id].stop()
            elif action == "reset_motion" and device_id in self.motions:
                self.motions[device_id].reset()
        elif action in ("record_start", "start_recording"):
            if self.mode != "LIVE":
                raise ValueError("回放与录制互斥，先返回实时")
            if self.engine.direction.capturing or self.engine.initialization["status"] == "collecting" or any(d.stability.calibrating for d in self.engine.devices.values()):
                raise ValueError("请先等待初始化/零偏校准结束，再开始记录")
            snapshot = self.payload()
            snapshot["direction_calibration_evidence"] = self.engine.direction.evidence_snapshot()
            self.recorder.start(snapshot)
            self.message = "正在记录原始采样、融合姿态、完整骨架帧和事件"
        elif action in ("record_stop", "stop_recording"):
            self._event("recording_stopped")
            await asyncio.to_thread(self.recorder.stop)
            self.message = self.recorder.error or "记录已保存"
        elif action == "replay_open":
            if self.recorder.active:
                raise ValueError("录制与回放互斥，先停止并保存")
            if self.engine.direction.capturing or self.engine.initialization["status"] == "collecting" or any(d.stability.calibrating for d in self.engine.devices.values()):
                raise ValueError("请先等待初始化/零偏校准结束，再回放")
            self.replay.open(data["session"])
            self.mode = "REPLAY"
            self.epoch += 1
            self.message = "回放保存的骨架帧；实时连接可保留，但不会覆盖回放"
        elif action == "replay_play":
            self.replay.play()
        elif action == "replay_pause":
            self.replay.advance()
            self.replay.playing = False
        elif action == "replay_seek":
            self.replay.seek(data["time_s"])
        elif action == "replay_close":
            self.replay.close()
            self.mode = "LIVE"
            self.epoch += 1
            self.message = "已返回最新实时状态"
        else:
            raise ValueError("未知操作")
        self._drain_events()

    def _start_motion(self, device_id, data):
        if device_id not in self._raw_by_device:
            raise ValueError("请选择有原始采样的设备；已知姿态路径不能估计位移")
        motion = self.motions.setdefault(device_id, DisplacementEstimator())
        motion.start(data.get("duration_s",0), data.get("zupt", True), data.get("drift_mode", "balanced"))
        self.message = "实验性惯性位移已单独启动；固定根部火柴人不受影响"

    async def stop_simulation(self):
        if self._simulation_task:
            self._simulation_task.cancel()
            try:
                await self._simulation_task
            except asyncio.CancelledError:
                pass
            self._simulation_task = None
        self._simulation_signature = None
        self._direction_demo = None
        for endpoint in list(self.endpoints.values()):
            if endpoint.get("simulation"):
                endpoint["status"] = "closed"
                self.engine.disconnect_endpoint(endpoint["endpoint_id"])
        self.message = "模拟已停止；节点按失鲜策略保持，不计作实板在线"

    async def start_simulation(self, data):
        config = self.engine.snapshot()["config"]
        all_slots = [s["id"] for s in config["segments"]]
        count = int(data.get("count", 1))
        if not 1 <= count <= len(all_slots):
            raise ValueError(f"模拟节点数应为 1–{len(all_slots)}")
        path = data.get("path", "pose")
        if path not in ("pose", "sensor"):
            raise ValueError("模拟路径应为 pose 或 sensor")
        slot = data.get("slot", "left_upper_arm")
        if slot not in all_slots:
            raise ValueError("未知身体位置")
        slots = [slot]+[s for s in all_slots if s != slot]
        slots = slots[:count]
        axis = data.get("axis", "x")
        angle = float(data.get("angle_deg", 45))
        if axis not in ("x","y","z") or not math.isfinite(angle) or abs(angle)>360:
            raise ValueError("模拟轴或角度无效")
        signature = (path, tuple(slots), axis)
        if self._simulation_task and self._simulation_signature == signature:
            self._simulation_angle = angle
            self.message = "已更新模拟旋转目标；保持设备会话和安装参考，不改变其他骨段的局部运动"
            return
        await self.stop_simulation()
        for identity, node in self.engine.devices.items():
            if node.source.startswith("simulation"):
                self.motions.pop(identity, None)
                self._raw_by_device.pop(identity, None)
        self.engine.clear_simulations()
        for key in list(self.endpoints):
            if self.endpoints[key].get("simulation"):
                del self.endpoints[key]
        self._sim_generation += 1
        generation = self._sim_generation
        self._simulation_signature, self._simulation_angle = signature, angle
        boot = f"sim-{generation}"
        for role in slots:
            endpoint_id = f"simulation-{role}"
            self.endpoints[endpoint_id] = {"endpoint_id":endpoint_id, "transport":path,
                                           "status":"connected", "simulation":True, "invalid_frames":0}
        async def feed():
            started, seq = monotonic(), 0
            last, current_angle = started, angle
            while True:
                now = monotonic()
                dt = max(.001, min(.1, now-last))
                last = now
                change = max(-60*dt, min(60*dt, self._simulation_angle-current_angle))
                current_angle += change
                qangles = [0.,0.,0.]
                qangles["xyz".index(axis)] = math.radians(self._simulation_angle if path=="pose" else current_angle)
                q = euler_quaternion(*qangles)
                for i, role in enumerate(slots):
                    endpoint_id = f"simulation-{role}"
                    device_id = f"sim-{path}-{role}"
                    if path == "pose":
                        self.engine.ingest_pose(device_id, role, q if i==0 else (1.,0.,0.,0.),
                                                endpoint_id=endpoint_id, source="simulation_pose", now=now, boot_id=boot)
                    else:
                        from .kinematics import rotate
                        qi = q if i==0 else (1.,0.,0.,0.)
                        inverse = (qi[0], -qi[1], -qi[2], -qi[3])
                        gyro = [0.,0.,0.]
                        if i==0:
                            gyro["xyz".index(axis)] = change/dt
                        sample = SensorSample(rotate((0.,0.,1.), inverse), tuple(gyro), rotate((300.,0.,100.),inverse),25.,0.,
                                              received_monotonic=now, node_id=device_id, sequence=seq,
                                              device_us=int((now-started)*1e6) % 2**32)
                        sample = replace(sample, body_slot=role, boot_id=boot)
                        self.consume(sample, endpoint_id, "simulation_sensor")
                self._drain_events()
                seq += 1
                await asyncio.sleep(.01)
        self._simulation_task = asyncio.create_task(feed())
        self.message = f"离线模拟 {count} 节点（{path}）；不属于实板验收"
