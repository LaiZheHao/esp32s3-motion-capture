"""Lossless versioned body sessions and indexed replay of saved display frames.

The bounded writer queue fails closed on overload; recordings never silently
downsample. Replay reads saved frames, never runs the current fusion algorithm.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from queue import Queue, Full
from threading import Thread
from time import monotonic, time
from time import sleep
from uuid import uuid4

SCHEMA = "imu-body-session/1"
FILES = ("metadata.json", "samples.jsonl", "body_frames.jsonl", "events.jsonl", "frame_index.jsonl")
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "recordings"
HISTORY_LIMIT = 30


def session_path(root, name):
    root = Path(root).resolve()
    folder = (root / name).resolve()
    if not name or folder.parent != root or not folder.is_dir():
        raise ValueError("记录会话不存在")
    return folder


def catalog(root=DEFAULT_ROOT):
    items = []
    root = Path(root)
    if not root.exists():
        return items
    for folder in root.iterdir():
        if not folder.is_dir() or folder.is_symlink():
            continue
        try:
            data = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("schema_version") == SCHEMA:
                items.append({"id": folder.name, "session": folder.name,
                              "status": data["status"], "duration_s": data.get("duration_s", 0),
                              "counts": data.get("counts", {}), "started_unix": data["started_unix"],
                              "source_types": data.get("source_types", []),
                              "calibration_protected": data.get("calibration_protected")})
        except (OSError, ValueError, KeyError):
            continue
    return sorted(items, key=lambda i: i["started_unix"], reverse=True)


class BodyRecorder:
    def __init__(self, root=DEFAULT_ROOT, capacity=32768):
        self.root, self.capacity = Path(root), capacity
        self.active = False
        self.session = None
        self.error = None
        self.counts = {}
        self._thread = None
        self._metadata_pending = False

    def start(self, snapshot):
        if self.active or self._thread is not None:
            raise ValueError("已有记录尚未停止保存")
        if len(catalog(self.root)) >= HISTORY_LIMIT:
            raise ValueError(f"历史记录已达 {HISTORY_LIMIT} 条，请先将旧会话移入回收站")
        self.root.mkdir(parents=True, exist_ok=True)
        self.session = datetime.now().strftime("%Y%m%d-%H%M%S-body-") + uuid4().hex[:8]
        self.folder = self.root / self.session
        self.folder.mkdir()
        self.started = monotonic()
        self.error = None
        self.counts = {"samples": 0, "body_frames": 0, "events": 0}
        self.meta = {"schema_version": SCHEMA, "body_frame_version": "body-frame/1",
                     "started_unix": time(), "started_utc": datetime.now(timezone.utc).isoformat(),
                     "status": "incomplete", "counts": self.counts,
                     "snapshot": deepcopy(snapshot), "source_types": [],
                     "replay_policy": "saved_body_frames_no_recomputation"}
        # The supplied snapshot contains no transport passwords. Do not accept
        # arbitrary connection configuration/secrets as recording metadata.
        self._metadata()
        self._queue = Queue(self.capacity)
        self._thread = Thread(target=self._write, name="body-recorder", daemon=True)
        self.active = True
        self._thread.start()
        self.append_event({"type": "recording_started", "session": self.session})
        return self.session

    def _metadata(self):
        target = self.folder / "metadata.json"
        temporary = self.folder / "metadata.json.tmp"
        temporary.write_text(json.dumps(self.meta, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        # Catalog/preview readers can briefly hold metadata.json on Windows.
        # Retry the atomic replacement, keeping the complete temporary file.
        for attempt in range(8):
            try:
                temporary.replace(target)
                self._metadata_pending = False
                return
            except PermissionError:
                if attempt == 7:
                    raise
                sleep(.025)

    def append(self, kind, data, elapsed=None):
        if not self.active:
            return False
        if self.error:
            self.active = False
            return False
        value = {"time_s": monotonic() - self.started if elapsed is None else elapsed,
                 "data": deepcopy(data)}
        try:
            self._queue.put_nowait((kind, value))
            return True
        except Full:
            self.error = "记录写入队列已满，停止记录；会话标记 incomplete"
            self.active = False
            return False

    def append_sample(self, data):
        source = data.get("source", "unknown")
        if self.active and source not in self.meta["source_types"]:
            self.meta["source_types"].append(source)
        return self.append("samples", data)

    def append_body_frame(self, data):
        return self.append("body_frames", data)

    def append_event(self, data):
        return self.append("events", data)

    def _write(self):
        handles = {}
        try:
            for kind in self.counts:
                handles[kind] = (self.folder / (kind + ".jsonl")).open("wb")
            with (self.folder / "frame_index.jsonl").open("wb") as index:
                while True:
                    entry = self._queue.get()
                    if entry is None:
                        break
                    kind, value = entry
                    if kind == "body_frames" and self.counts[kind] % 128 == 0:
                        index.write((json.dumps({"time_s": value["time_s"], "offset": handles[kind].tell()}) + "\n").encode())
                    handles[kind].write((json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8"))
                    self.counts[kind] += 1
        except Exception as exc:
            self.error = f"记录写入失败：{exc}"
            self.active = False
        finally:
            for handle in handles.values():
                try:
                    handle.close()
                except Exception as exc:
                    self.error = f"记录刷新失败：{exc}"
                    self.active = False

    def stop(self):
        if self._thread is None:
            return
        self.active = False
        # Let the worker drain before final metadata and never discard queued
        # samples. A failed worker must not leave a blocking queue.put behind.
        while self._thread.is_alive():
            try:
                self._queue.put(None, timeout=.1)
                break
            except Full:
                continue
        self._thread.join()
        self.meta.update(status="incomplete" if self.error else "complete",
                         error=self.error, duration_s=monotonic()-self.started)
        self.meta["counts"] = dict(self.counts)
        self._metadata_pending = True
        try:
            self._metadata()
        except (OSError, ValueError) as exc:
            self.error = f"记录元数据保存失败，不能视为完整会话：{exc}"
            self.meta.update(status="incomplete",error=self.error)
        finally:
            self._thread = None

    @property
    def busy(self):
        return self.active or self._thread is not None

    def payload(self):
        return {"active": self.active, "saving": self.busy and not self.active, "session": self.session,
                "counts": dict(self.counts), "error": self.error}


class BodyReplay:
    def __init__(self, root=DEFAULT_ROOT):
        self.root = Path(root)
        self.session = None
        self.playing = False
        self.time_s = self.duration = 0.
        self.current = None
        self._handle = None
        self._next = None

    def open(self, session):
        self.close()
        try:
            return self._open(session)
        except Exception:
            self.close()
            raise

    def _open(self, session):
        folder = session_path(self.root, session)
        self.metadata = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
        if self.metadata.get("schema_version") != SCHEMA:
            raise ValueError("不是完整骨架帧格式；旧 CSV 仅通过原预览接口查看")
        if not self.metadata.get("counts", {}).get("body_frames"):
            raise ValueError("会话没有骨架帧")
        self._handle = (folder / "body_frames.jsonl").open("rb")
        index_path = folder / "frame_index.jsonl"
        self.index = [json.loads(line) for line in index_path.read_text(encoding="utf-8").splitlines() if line] if index_path.exists() else []
        # Scan only the last indexed block to learn exact final frame time.
        self._handle.seek(self.index[-1]["offset"] if self.index else 0)
        last = None
        for line in self._handle:
            last = json.loads(line)
        self.duration = last["time_s"] if last else 0.
        self.session = session
        self.seek(0)

    def seek(self, value):
        if not self.session:
            raise ValueError("尚未加载回放")
        value = float(value)
        if not __import__("math").isfinite(value):
            raise ValueError("回放时间无效")
        value = min(self.duration, max(0., value))
        offset = 0
        for entry in self.index:
            if entry["time_s"] > value:
                break
            offset = entry["offset"]
        self._handle.seek(offset)
        self.current = self._next = None
        while line := self._handle.readline():
            item = json.loads(line)
            if self.current is not None and item["time_s"] > value:
                self._next = item
                break
            self.current = item
        self.time_s = value
        self._wall = monotonic()
        return self.frame()

    def frame(self):
        return deepcopy(self.current["data"]) if self.current else None

    def advance(self):
        if not self.playing or not self.session:
            return self.frame()
        now = monotonic()
        self.time_s = min(self.duration, self.time_s + now - self._wall)
        self._wall = now
        while self._next and self._next["time_s"] <= self.time_s:
            self.current = self._next
            line = self._handle.readline()
            self._next = json.loads(line) if line else None
        if self.time_s >= self.duration:
            self.playing = False
        return self.frame()

    def play(self):
        if not self.session:
            raise ValueError("尚未加载回放")
        self._wall = monotonic()
        self.playing = True

    def close(self):
        if self._handle:
            self._handle.close()
        self._handle = None
        self.session = None
        self.playing = False
        self.current = self._next = None
        self.time_s = self.duration = 0.

    def payload(self):
        return {"session": self.session, "time_s": self.time_s, "duration": self.duration, "playing": self.playing}
