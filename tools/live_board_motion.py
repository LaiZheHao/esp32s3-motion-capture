"""Display board-computed motion telemetry; owns one USB port, loopback only."""
import argparse
import json
import math
from pathlib import Path
from queue import Queue
from threading import Thread, Lock
from time import monotonic, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import serial


def parse(line):
    fields = line.strip().split(',')
    if len(fields) != 18 or fields[0] != '[MOTION1]':
        return None
    values = list(map(float, fields[6:]))
    if not all(math.isfinite(v) for v in values):
        raise ValueError('nonfinite board telemetry')
    return dict(sequence=int(fields[1]), device_us=int(fields[2]), ready=fields[3]=='1',
                holding=fields[4]=='1', calibration_samples=int(fields[5]),
                raw_accel=values[:3], linear_accel=values[3:6], velocity=values[6:9], position=values[9:12])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True)
    parser.add_argument('--port',type=int,default=8001)
    parser.add_argument('--capture',type=Path)
    args=parser.parse_args()
    state={'connected':False,'message':'等待串口','frames':0}
    commands=Queue(maxsize=8);lock=Lock()
    capture=None
    if args.capture:
        args.capture.parent.mkdir(parents=True,exist_ok=True)
        capture=args.capture.open('a',encoding='utf-8',buffering=1)
    def read():
        while True:
            try:
                with serial.Serial(args.serial,115200,timeout=.2,write_timeout=.2) as port:
                    with lock:state.update(connected=True,message='已连接 '+args.serial)
                    while True:
                        while not commands.empty():port.write(commands.get_nowait())
                        line=port.readline().decode('utf-8',errors='replace')
                        if line.startswith('IMU3,'):
                            f=line.split(',')
                            if len(f)==20:
                                with lock:state.update(device=f[1],firmware=f[4],boot=f[3])
                        item=parse(line)
                        if item:
                            now=monotonic()
                            with lock:state.update(item,received=now,frames=state['frames']+1,message='板端积分中' if item['ready'] else '请静置约2秒，建立零偏基线')
                            if capture:capture.write(json.dumps({'unix':time(),**item})+'\n')
            except (serial.SerialException,OSError,ValueError) as exc:
                with lock:state.update(connected=False,message=str(exc))
                from time import sleep
                sleep(1)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_GET(self):
            if self.path=='/api':
                with lock:
                    data=dict(state);data['age_s']=monotonic()-data.get('received',0);data['valid']=data['connected'] and data['age_s']<.5
                content=json.dumps(data).encode();kind='application/json'
            elif self.path=='/':
                content=(Path(__file__).resolve().parents[1]/'host/web/live_board_motion.html').read_bytes();kind='text/html; charset=utf-8'
            else:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
        def do_POST(self):
            mapping={'/reset':b'R','/zupt-on':b'Z','/zupt-off':b'N'}
            if self.path not in mapping:self.send_error(404);return
            # Only same-origin local UI may issue board commands.
            if self.headers.get('Origin')!=f'http://127.0.0.1:{args.port}':self.send_error(403);return
            if commands.full():self.send_error(429);return
            commands.put_nowait(mapping[self.path]);self.send_response(204);self.end_headers()
    Thread(target=read,daemon=True).start()
    print(f'Board motion: http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()


if __name__=='__main__':main()
