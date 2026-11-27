"""USB VQF upper-arm/forearm validation window, bound to loopback only."""
import argparse
import json
from pathlib import Path
from queue import Empty, Full, Queue
import sys
from threading import Lock, Thread
from time import monotonic, sleep, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import serial

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'host'))
from dashboard.arm_vqf import ArmExperiment, LineFramer
from live_board_motion import parse, parse_fusion


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--upper',required=True)
    p.add_argument('--fore',required=True)
    p.add_argument('--upper-device',required=True)
    p.add_argument('--fore-device',required=True)
    p.add_argument('--port',type=int,default=8002)
    p.add_argument('--capture',type=Path,required=True)
    args = p.parse_args()
    if args.upper.upper() == args.fore.upper():
        p.error('两个节点不能使用同一串口')
    engine = ArmExperiment(dict(upper=args.upper_device,fore=args.fore_device))
    args.capture.parent.mkdir(parents=True,exist_ok=True)
    capture = args.capture.open('a',encoding='utf-8',buffering=65536)
    lock = Lock()
    records = Queue(maxsize=4096)
    capture_status = dict(dropped=0,error=None)

    def log(kind, **data):
        try:
            records.put_nowait(dict(kind=kind,unix=time(),monotonic=monotonic(),**data))
        except Full:
            capture_status['dropped'] += 1

    def write():
        while True:
            batch = []
            try:
                batch.append(records.get(timeout=.25))
            except Empty:
                pass
            while not records.empty() and len(batch) < 256:
                batch.append(records.get_nowait())
            try:
                capture.writelines(json.dumps(r)+'\n' for r in batch)
                capture.flush()
            except OSError as exc:
                capture_status['error'] = str(exc)

    def read(role, name):
        while True:
            try:
                with serial.Serial(name,115200,timeout=.2) as port:
                    framer = LineFramer()
                    while True:
                        chunk = port.read(min(4096,max(1,port.in_waiting)))
                        try:
                            rows = framer.feed(chunk)
                        except ValueError as exc:
                            with lock:
                                engine.nodes[role]['invalid'] += 1
                                engine.disconnect(role,str(exc))
                                log('invalid',role=role,message=str(exc))
                            continue
                        for row in rows:
                          with lock:
                            try:
                                if row.startswith('IMU3,'):
                                    fields = row.split(',')
                                    if len(fields) != 20:
                                        raise ValueError('IMU3 字段数不匹配')
                                    engine.metadata(role,fields[1],fields[4],fields[3])
                                    log('raw',role=role,line=row)
                                elif row.startswith('[MOTION1],'):
                                    item = parse(row)
                                    if item:
                                        engine.motion(role,item)
                                        log('motion',role=role,**item)
                                elif row.startswith('[FUSION1],'):
                                    item = parse_fusion(row)
                                    if item:
                                        accepted = engine.fusion(role,item,monotonic())
                                        log('fusion',role=role,accepted=accepted,**item)
                            except ValueError as exc:
                                engine.nodes[role]['invalid'] += 1
                                engine.disconnect(role,str(exc))
                                log('invalid',role=role,message=str(exc),line=row)
            except (serial.SerialException,OSError) as exc:
                with lock:
                    engine.disconnect(role,str(exc))
                    log('disconnect',role=role,message=str(exc))
                sleep(1)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):
            pass

        def do_GET(self):
            if self.path == '/api':
                with lock:
                    content = json.dumps(dict(**engine.payload(monotonic()),capture=dict(capture_status))).encode()
                kind = 'application/json'
            elif self.path in ('/','/arm_vqf.js'):
                name = 'arm_vqf.html' if self.path == '/' else 'arm_vqf.js'
                content = (ROOT/'host/web'/name).read_bytes()
                kind = 'text/html; charset=utf-8' if name.endswith('.html') else 'text/javascript; charset=utf-8'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type',kind)
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_POST(self):
            if self.path != '/reference':
                self.send_error(404)
                return
            if self.headers.get('Origin') != f'http://127.0.0.1:{args.port}':
                self.send_error(403)
                return
            try:
                length = int(self.headers.get('Content-Length','0'))
                if not 0 < length <= 2048:
                    raise ValueError('请求长度无效')
                data = json.loads(self.rfile.read(length))
                with lock:
                    engine.begin_reference(monotonic(),data['lengths'])
                    log('reference_begin',lengths=data['lengths'])
            except (ValueError,KeyError,TypeError) as exc:
                content = str(exc).encode('utf-8')
                self.send_response(400)
                self.send_header('Content-Type','text/plain; charset=utf-8')
                self.send_header('Content-Length',str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return
            self.send_response(204)
            self.end_headers()

    # Metrics/reference changes are logged independently of whether a browser is open.
    def metrics():
        previous = False
        while True:
            with lock:
                state = engine.payload(monotonic())
                if state['calibrated'] != previous:
                    previous = state['calibrated']
                    log('reference_state',reference=engine.reference,message=engine.message)
                log('arm',**state)
            sleep(.10)

    server = ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    with lock:
        log('session',upper_port=args.upper,fore_port=args.fore,upper_device=args.upper_device,
            fore_device=args.fore_device,lengths=engine.lengths,
            constraint='planar elbow -Y, 0..150 degrees; fixed shoulder; host-arrival interpolation')
    for role,name in (('upper',args.upper),('fore',args.fore)):
        Thread(target=read,args=(role,name),daemon=True).start()
    Thread(target=write,daemon=True).start()
    Thread(target=metrics,daemon=True).start()
    print(f'VQF arm: http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
