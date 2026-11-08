"""Session protection and the project view of the Windows Recycle Bin."""
from contextlib import contextmanager
import json
from os.path import lexists
from pathlib import Path
import re
import stat
import sys
from tempfile import NamedTemporaryFile
from time import monotonic, sleep

from .body_recording import HISTORY_LIMIT, SCHEMA, catalog


TRASH_LIMIT = 20
SESSION_ID = re.compile(r"\d{8}-\d{6}-body-[0-9a-f]{8}")


class SessionConflict(ValueError):
    pass


def _metadata(folder):
    data = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA:
        raise ValueError("无效的会话元数据")
    return data


def history(root):
    items = catalog(root)
    references = {item["id"]: [] for item in items}
    for item in items:
        try:
            report = json.loads((root / item["id"] / "single_node_motion_summary.json").read_text(encoding="utf-8"))
            faces = report.get("face_sessions", {})
            if isinstance(faces, dict):
                for name in set(value for value in faces.values() if isinstance(value, str)):
                    if name in references:
                        references[name].append(item["id"])
        except (OSError, ValueError, AttributeError):
            continue
    for item in items:
        item["referenced_by"] = references[item["id"]]
        if item["calibration_protected"] is None:
            item["calibration_protected"] = bool(item["referenced_by"])
    return items


def _session_folder(root, session):
    if not SESSION_ID.fullmatch(session):
        raise FileNotFoundError("会话不存在")
    folder = root.resolve() / session
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise FileNotFoundError("会话必须是记录目录内的实际子目录")
    try:
        _metadata(folder)
    except (ValueError, FileNotFoundError) as exc:
        raise FileNotFoundError("会话元数据不存在或无效") from exc
    return folder


def set_calibration(root, session, protected):
    folder = _session_folder(root, session)
    metadata = _metadata(folder)
    metadata["calibration_protected"] = protected
    content = json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False)
    with NamedTemporaryFile(dir=folder, prefix=".metadata-", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(folder / "metadata.json")
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _windows_com():
    if sys.platform != "win32":
        raise OSError("回收站功能需要在 Windows 上运行")
    try:
        import pythoncom
        import pywintypes
    except ImportError as exc:
        raise OSError("请安装新版上位机依赖 pywin32 后重启开发台") from exc
    pythoncom.CoInitialize()
    try:
        yield pythoncom
    except pywintypes.com_error as exc:
        raise OSError(exc.strerror or "Windows 回收站操作失败") from exc
    finally:
        pythoncom.CoUninitialize()


def _project_items(root):
    from win32com.client import Dispatch

    recycle_bin = Dispatch("Shell.Application").NameSpace(10)
    if recycle_bin is None:
        raise OSError("Windows 回收站不可访问")
    root = root.resolve()
    for item in recycle_bin.Items():
        name = item.Name
        if not isinstance(name, str) or not SESSION_ID.fullmatch(name) or not item.IsFolder:
            continue
        original = item.ExtendedProperty("System.Recycle.DeletedFrom")
        if not isinstance(original, str) or Path(original) != root:
            continue
        yield item, name, Path(item.Path)


def trash_catalog(root):
    with _windows_com():
        items = []
        for item, session, stored in _project_items(root):
            try:
                metadata = _metadata(stored)
            except (OSError, ValueError):
                metadata = {}
            deleted = item.ExtendedProperty("System.Recycle.DateDeleted")
            items.append({
                "trash_id": stored.name, "id": session, "started_unix": metadata.get("started_unix"),
                "counts": metadata.get("counts", {}),
                "deleted_at": deleted.isoformat() if hasattr(deleted, "isoformat") else None,
            })
        return sorted(items, key=lambda entry: entry["deleted_at"] or "", reverse=True)


def recycle(root, session):
    folder = _session_folder(root, session)
    entry = next((item for item in history(root) if item["id"] == session), None)
    if entry is None:
        raise FileNotFoundError("会话不存在")
    if entry["calibration_protected"]:
        raise SessionConflict("标定会话受保护，请先解除标定保护")
    with _windows_com() as com:
        if sum(1 for _ in _project_items(root)) >= TRASH_LIMIT:
            raise SessionConflict(f"回收站已达 {TRASH_LIMIT} 条，请先还原或在 Windows 回收站处理旧会话")
        from win32com.shell import shell, shellcon

        operation = com.CoCreateInstance(shell.CLSID_FileOperation, None, com.CLSCTX_INPROC_SERVER,
                                         shell.IID_IFileOperation)
        recycle_on_delete = 0x00080000  # FOFX_RECYCLEONDELETE (Windows 8+)
        operation.SetOperationFlags(recycle_on_delete | shellcon.FOFX_EARLYFAILURE |
                                    shellcon.FOF_NOERRORUI | shellcon.FOF_SILENT)
        item = shell.SHCreateItemFromParsingName(str(folder), None, shell.IID_IShellItem)
        operation.DeleteItem(item, None)
        operation.PerformOperations()
        if operation.GetAnyOperationsAborted() or folder.exists():
            raise OSError("Windows 未能将会话移入回收站")


def restore(root, trash_id):
    with _windows_com():
        for item, session, stored in _project_items(root):
            if stored.name == trash_id:
                destination = root.resolve() / session
                if lexists(destination):
                    raise SessionConflict("历史中已存在同名会话，请先处理同名记录")
                if len(catalog(root)) >= HISTORY_LIMIT:
                    raise SessionConflict(f"历史记录已达 {HISTORY_LIMIT} 条，请先腾出位置")
                item.InvokeVerb("undelete")
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    if destination.is_dir() and not stored.exists():
                        return session
                    sleep(.1)
                raise OSError("尚未确认 Windows 回收站还原完成，请刷新后查看")
    raise FileNotFoundError("回收站中找不到该会话")
