"""Two board-attitude streams and an explicit planar elbow experiment.

The shoulder is fixed. Bone positions come from forward kinematics, never
accelerometer double integration. Host arrival interpolation is not hardware
synchronization. A neutral reference assumes both sensor +X axes face forward.
"""
from collections import deque
import math

from .body_math import IDENTITY, angle_degrees, inverse, mean, multiply, rotate, slerp


ROLES = ('upper', 'fore')


class LineFramer:
    """Serial reads may end mid-line on timeout; keep the incomplete tail."""
    def __init__(self):
        self.tail = b''

    def feed(self, chunk):
        parts = (self.tail+chunk).split(b'\n')
        self.tail = parts.pop()
        if len(self.tail) > 1024 or any(len(p) > 1024 for p in parts):
            self.tail = b''
            raise ValueError('串口行超过长度限制')
        return [p.decode('utf-8',errors='replace').strip() for p in parts]


def solve_arm(upper, fore, lengths=(.30, .26)):
    relative = multiply(inverse(upper), fore)
    # Closest twist about bone-local -Y; this intentionally removes pronation
    # and out-of-plane motion for a controlled planar-flexion trial.
    w, _, y, _ = relative
    singular = math.hypot(w, y) < 1e-6
    flex = None if singular else (-math.degrees(2*math.atan2(y, w))+180) % 360-180
    limited = 0. if flex is None else min(150., max(0., flex))
    a = math.radians(limited)/2
    hinge = (math.cos(a), 0., -math.sin(a), 0.)
    constrained = multiply(upper, hinge)
    elbow = rotate((0, 0, -lengths[0]), upper)
    def wrist(q):
        offset = rotate((0, 0, -lengths[1]), q)
        return tuple(x+y for x, y in zip(elbow, offset))
    raw_wrist, limited_wrist = wrist(fore), wrist(constrained)
    u, f = rotate((0, 0, -1), upper), rotate((0, 0, -1), fore)
    return dict(shoulder=(0, 0, 0), elbow=elbow, raw_wrist=raw_wrist,
                constrained_wrist=limited_wrist, relative_quaternion=relative,
                flexion_deg=math.degrees(math.acos(min(1., max(-1., sum(x*y for x,y in zip(u,f)))))),
                hinge_deg=flex, limited_hinge_deg=limited, hinge_singular=singular,
                removed_rotation_deg=angle_degrees(relative, hinge),
                wrist_difference_m=math.dist(raw_wrist, limited_wrist))


