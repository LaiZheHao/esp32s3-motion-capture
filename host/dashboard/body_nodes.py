"""One fusion, clock, quality buffer and installation reference per device.

Fusion providers are replaceable without changing transports or the body solver.
A provider owns its absolute right-handed sensor-to-reference attitude, exposes
update(sample, correction_scale=1), reset() and optionally a version string.
Reference changes must go through NodeProcessor.reset_reference().
"""
from __future__ import annotations

from collections import deque
from dataclasses import asdict, replace
from copy import deepcopy
import math
from typing import Protocol

from .attitude_stability import AttitudeStabilizer
from .attitude_config import load_attitude_config, device_profile
from .body_math import IDENTITY, inverse, multiply, quaternion, slerp
from .coordinates import CoordinateSettings
from .fusion import ComplementaryFusion, euler_degrees
from . import magnetometer


class FusionProvider(Protocol):
    def update(self, sample, correction_scale=1.): ...
    def reset(self): ...


def norm(vector):
    return math.sqrt(sum(v*v for v in vector))


class NodeProcessor:
    def __init__(self, device_id, config, fusion_factory=None, attitude_config=None):
        self.device_id, self.config = device_id, config
        self.attitude_config = attitude_config or load_attitude_config()
        self.processing_profile, self.processing_settings = device_profile(self.attitude_config, device_id)
        self._fusion_factory = fusion_factory
        self.fusion = self._make_fusion()
        self.fusion_version = getattr(self.fusion, "version", "complementary/1")
        self.coordinates = CoordinateSettings.parse({"sensor_axes": config["coordinates"]["sensor_axes"]})
        self.stability = AttitudeStabilizer()
        self.magnetic_calibration = magnetometer.load(device_id)
        self.stability_enabled = self.processing_settings["stability_enabled"]
        self.quaternion = IDENTITY
        self.reference = None
        self.fusion_to_world = IDENTITY
        self.calibration_id = None
        self.direction_calibration = None
        self.reference_revision = 0
        self.reference_reason = "尚未进行中立站姿初始化"
        self.body_slot = self.reported_slot = None
        self.binding_source = "unbound"
        self.override = False
        self.unknown_slot = None
        self.primary_endpoint = None
        self.endpoint_ids = set()
        self.active_endpoints = set()
        self.source = "real"
        self.boot_id = self.firmware_version = self.config_version = None
        self.protocol_version = "unknown"
        self.identity_trusted = True
        self.last_sample = self.mapped_sample = None
        self.last_sequence = self.last_device_us = None
        self.unwrapped_device_us = None
        self.clock_offset_s = None
        self.latest_at = self.latest_unix = None
        self.connected = False
        self.valid_frames = self.invalid_frames = self.duplicates = self.missing_frames = self.restarts = self.out_of_order = 0
        self.duplicate_sources = self.sampling_gaps = 0
        self.last_error = None
        self.arrivals = deque(maxlen=500)
        self.history = deque(maxlen=int(config["timing"]["buffer_size"]))
        self.raw_history = deque(maxlen=1200)
        self.begin_connection_quality()

    def begin_connection_quality(self):
        # Keep lifetime counters. Start after the first accepted sample so a
        # sequence jump across the disconnected period is diagnostic only.
        self._connection_start = None

    @property
    def initialized(self):
        return self.reference is not None

    def _make_fusion(self):
        if self._fusion_factory is not None:
            return self._fusion_factory()
        return ComplementaryFusion(self.processing_settings["gravity_vector_correction"])

    def set_processing(self, profile):
        name, settings = device_profile(self.attitude_config, self.device_id, profile)
        self.processing_profile, self.processing_settings = name, settings
        self.fusion = self._make_fusion()
        self.fusion_version = getattr(self.fusion,"version","custom/unversioned")
        self.stability.reset_window("处理配置改变；原有成功陀螺零偏保留")
        self.stability_enabled = settings["stability_enabled"]
        self.reset_reference("融合配置改变：需重新中立站姿初始化",reset_fusion=True)

    def set_magnetic_calibration(self, calibration):
        calibration = magnetometer.validate(calibration)
        if calibration.get("source_device_id",self.device_id)!=self.device_id:
            raise ValueError("磁校准物理设备身份不匹配")
        bias, calibrated = self.stability.bias, self.stability.calibrated
        self.magnetic_calibration = calibration
        self.stability.clear()
        self.stability.bias, self.stability.calibrated = bias, calibrated
        self.stability.phase = "complete" if calibrated else "idle"
        self.stability.progress = 1. if calibrated else 0.
        self.stability.message = "磁校准已更新；陀螺零偏保留，需重新确认安装参考" if calibrated else "磁校准已更新，请放稳完成陀螺零偏校准"
        self.reset_reference("磁校准改变融合参考：需重新中立站姿初始化",reset_fusion=True)

    def reset_reference(self, reason, *, reset_fusion=False):
        self.reference_revision += 1
        if self.direction_calibration is not None:
            self.direction_calibration = {**self.direction_calibration, "valid": False, "invalid_reason": reason}
        self.fusion_to_world = IDENTITY
        self.reference = None
        self.calibration_id = None
        self.reference_reason = reason
        self.history.clear()
        self.raw_history.clear()
        if reset_fusion:
            self.fusion.reset()
            self.quaternion = IDENTITY

    def _restart(self, boot_id, reason):
        self.restarts += 1
        self.boot_id = boot_id
        self.last_sequence = self.last_device_us = self.unwrapped_device_us = None
        self.clock_offset_s = None
        self.stability.clear()
        self.begin_connection_quality()
        self.reset_reference(reason, reset_fusion=True)

    def consume(self, sample):
        """Return accepted sample record and events, or (None, events)."""
        events = []
        values = (*sample.accel, *sample.gyro, *sample.mag, sample.temperature, sample.aux_temperature,
                  sample.received_monotonic, sample.received_unix)
        if (not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values)
                or not sample.sensor_flags & 1 or norm(sample.accel) > 200
                or max(abs(v) for v in sample.gyro) > 4000):
            self.invalid_frames += 1
            self.last_error = "拒绝无效或超范围样本"
            return None, [{"type": "invalid_sample", "device_id": self.device_id, "reason": self.last_error}]
        incoming_boot = getattr(sample, "boot_id", None)
        if self.boot_id is not None and incoming_boot is not None and incoming_boot != self.boot_id:
            self._restart(incoming_boot, "启动会话改变：需重新初始化")
            events.append({"type": "device_restart", "device_id": self.device_id, "boot_id": incoming_boot})
        elif self.boot_id is None:
            self.boot_id = incoming_boot
        if sample.sequence is not None and self.last_sequence is not None:
            delta = (sample.sequence-self.last_sequence) % 2**32
            if delta == 0:
                self.duplicates += 1
                return None, events
            if delta >= 2**31:
                inferred_restart = (incoming_boot is None and sample.sequence < 1000 and self.last_sequence >= 10
                                    and sample.device_us is not None and self.last_device_us is not None
                                    and sample.device_us < self.last_device_us < 2**31)
                if inferred_restart:
                    self._restart(None, "旧协议疑似重启：需重新初始化")
                    events.append({"type": "inferred_restart", "device_id": self.device_id})
                else:
                    self.out_of_order += 1
                    self.invalid_frames += 1
                    return None, events + [{"type": "out_of_order", "device_id": self.device_id}]
            else:
                self.missing_frames += delta-1
        if self.latest_at is not None and sample.received_monotonic < self.latest_at:
            self.invalid_frames += 1
            return None, events + [{"type": "out_of_order_arrival", "device_id": self.device_id}]
        elapsed = None
        if sample.device_us is not None:
            if self.last_device_us is None:
                self.unwrapped_device_us = sample.device_us
            else:
                increment = (sample.device_us-self.last_device_us) % 2**32
                if increment >= 2**31:
                    # A discontinuous device clock invalidates the bias/reference
                    # even when sequence keeps increasing (old IMU2 has no boot
                    # ID). Do not retain a successful calibration indefinitely
                    # while rejecting every sample after a clock reset.
                    self._restart(incoming_boot,"设备时钟回退：需重新校准及中立初始化")
                    self.unwrapped_device_us = sample.device_us
                    events.append({"type":"clock_reference_reset","device_id":self.device_id})
                else:
                    elapsed = increment/1e6
                    self.unwrapped_device_us += increment
            observed_offset = sample.received_monotonic-self.unwrapped_device_us/1e6
            # Lower-envelope arrival offset, softly drifting. This measures an
            # approximate host timeline; no network-delay or hardware-sync claim.
            self.clock_offset_s = (observed_offset if self.clock_offset_s is None else
                                   min(observed_offset, self.clock_offset_s + .00001))
        if elapsed is not None and elapsed > self.config["timing"]["max_interpolation_gap_s"]:
            self.sampling_gaps += 1
            self.history.clear()
            self.stability.reset_window("采样中断")
            # Skip integration of unobserved movement; provider remains local.
            if hasattr(self.fusion, "last_time"):
                self.fusion.last_time = sample.received_monotonic
                self.fusion.last_device_us = sample.device_us
            events.append({"type": "sampling_gap", "device_id": self.device_id, "duration_s": elapsed})
        physical = replace(sample,mag=magnetometer.correct(sample.mag,self.magnetic_calibration)) if sample.sensor_flags & 2 else sample
        mapped = self.coordinates.sample(physical)
        was_calibrating = self.stability.calibrating
        calibrated_bias = self.stability.update(mapped)
        if was_calibrating and self.stability.phase == "failed":
            events.append({"type":"bias_calibration_timeout","device_id":self.device_id,"reason":self.stability.message})
        if calibrated_bias:
            self.reset_reference("陀螺零偏校准改变融合参考：需重新初始化", reset_fusion=True)
            events.append({"type": "bias_calibration_complete", "device_id": self.device_id})
        corrected = self.stability.corrected(mapped)
        if self.processing_settings["mode"] == "six_axis_relative":
            corrected = replace(corrected,sensor_flags=corrected.sensor_flags & ~2)
            self.stability.magnetic_used = False
            self.stability.magnetic_message = "六轴相对姿态：磁场仅显示，未用于航向；长期航向仍会漂移"
        else:
            corrected = self.stability.guard_magnetometer(corrected)
            if self.stability.magnetic_used and self.magnetic_calibration:
                self.stability.magnetic_message = "使用已标定磁场观测；局部磁参考，不等于地理真北"
        holding = self.stability_enabled and self.stability.stationary
        if holding:
            corrected = replace(corrected, gyro=(0., 0., 0.))
        try:
            q = quaternion(self.fusion.update(corrected, correction_scale=0. if holding else 1.))
        except (ValueError, ArithmeticError):
            self.invalid_frames += 1
            self.reset_reference("融合输出无效：需重新初始化", reset_fusion=True)
            return None, events + [{"type": "invalid_fusion", "device_id": self.device_id}]
        self.quaternion = q
        self.last_sample, self.mapped_sample = sample, mapped
        self.last_sequence, self.last_device_us = sample.sequence, sample.device_us
        self.latest_at, self.latest_unix = sample.received_monotonic, sample.received_unix
        self.valid_frames += 1
        if self._connection_start is None:
            self._connection_start = {"valid_frames": self.valid_frames-1,
                                      "missing_frames": self.missing_frames,
                                      "invalid_frames": self.invalid_frames,
                                      "first_sequence": sample.sequence,
                                      "started_unix": sample.received_unix}
        self.arrivals.append(self.latest_at)
        aligned_at = (self.unwrapped_device_us/1e6+self.clock_offset_s
                      if self.unwrapped_device_us is not None else self.latest_at)
        item = {"time": aligned_at, "arrival": self.latest_at, "quaternion": q, "boot_id": self.boot_id}
        self.history.append(item)
        self.raw_history.append((self.latest_at, q, mapped))
        return {"device_id": self.device_id, "body_slot": self.body_slot, "boot_id": self.boot_id,
                "source": self.source, "endpoint_id": self.primary_endpoint,
                "raw": asdict(sample), "mapped": asdict(mapped), "quaternion": q,
                "unwrapped_device_us": self.unwrapped_device_us, "aligned_monotonic": aligned_at,
                "fusion_version": self.fusion_version, "calibration_id": self.calibration_id,
                "magnetic_calibration": deepcopy(self.magnetic_calibration)}, events

    def aligned_quaternion(self, at):
        if not self.history:
            return self.quaternion
        before = None
        for item in self.history:
            if item["time"] <= at:
                before = item
                continue
            if before is None:
                return item["quaternion"]
            gap = item["time"]-before["time"]
            if (0 < gap <= self.config["timing"]["max_interpolation_gap_s"]
                    and item["boot_id"] == before["boot_id"]):
                return slerp(before["quaternion"], item["quaternion"], (at-before["time"])/gap)
            return before["quaternion"]
        return self.history[-1]["quaternion"]

    def world_quaternion(self, at):
        if self.reference is None:
            return None
        # R=A Q M; M=Q0^-1 A^-1 for the neutral identity bone frame.
        mount = multiply(inverse(self.reference), inverse(self.fusion_to_world))
        return multiply(multiply(self.fusion_to_world, self.aligned_quaternion(at)), mount)

    def snapshot(self, now):
        self.stability.expire(now)
        age = max(0., now-self.latest_at) if self.latest_at is not None else None
        recent = [t for t in self.arrivals if now-t <= 2]
        rate = (len(recent)-1)/(recent[-1]-recent[0]) if len(recent) > 1 and recent[-1] > recent[0] else 0.
        valid = self.connected and age is not None and age <= self.config["timing"]["stale_s"]
        sample = self.mapped_sample
        baseline = self._connection_start
        connection = {"has_samples": baseline is not None,
                      **{key: getattr(self, key)-baseline[key] if baseline else 0
                         for key in ("valid_frames", "missing_frames", "invalid_frames")},
                      "first_sequence": baseline["first_sequence"] if baseline else None,
                      "started_unix": baseline["started_unix"] if baseline else None}
        connection["loss_percent"] = (100*connection["missing_frames"] /
                                      max(1, connection["valid_frames"]+connection["missing_frames"])
                                      if baseline and self.last_sequence is not None else None)
        quality = {"rate_hz": rate, "age_ms": age*1000 if age is not None else None,
                   "connection": connection,
                   "valid_frames": self.valid_frames, "invalid_frames": self.invalid_frames,
                   "missing_frames": self.missing_frames, "duplicates": self.duplicates,
                   "duplicate_sources": self.duplicate_sources, "out_of_order": self.out_of_order,
                   "sampling_gaps": self.sampling_gaps, "restarts": self.restarts,
                   "sequence": self.last_sequence, "device_us": self.last_device_us,
                   "unwrapped_device_us": self.unwrapped_device_us,
                   "loss_percent": 100*self.missing_frames/max(1, self.valid_frames+self.missing_frames),
                   "clock_offset_s": self.clock_offset_s, "alignment": "approximate host-time, not hardware sync"}
        stability = {"calibrated": self.stability.calibrated, "calibrating": self.stability.calibrating,
                     "phase": self.stability.phase, "retries": self.stability.retries,
                     "enabled": self.stability_enabled,
                     "progress": self.stability.progress, "message": self.stability.message,
                     "quality": self.stability.calibration_quality, "gyro_bias_dps": self.stability.bias,
                     "magnetic_used": self.stability.magnetic_used,
                     "magnetic_message": self.stability.magnetic_message,
                     "holding": self.stability_enabled and self.stability.stationary and valid}
        return {"device_id": self.device_id, "body_slot": self.body_slot, "reported_slot": self.reported_slot,
                "binding_source": self.binding_source, "override": self.override,
                "unknown_slot": self.unknown_slot, "endpoint_id": self.primary_endpoint,
                "endpoint_ids": sorted(self.endpoint_ids), "boot_id": self.boot_id,
                "firmware_version": self.firmware_version, "config_version": self.config_version,
                "protocol_version": self.protocol_version, "identity_trusted": self.identity_trusted,
                "source": self.source, "quaternion": self.quaternion,
                "euler_deg": euler_degrees(self.quaternion), "accel": sample.accel if sample else (0.,)*3,
                "gyro": sample.gyro if sample else (0.,)*3, "mag": sample.mag if sample else (0.,)*3,
                "temperature": sample.temperature if sample else None,
                "aux_temperature": sample.aux_temperature if sample else None,
                "valid": valid, "connected": self.connected, "initialized": self.initialized,
                "reference": self.reference, "fusion_to_world": self.fusion_to_world,
                "mount_bone_to_sensor": multiply(inverse(self.reference), inverse(self.fusion_to_world)) if self.reference else None,
                "direction_calibration": self.direction_calibration,
                "reference_revision": self.reference_revision,
                "residual_gyro_dps": self.stability.corrected(sample).gyro if sample else None,
                "calibration_id": self.calibration_id, "reference_reason": self.reference_reason,
                "fusion_version": self.fusion_version, "coordinates": self.coordinates.payload(),
                "magnetic_calibration": deepcopy(self.magnetic_calibration),
                "processing_profile": self.processing_profile,
                "processing_settings": dict(self.processing_settings),
                "processing_config_version": self.attitude_config["config_version"],
                "sensor_flags": self.last_sample.sensor_flags if self.last_sample else None,
                "raw_sample": asdict(self.last_sample) if self.last_sample else None,
                "latest_unix": self.latest_unix, "latest_monotonic": self.latest_at,
                "quality": quality, "stability": stability, "last_error": self.last_error}
