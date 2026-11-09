"""Configurable body registry, guided neutral reference and hierarchical solver.

No transport, file I/O, displacement integration or browser state belongs here.
The same engine consumes real frames, synthetic sensor data and known poses.
"""
from __future__ import annotations

from copy import deepcopy
from time import monotonic, time
from uuid import uuid4

from .body_config import canonical_slot, load_config, validate_config
from .body_math import IDENTITY, add, angle_degrees, inverse, mean, multiply, quaternion, rotate
from .body_nodes import NodeProcessor, norm
from .coordinates import CoordinateSettings
from .attitude_config import load_attitude_config
from .direction_session import DirectionSession


class BodyEngine:
    def __init__(self, config=None, fusion_factory=None, attitude_config=None):
        self.config = validate_config(config) if config is not None else load_config()
        self.attitude_config = attitude_config or load_attitude_config()
        self.fusion_factory = fusion_factory
        self.devices = {}
        self.nodes = self.devices
        self.endpoints = {}
        self.endpoint_invalid = {}
        self._events = []
        self._last_local = {}
        self._conflicts = set()
        self.initialization = {"status": "idle", "message": "请先确认身体位置，再跟随中立站姿并点击确认采集", "devices": [], "progress": 0.}
        self.direction = DirectionSession(self)

    def _event(self, kind, **values):
        self._events.append({"type": kind, "monotonic": monotonic(), "unix": time(), **values})

    def pop_events(self):
        events, self._events = self._events, []
        return events

    def clear_simulations(self):
        """Explicit demo reset only; physical devices and their bindings survive."""
        for device_id, node in list(self.devices.items()):
            if node.source.startswith("simulation"):
                self._clear_local(node.body_slot)
                del self.devices[device_id]
                for endpoint_id, identity in list(self.endpoints.items()):
                    if identity == device_id:
                        del self.endpoints[endpoint_id]
        self.initialization = {"status":"idle", "message":"模拟来源已重置，请重新初始化", "devices":[], "progress":0.}
        self._event("simulation_reset")
        self.direction.cancel()

    def invalid_frame(self, endpoint_id, reason="协议解析失败"):
        self.endpoint_invalid[endpoint_id] = self.endpoint_invalid.get(endpoint_id, 0)+1
        for device in self.devices.values():
            if device.primary_endpoint == endpoint_id:
                device.invalid_frames += 1
                device.last_error = reason
        self._event("invalid_frame", endpoint_id=endpoint_id, reason=reason)

    def _device(self, device_id):
        if device_id not in self.devices:
            self.devices[device_id] = NodeProcessor(device_id, self.config, self.fusion_factory, self.attitude_config)
            self._event("device_discovered", device_id=device_id)
        return self.devices[device_id]

    def _attach(self, node, endpoint_id, source):
        previous = self.endpoints.get(endpoint_id)
        if previous is not None and previous != node.device_id:
            old = self.devices[previous]
            old.active_endpoints.discard(endpoint_id)
            old.connected = bool(old.active_endpoints and old.primary_endpoint in old.active_endpoints)
            old.reset_reference("端点更换板卡：需重新初始化")
            self._event("endpoint_device_changed", endpoint_id=endpoint_id, old_device_id=previous, device_id=node.device_id)
        self.endpoints[endpoint_id] = node.device_id
        node.endpoint_ids.add(endpoint_id)
        node.active_endpoints.add(endpoint_id)
        if node.primary_endpoint is None:
            node.primary_endpoint = endpoint_id
            node.source = source
        if node.primary_endpoint != endpoint_id:
            node.duplicate_sources += 1
            if node.duplicate_sources == 1:
                self._event("duplicate_source_isolated", device_id=node.device_id, endpoint_id=endpoint_id,
                            primary_endpoint=node.primary_endpoint)
            return False
        if not node.connected:
            node.begin_connection_quality()
        node.connected = True
        if node.source != source:
            node.reset_reference("输入来源类型改变：需重新初始化", reset_fusion=True)
            node.source = source
            self._event("source_changed", device_id=node.device_id, source=source)
        return True

    def choose_source(self, device_id, endpoint_id):
        node = self.devices[device_id]
        if endpoint_id not in node.endpoint_ids:
            raise ValueError("设备尚未在指定端点出现")
        if node.primary_endpoint != endpoint_id:
            node.primary_endpoint = endpoint_id
            node.begin_connection_quality()
            node.connected = endpoint_id in node.active_endpoints
            node.reset_reference("主来源改变：需重新初始化", reset_fusion=True)
            node.last_sequence = node.last_device_us = node.unwrapped_device_us = None
            node.clock_offset_s = None
            self._clear_local(node.body_slot)
            self._event("source_selected", device_id=device_id, endpoint_id=endpoint_id)

    def disconnect_endpoint(self, endpoint_id):
        device_id = self.endpoints.get(endpoint_id)
        if device_id in self.devices:
            node = self.devices[device_id]
            node.active_endpoints.discard(endpoint_id)
            if node.primary_endpoint == endpoint_id:
                node.connected = False
                node.stability.reset_window("连接中断")
            self._event("disconnected", device_id=device_id, endpoint_id=endpoint_id)

    def _clear_local(self, slot):
        if slot is not None:
            self._last_local.pop(slot, None)

    def bind(self, device_id, slot, override=False, *, allow_alias=False, reason="用户显式绑定"):
        canonical = canonical_slot(self.config, slot, allow_alias=allow_alias)
        node = self.devices[device_id]
        if node.reported_slot is not None and canonical != node.reported_slot and not override:
            raise ValueError("与固件报告位置不同；需显式确认临时覆盖")
        previous = node.body_slot
        node.body_slot = canonical
        node.override = bool(override)
        node.binding_source = "temporary_override" if override else "explicit_host_binding"
        # Rebinding the same slot may mean rewearing/changing person. It is an
        # explicit reference reset, never a silent retention of calibration.
        node.reset_reference("位置/佩戴绑定确认：需重新初始化")
        self._clear_local(previous)
        self._clear_local(canonical)
        self._event("binding_changed", device_id=device_id, old_slot=previous, body_slot=canonical,
                    override=node.override, reason=reason, aliases_version=self.config["aliases_version"] if allow_alias else None)

    def clear_override(self, device_id):
        node = self.devices[device_id]
        previous = node.body_slot
        node.body_slot = node.reported_slot
        node.override = False
        node.binding_source = "firmware" if node.reported_slot else "unbound"
        node.reset_reference("已取消覆盖：需重新初始化")
        self._clear_local(previous)
        self._clear_local(node.body_slot)
        self._event("override_cleared", device_id=device_id, body_slot=node.body_slot)

    def _metadata(self, node, sample):
        node.protocol_version = getattr(sample, "protocol_version", "legacy")
        for attr in ("firmware_version", "config_version"):
            incoming = getattr(sample, attr, None)
            old = getattr(node, attr)
            if incoming is not None and old is not None and incoming != old:
                node.reset_reference(f"{attr} 改变：需重新初始化")
                self._clear_local(node.body_slot)
                self._event("device_config_changed", device_id=node.device_id, field=attr, old=old, value=incoming)
            if incoming is not None:
                setattr(node, attr, incoming)
        incoming_slot = getattr(sample, "body_slot", None)
        if incoming_slot is not None:
            try:
                incoming_slot = canonical_slot(self.config, incoming_slot)
                node.unknown_slot = None
            except ValueError:
                if node.unknown_slot != incoming_slot:
                    self._event("unknown_body_slot", device_id=node.device_id, reported_slot=incoming_slot)
                node.unknown_slot = incoming_slot
                incoming_slot = None
        if incoming_slot != node.reported_slot:
            old = node.reported_slot
            node.reported_slot = incoming_slot
            node.reset_reference("固件位置报告改变：需重新初始化")
            self._clear_local(node.body_slot)
            if not node.override and node.binding_source in ("unbound", "firmware"):
                node.body_slot = incoming_slot
                node.binding_source = "firmware" if incoming_slot else "unbound"
            self._event("reported_slot_changed", device_id=node.device_id, old_slot=old, body_slot=incoming_slot)

    def ingest(self, sample, endpoint_id, source="real"):
        node_id = sample.node_id
        legacy = getattr(sample, "protocol_version", "legacy") == "legacy" and sample.sequence is None
        if legacy:
            node_id = f"legacy:{endpoint_id}"
        node = self._device(node_id)
        node.identity_trusted = not legacy
        if not self._attach(node, endpoint_id, source):
            return None
        self._metadata(node, sample)
        had_reference = node.initialized
        record, events = node.consume(sample)
        for event in events:
            self._event(event.pop("type"), **event)
        if had_reference and not node.initialized:
            self._clear_local(node.body_slot)
        if record:
            record["fused_quaternion"] = record["quaternion"]
            record["binding_source"] = node.binding_source
            record["override"] = node.override
            record["processing_profile"] = node.processing_profile
            record["processing_config_version"] = self.attitude_config["config_version"]
            record["processing_settings"] = dict(node.processing_settings)
            record["effective_magnetic_used"] = node.stability.magnetic_used
            record["direction_calibration_id"] = node.direction_calibration.get("calibration_id") if node.direction_calibration and node.direction_calibration.get("valid") else None
            self.direction.observe(node)
        return record

    def direction_start(self, stage, device_ids=None, now=None):
        return self.direction.start(stage, device_ids, now)

    def direction_finish(self, now=None):
        return self.direction.finish(now)

    def direction_apply(self, now=None):
        return self.direction.apply(now)

    def direction_cancel(self):
        self.direction.cancel()

    def ingest_pose(self, device_id, slot, value=None, endpoint_id="pose", source="simulation_pose",
                    now=None, boot_id="pose", calibrated=True, **kwargs):
        """Known world pose path bypasses fusion only; always labelled simulated.

        value is WXYZ. The `quaternion` keyword is accepted for convenient API
        callers. Each known-pose device needs its own endpoint_id, just as real
        transports do; a shared scene may pass `pose:<device_id>` explicitly.
        """
        q = quaternion(value if value is not None else kwargs.get("quaternion"))
        if source == "real":
            raise ValueError("已知姿态注入不能标记为真实采样")
        now = monotonic() if now is None else now
        endpoint_id = f"pose:{device_id}" if endpoint_id == "pose" else endpoint_id
        node = self._device(device_id)
        if not self._attach(node, endpoint_id, source):
            return None
        canonical = canonical_slot(self.config, slot)
        role_changed = node.reported_slot != canonical
        session_changed = node.boot_id != boot_id
        if role_changed:
            self._clear_local(node.body_slot)
            node.reset_reference("已知姿态位置改变")
            node.reported_slot = canonical
            if not node.override:
                node.body_slot = canonical
                node.binding_source = "simulation_explicit"
        if session_changed:
            node.reset_reference("模拟会话改变")
            self._clear_local(canonical)
            node.boot_id = boot_id
        node.quaternion = q
        if (role_changed or session_changed) and calibrated:
            node.reference = IDENTITY
            node.calibration_id = "known-pose/1"
        elif not calibrated:
            node.reference = node.calibration_id = None
        node.latest_at, node.latest_unix = now, time()
        node.valid_frames += 1
        node.arrivals.append(now)
        node.history.append({"time": now, "arrival": now, "quaternion": q, "boot_id": boot_id})
        return {"device_id": device_id, "body_slot": node.body_slot, "boot_id": boot_id,
                "source": source, "quaternion": q, "fused_quaternion": q,
                "monotonic": now, "endpoint_id": endpoint_id}

    def set_coordinates(self, device_id, settings):
        node = self.devices[device_id]
        node.coordinates = settings if isinstance(settings, CoordinateSettings) else CoordinateSettings.parse(settings)
        node.stability.clear()
        node.reset_reference("传感器轴映射改变：需重新初始化", reset_fusion=True)
        self._clear_local(node.body_slot)
        self._event("coordinates_changed", device_id=device_id, coordinates=node.coordinates.payload())

    def reset_reference(self, device_id, reason="换人/重新佩戴/参考重置"):
        node = self.devices[device_id]
        node.reset_reference(reason, reset_fusion=True)
        self._clear_local(node.body_slot)
        self._event("reference_invalidated", device_id=device_id, reason=reason)

    def invalidate(self, device_id, reason="需重新初始化"):
        self.reset_reference(device_id, reason)

    def calibrate_bias(self, device_id, now=None):
        now = monotonic() if now is None else now
        node = self.devices[device_id]
        if not node.snapshot(now)["valid"] or node.last_sample is None:
            raise ValueError("设备尚无有效原始数据或已失鲜")
        node.stability.start_calibration(now=now)
        node.reset_reference("开始陀螺零偏校准；完成后需重新中立初始化")
        self._clear_local(node.body_slot)
        self._event("bias_calibration_started", device_id=device_id)

    def cancel_calibration(self, device_id):
        node = self.devices[device_id]
        node.stability.reset_window("已手动取消；原有成功零偏保留")
        self._event("bias_calibration_cancelled",device_id=device_id)

    def set_magnetic_calibration(self, device_id, calibration):
        self.devices[device_id].set_magnetic_calibration(calibration)
        self._clear_local(self.devices[device_id].body_slot)
        self._event("magnetic_calibration_changed",device_id=device_id)

    def set_processing(self, device_id, profile):
        node = self.devices[device_id]
        node.set_processing(profile)
        self._clear_local(node.body_slot)
        self._event("processing_changed",device_id=device_id,profile=profile,
                    processing_config_version=self.attitude_config["config_version"])

    def set_stability(self, device_id, enabled):
        if type(enabled) is not bool:
            raise ValueError("停稳保持开关须为布尔值")
        self.devices[device_id].stability_enabled = enabled
        self._event("stability_changed",device_id=device_id,enabled=enabled)

    def _bindings(self):
        slots = {segment["id"]: [] for segment in self.config["segments"]}
        for node in self.devices.values():
            if node.body_slot in slots:
                slots[node.body_slot].append(node)
        return slots

    def begin_initialization(self, device_ids=None, now=None, *, full=False):
        if self.direction.capturing:
            raise ValueError("请先结束或取消方向标定，再改变中立参考")
        now = monotonic() if now is None else now
        bindings = self._bindings()
        if device_ids is None:
            device_ids = [node.device_id for node in self.devices.values()
                          if node.body_slot and node.snapshot(now)["valid"] and len(bindings[node.body_slot]) == 1
                          and node.source != "simulation_pose"]
        else:
            device_ids = list(dict.fromkeys(device_ids))
        if not device_ids:
            raise ValueError("没有可初始化的已绑定有效节点")
        if full and len(device_ids) != len(self.config["segments"]):
            raise ValueError("完整初始化需要全部槽位；少量节点请选择部分初始化")
        for device_id in device_ids:
            if device_id not in self.devices:
                raise ValueError("未知设备")
            node = self.devices[device_id]
            if (node.body_slot is None or len(bindings[node.body_slot]) != 1 or not node.snapshot(now)["valid"]
                    or node.stability.calibrating):
                raise ValueError("节点未绑定、冲突、失鲜或正在零偏校准")
        self.initialization = {"status": "prepared", "message": "请跟随中立目标站姿，确认佩戴朝向后点击确认开始采集；系统不自动识别站姿", "devices": device_ids,
                               "prepared_at": now, "progress": 0., "scope": [self.devices[d].body_slot for d in device_ids],
                               "session_snapshot": {d: {"boot_id": self.devices[d].boot_id,
                                                        "slot": self.devices[d].body_slot,
                                                        "invalid_frames": self.devices[d].invalid_frames} for d in device_ids}}
        self._event("initialization_prepared", devices=device_ids, scope=self.initialization["scope"])
        return deepcopy(self.initialization)

    def finish_initialization(self, now=None):
        """Wearer confirmation starts a fresh acquisition window, never earlier."""
        now = monotonic() if now is None else now
        if self.initialization["status"] == "prepared":
            self.initialization.update(status="collecting", started=now, progress=0.,
                                       message="已确认站姿，请保持静止；正在采集新的短窗口")
            self._event("initialization_started", devices=self.initialization["devices"],
                        scope=self.initialization["scope"])
        return self._advance_initialization(now)

    def _advance_initialization(self, now=None):
        now = monotonic() if now is None else now
        state = self.initialization
        if state["status"] != "collecting":
            return deepcopy(state)
        thresholds = self.config["initialization"]
        elapsed = now-state["started"]
        state["progress"] = min(1., max(0., elapsed/thresholds["duration_s"]))
        references, statistics = {}, {}
        error = None
        wait = False
        for device_id in state["devices"]:
            node = self.devices[device_id]
            previous = state["session_snapshot"][device_id]
            if (not node.snapshot(now)["valid"] or node.boot_id != previous["boot_id"]
                    or node.body_slot != previous["slot"] or node.invalid_frames != previous["invalid_frames"]
                    or len(self._bindings().get(node.body_slot, [])) != 1):
                error = f"{device_id} 数据中断、无效、会话/绑定变化或冲突"
                break
            samples = [item for item in node.raw_history if item[0] >= state["started"]]
            if any(norm(node.stability.corrected(item[2]).gyro) > thresholds["maximum_gyro_dps"]
                   or not thresholds["accel_norm_min_g"] <= norm(item[2].accel) <= thresholds["accel_norm_max_g"] for item in samples):
                error = f"{device_id} 检测到运动或无效重力"
                break
            span = samples[-1][0]-samples[0][0] if len(samples) > 1 else 0.
            if len(samples) < thresholds["minimum_samples"] or span < thresholds["duration_s"]-1e-9:
                wait = True
                continue
            q = mean([item[1] for item in samples])
            spread = max(angle_degrees(item[1], q) for item in samples)
            if spread > thresholds["max_orientation_spread_deg"]:
                error = f"{device_id} 姿态窗口不稳定"
                break
            references[device_id] = q
            statistics[device_id] = {"samples": len(samples), "duration_s": span, "spread_deg": spread}
        if error is None and wait and elapsed > thresholds["duration_s"]+5:
            error = "有效静止窗口不足，初始化超时"
        if error is not None:
            state.update(status="failed", message=error)
            self._event("initialization_failed", reason=error, devices=state["devices"])
        elif not wait:
            calibration_id = uuid4().hex
            for device_id, reference in references.items():
                node = self.devices[device_id]
                node.reset_reference("重新中立归零：旧安装/方向标定失效，请重做方向动作")
                node.reference = reference
                node.calibration_id = calibration_id
                node.reference_reason = "中立站姿参考；不等于零偏/磁标定或漂移消除"
                self._clear_local(node.body_slot)
            state.update(status="complete", progress=1., calibration_id=calibration_id,
                         quality=statistics, message="部分节点中立参考已建立；共同航向仍依赖佩戴/站姿约定")
            self._event("initialization_complete", calibration_id=calibration_id, devices=state["devices"],
                        scope=state["scope"], quality=statistics)
        return deepcopy(state)

    def snapshot(self, now=None):
        now = monotonic() if now is None else now
        self._advance_initialization(now)
        bindings = self._bindings()
        current_conflicts = {slot for slot, nodes in bindings.items() if len(nodes) > 1}
        for slot in current_conflicts-self._conflicts:
            self._event("slot_conflict", body_slot=slot, devices=[d.device_id for d in bindings[slot]])
            for node in bindings[slot]:
                node.reset_reference("身体位置冲突：需解除冲突后重新初始化")
            self._clear_local(slot)
        for slot in self._conflicts-current_conflicts:
            self._event("slot_conflict_resolved", body_slot=slot)
        self._conflicts = current_conflicts
        direction_state = self.direction.snapshot(now)
        diagnostic = {}
        for device_id, node in self.devices.items():
            was_calibrating = node.stability.calibrating
            diagnostic[device_id] = node.snapshot(now)
            if was_calibrating and node.stability.phase == "failed":
                self._event("bias_calibration_timeout",device_id=device_id,reason=node.stability.message)
        segments, by_id, slots, points = [], {}, [], {}
        render_at = now-self.config["timing"]["display_delay_s"]
        for spec in self.config["segments"]:
            slot, parent_id = spec["id"], spec["parent"]
            candidates = bindings[slot]
            node = candidates[0] if len(candidates) == 1 else None
            item = diagnostic[node.device_id] if node else None
            source, measured, status = "unmeasured", False, "unmeasured"
            if len(candidates) > 1:
                status, source = "conflict", "quarantined"
            elif node is not None:
                source = node.source
                if not node.connected:
                    status = "disconnected"
                elif item["quality"]["age_ms"] is None or item["quality"]["age_ms"] > self.config["timing"]["stale_s"]*1000:
                    status = "stale"
                elif not node.initialized:
                    status = "uninitialized"
                elif item["quality"]["age_ms"] > self.config["timing"]["delayed_s"]*1000:
                    status = "delayed"
                else:
                    status = "online"
            parent = by_id.get(parent_id)
            parent_q = parent["world_quaternion"] if parent else IDENTITY
            fresh = node is not None and status in ("online", "delayed") and node.initialized
            if fresh:
                world_q = node.world_quaternion(render_at)
                local_q = multiply(inverse(parent_q), world_q)
                self._last_local[slot] = local_q
                measured = True
            else:
                local_q = self._last_local.get(slot, IDENTITY) if status in ("stale", "disconnected") else IDENTITY
                world_q = multiply(parent_q, local_q)
            if parent is None:
                start = tuple(self.config["root_position"])
            else:
                if spec.get("anchor_at_parent_tip"):
                    start = parent["end"]
                else:
                    start = add(parent["start"], rotate(spec["anchor"], parent_q))
            end = add(start, rotate(tuple(v*spec["length"] for v in spec["direction"]), world_q))
            chain_degraded = bool(parent and (parent["chain_degraded"] or not parent["measured"]))
            segment = {"id": slot, "name": spec["name"], "parent": parent_id,
                       "start": start, "end": end, "world_quaternion": world_q, "local_quaternion": local_q,
                       "status": status, "source": source, "measured": measured,
                       "device_id": node.device_id if node else None, "chain_degraded": chain_degraded,
                       "length": spec["length"], "held": status in ("stale", "disconnected"),
                       "mount_hint": spec.get("mount_hint", "")}
            segments.append(segment)
            by_id[slot] = segment
            points[slot], points[f"{slot}_tip"] = start, end
            slots.append({"id": slot, "name": spec["name"], "device_id": segment["device_id"],
                          "devices": [d.device_id for d in candidates], "status": status, "source": source,
                          "initialized": bool(node and node.initialized), "measured": measured,
                          "override": bool(node and node.override), "endpoint_id": node.primary_endpoint if node else None,
                          "invalid_frames": item["quality"]["invalid_frames"] if item else None,
                          "direction_calibrated": bool(node and node.direction_calibration and node.direction_calibration.get("valid")),
                          "age_ms": item["quality"]["age_ms"] if item else None,
                          "conflict": status == "conflict", "mount_hint": spec.get("mount_hint", "")})
        frame = {"version": "body-frame/1", "skeleton_version": self.config["skeleton_version"],
                 "timestamp": time(), "monotonic": now, "presentation_monotonic": render_at,
                 "root_position": tuple(self.config["root_position"]), "segments": segments, "points": points,
                 "approximate_alignment": True, "coordinates": self.config["coordinates"],
                 "real_online": sum(slot["measured"] and slot["source"] == "real" for slot in slots),
                 "simulation_online": sum(slot["measured"] and slot["source"] != "real" for slot in slots)}
        return {"body_frame": frame, "devices": list(diagnostic.values()), "slots": slots,
                "config": deepcopy(self.config), "attitude_config": deepcopy(self.attitude_config),
                "initialization": deepcopy(self.initialization),
                "direction_calibration": direction_state,
                "endpoint_invalid": dict(self.endpoint_invalid)}