class ArmExperiment:
    def __init__(self, identities):
        if set(identities) != set(ROLES) or len(set(identities.values())) != 2:
            raise ValueError('需要两个不同设备')
        self.nodes = {role: dict(expected=identities[role], connected=False, ready=False,
                                history=deque(maxlen=300), frames=0, missing=0,
                                invalid=0, last_sequence=None) for role in ROLES}
        self.reference = None
        self.calibration = None
        self.message = '等待两节点；佩戴后采集中立姿态'
        self.lengths = (.30, .26)

    def clear_reference(self, reason):
        self.reference = self.calibration = None
        self.message = reason

    def disconnect(self, role, message):
        n = self.nodes[role]
        n['connected'] = n['ready'] = False
        n['history'].clear()
        n['device'] = None
        n['last_sequence'] = None
        n['message'] = message
        self.clear_reference('节点断开：重新连接、佩戴后须重新采集中立姿态')

    def metadata(self, role, device, firmware, boot):
        n = self.nodes[role]
        if device != n['expected'] or not firmware.startswith('imu-slime-vqf-'):
            raise ValueError('设备身份或 VQF 固件不匹配：'+device+' / '+firmware)
        if n.get('boot') is not None and n['boot'] != boot:
            n['history'].clear()
            n['ready'] = False
            n['last_sequence'] = None
            self.clear_reference('检测到板卡重启：须重新采集中立姿态')
        n.update(device=device, firmware=firmware, boot=boot, connected=True, message='已连接')

    def motion(self, role, data):
        n = self.nodes[role]
        if n['ready'] and not data['ready']:
            n['history'].clear()
            n['last_sequence'] = None
            self.clear_reference('板端融合重新校准：须重新采集中立姿态')
        n['ready'] = data['ready']
        n['linear_accel'] = data['linear_accel']

    def fusion(self, role, data, now):
        n = self.nodes[role]
        if not n.get('device') or not n['ready']:
            return False
        previous = n['last_sequence']
        if previous is not None:
            step = (data['sequence']-previous) & 0xffffffff
            if step == 0:
                return False
            if step > 0x80000000:
                n['history'].clear()
                self.clear_reference('序号回退：须重新采集中立姿态')
            else:
                n['missing'] += max(0, step//4-1)
        n.update(last_sequence=data['sequence'], received=now, frames=n['frames']+1,
                 gyro_bias_dps=data['gyro_bias_dps'], rest=data['rest'],
                 quaternion=data['quaternion'], device_us=data['device_us'])
        n['history'].append((now, tuple(data['quaternion']), data['rest']))
        return True

    def begin_reference(self, now, lengths):
        if len(lengths) != 2 or any(isinstance(x,bool) or not isinstance(x,(int,float))
                                   or not math.isfinite(x) or not .10 <= x <= .60 for x in lengths):
            raise ValueError('骨长须为 0.10–0.60 米')
        if any(not n['connected'] or not n['ready'] or not n.get('rest')
               or now-n.get('received',-100) > .20 for n in self.nodes.values()):
            raise ValueError('两节点需在线并静止，等待板端 VQF 静止判定后重试')
        self.reference = None
        self.lengths = tuple(lengths)
        self.calibration = now
        self.message = '采集中立姿态：请保持肘伸直、手臂下垂约 1.2 秒'

    def _finish_reference(self, now):
        if self.calibration is None or now-self.calibration < 1.2:
            return
        result = {}
        for role, n in self.nodes.items():
            samples = [s for s in n['history'] if s[0] >= self.calibration]
            if len(samples) < 20 or any(not s[2] for s in samples) or now-n.get('received',-100) > .2:
                self.clear_reference('中立采集失败：两节点须持续静止且数据新鲜')
                return
            q = mean([s[1] for s in samples])
            if max(angle_degrees(q,s[1]) for s in samples) > 3:
                self.clear_reference('中立采集失败：姿态变化超过 3°')
                return
            x, y, _ = rotate((1,0,0),q)
            if math.hypot(x,y) < .7:
                self.clear_reference('请调整佩戴：中立姿态时两板 +X 轴须水平朝身体正前方')
                return
            yaw = -math.atan2(y,x)/2
            result[role] = (q, (math.cos(yaw),0,0,math.sin(yaw)))
        self.reference = result
        self.calibration = None
        self.message = '中立参考已建立；可进行缓慢平面屈肘试验'

    def payload(self, now):
        self._finish_reference(now)
        nodes = {}
        for role, n in self.nodes.items():
            nodes[role] = {k:v for k,v in n.items() if k != 'history'}
            nodes[role]['age_s'] = max(0.,now-n['received']) if 'received' in n else None
            nodes[role]['valid'] = n['connected'] and n['ready'] and now-n.get('received',-100) < .5
        # Never extrapolate or continue spinning on missing data.
        at, aligned = now-.08, {}
        for role,n in self.nodes.items():
            history = list(n['history'])
            for left,right in zip(history,history[1:]):
                if left[0] <= at <= right[0] and 0 < right[0]-left[0] <= .20:
                    aligned[role] = slerp(left[1],right[1],(at-left[0])/(right[0]-left[0]))
                    break
        valid = all(n['valid'] for n in nodes.values()) and len(aligned) == 2
        solution = None
        if valid and self.reference:
            bones = {}
            for role in ROLES:
                ref, heading = self.reference[role]
                bones[role] = multiply(multiply(multiply(heading,aligned[role]),inverse(ref)),inverse(heading))
            solution = solve_arm(bones['upper'],bones['fore'],self.lengths)
        return dict(nodes=nodes, valid=valid, calibrated=self.reference is not None,
                    calibrating=self.calibration is not None, message=self.message,
                    lengths=self.lengths, solution=solution, display_delay_s=.08,
                    latest_arrival_skew_s=abs(self.nodes['upper'].get('received',0)-self.nodes['fore'].get('received',0)) if all('received' in n for n in self.nodes.values()) else None)
