from pathlib import Path
import asyncio
import json
import os
from contextlib import asynccontextmanager
from serial.tools import list_ports

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState
from pydantic import StrictBool

from .service import Runtime
from .body_runtime import BodyRuntime
from .body_config import load_config
from .body_engine import BodyEngine
from . import body_recording, session_library
from .segment_displacement import MOTION_CSV_NAME
from .recordings import RecordingNotFound, catalog, preview_csv, safe_item, session_zip, replay_data


ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "web"
runtime = Runtime()
body_runtime = BodyRuntime(engine=BodyEngine(load_config(os.environ.get("IMU_BODY_CONFIG"))))


@asynccontextmanager
async def lifespan(app):
    await runtime.start()
    await body_runtime.start()
    try:
        yield
    finally:
        try:
            await runtime.close()
        finally:
            await body_runtime.close()


app = FastAPI(title="IMU 动作捕捉开发台", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/api/body")
async def body_status():
    return body_runtime.payload()


@app.get("/api/body/recordings")
async def body_sessions():
    items = await asyncio.to_thread(session_library.history, body_runtime.recorder.root)
    for item in items:
        item["busy_reason"] = body_runtime.session_busy_reason(item["id"])
    return {"items": items, "limit": body_recording.HISTORY_LIMIT}


async def _session_operation(operation, *args):
    try:
        return await operation(*args)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except session_library.SessionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.delete("/api/body/recordings/{session}", status_code=204)
async def recycle_body_session(session: str):
    await _session_operation(body_runtime.recycle_session, session)


@app.put("/api/body/recordings/{session}/calibration", status_code=204)
async def protect_body_session(session: str, protected: StrictBool = Body(embed=True)):
    await _session_operation(body_runtime.protect_session, session, protected)


@app.get("/api/body/trash")
async def body_trash():
    items = await _session_operation(asyncio.to_thread, session_library.trash_catalog, body_runtime.recorder.root)
    return {"items": items, "limit": session_library.TRASH_LIMIT}


@app.put("/api/body/trash/{trash_id}/restore")
async def restore_body_session(trash_id: str):
    return {"session": await _session_operation(body_runtime.restore_session, trash_id)}


@app.get("/api/body/recordings/{session}/motion-csv")
async def body_motion_csv(session: str):
    try:
        folder = body_recording.session_path(body_runtime.recorder.root, session)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    result = (folder / MOTION_CSV_NAME).resolve()
    if result.parent != folder or not result.is_file():
        raise HTTPException(status_code=404, detail="该会话尚无单节点运动结果，请先运行 tools/measure_displacement.py")
    return FileResponse(result, media_type="text/csv", filename=f"{session}-{MOTION_CSV_NAME}")


@app.get("/api/body/recordings/{session}/download")
async def body_session_download(session: str):
    if body_runtime.recorder.active and session == body_runtime.recorder.session:
        raise HTTPException(status_code=409, detail="请先停止记录")
    try:
        folder = body_recording.session_path(body_runtime.recorder.root, session)
        import io
        import zipfile
        def archive_session():
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for name in body_recording.FILES:
                    path = (folder / name).resolve()
                    if path.parent == folder and path.is_file():
                        archive.write(path, arcname=f"{session}/{name}")
            return output.getvalue()
        content = await asyncio.to_thread(archive_session)
        return Response(content, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{session}.zip"'})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.websocket("/ws/body")
async def body_websocket(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json(body_runtime.payload())
    body_runtime.clients.add(websocket)
    try:
        while websocket.application_state == WebSocketState.CONNECTED:
            try:
                await body_runtime.command(await websocket.receive_json())
            except (json.JSONDecodeError, ValueError):
                body_runtime.message = "无法解析命令 JSON"
    except WebSocketDisconnect:
        pass
    finally:
        body_runtime.clients.discard(websocket)


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
async def status():
    return runtime.payload()


@app.get("/api/recordings")
async def recordings():
    return {"items": await asyncio.to_thread(catalog), "active": runtime.record_path if runtime.recording else None}


@app.get("/api/ports")
async def ports():
    devices = await asyncio.to_thread(list_ports.comports)
    return {"items": [{"device": p.device, "description": p.description} for p in devices]}


@app.get("/api/recordings/{session}/replay")
async def recording_replay(session: str):
    if runtime.recording and Path(runtime.record_path).name == session:
        raise HTTPException(status_code=409, detail="请先停止记录再回放")
    try:
        return await asyncio.to_thread(replay_data, session)
    except RecordingNotFound:
        raise HTTPException(status_code=404, detail="记录不存在")


@app.get("/api/recordings/{session}/preview")
async def recording_preview(session: str, file: str, limit: int = 100):
    try:
        return await asyncio.to_thread(preview_csv, session, file, limit)
    except RecordingNotFound:
        raise HTTPException(status_code=404, detail="记录文件不存在")


@app.get("/api/recordings/{session}/download")
async def recording_download(session: str):
    active_name = Path(runtime.record_path).name if runtime.recording and runtime.record_path else None
    if session == active_name:
        raise HTTPException(status_code=409, detail="请先停止记录再导出")
    try:
        item = safe_item(session)
        if item.is_file() and item.suffix.lower() == ".jsonl":
            return FileResponse(item, filename=item.name, media_type="application/x-ndjson")
        content = await asyncio.to_thread(session_zip, session)
        return Response(content, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{session}.zip"'})
    except RecordingNotFound:
        raise HTTPException(status_code=404, detail="记录会话不存在")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json(runtime.payload())
    runtime.clients.add(websocket)
    try:
        while websocket.application_state == WebSocketState.CONNECTED:
            try:
                await runtime.command(await websocket.receive_json())
            except (json.JSONDecodeError, ValueError):
                runtime.message = "无法解析命令 JSON"
    except WebSocketDisconnect:
        pass
    finally:
        runtime.clients.discard(websocket)
