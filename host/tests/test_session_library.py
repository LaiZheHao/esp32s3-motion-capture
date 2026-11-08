from contextlib import nullcontext
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from dashboard import session_library
from dashboard.app import app
from dashboard.body_recording import HISTORY_LIMIT, SCHEMA, BodyRecorder
from dashboard.body_runtime import BodyRuntime


def saved_session(root, index):
    folder = root / f"20261108-100000-body-{index:08x}"
    folder.mkdir()
    metadata = {"schema_version": SCHEMA, "status": "complete", "started_unix": index,
                "counts": {"samples": 123, "body_frames": 1}}
    (folder / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (folder / "body_frames.jsonl").write_text('{"time_s": 0, "data": {}}\n', encoding="utf-8")
    return folder


class SessionLibraryTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def test_recording_and_restore_refuse_at_history_limit(self):
        for index in range(HISTORY_LIMIT):
            saved_session(self.root, index)
        with self.assertRaisesRegex(ValueError, "30"):
            BodyRecorder(self.root).start({})
        entry = SimpleNamespace(InvokeVerb=lambda _: self.fail("must not invoke restore"))
        with patch.object(session_library, "_windows_com", return_value=nullcontext()), \
                patch.object(session_library, "_project_items", return_value=[
                    (entry, "20261108-100000-body-ffffffff", Path("$RABCDEF"))
                ]):
            with self.assertRaisesRegex(session_library.SessionConflict, "30"):
                session_library.restore(self.root, "$RABCDEF")

    def test_recycle_refuses_at_trash_limit_and_preserves_folder(self):
        folder = saved_session(self.root, 1)
        with patch.object(session_library, "_windows_com", return_value=nullcontext()), \
                patch.object(session_library, "_project_items", return_value=[None] * session_library.TRASH_LIMIT):
            with self.assertRaisesRegex(session_library.SessionConflict, "20"):
                session_library.recycle(self.root, folder.name)
        self.assertTrue(folder.is_dir())

    def test_calibration_references_are_protected_until_explicitly_unmarked(self):
        calibration = saved_session(self.root, 1)
        motion = saved_session(self.root, 2)
        (motion / "single_node_motion_summary.json").write_text(
            json.dumps({"face_sessions": {"+X": calibration.name}}), encoding="utf-8")
        with self.assertRaisesRegex(session_library.SessionConflict, "标定"):
            session_library.recycle(self.root, calibration.name)
        session_library.set_calibration(self.root, calibration.name, False)
        entry = next(item for item in session_library.history(self.root) if item["id"] == calibration.name)
        self.assertFalse(entry["calibration_protected"])
        self.assertEqual(entry["referenced_by"], [motion.name])

    def test_delete_endpoint_checks_recording_saving_and_paused_replay(self):
        folder = saved_session(self.root, 1)
        runtime = BodyRuntime(recording_dir=self.root)
        url = f"/api/body/recordings/{folder.name}"
        client = TestClient(app)
        self.addCleanup(client.close)
        with patch("dashboard.app.body_runtime", runtime), patch.object(session_library, "recycle") as recycle:
            runtime.recorder.session = folder.name
            runtime.recorder.active = True
            try:
                self.assertEqual(client.delete(url).status_code, 409)
            finally:
                runtime.recorder.active = False
            runtime.recorder._thread = object()
            try:
                self.assertEqual(client.delete(url).status_code, 409)
            finally:
                runtime.recorder._thread = None
            runtime.replay.open(folder.name)
            self.assertFalse(runtime.replay.playing)
            self.assertEqual(client.delete(url).status_code, 409)
            recycle.assert_not_called()
            runtime.replay.close()
            self.assertEqual(client.delete(url).status_code, 204)
            recycle.assert_called_once_with(self.root, folder.name)

    def test_invalid_session_cannot_reach_windows_shell(self):
        with patch.object(session_library, "_windows_com") as windows_com:
            with self.assertRaises(FileNotFoundError):
                session_library.recycle(self.root, "../elsewhere")
        windows_com.assert_not_called()
