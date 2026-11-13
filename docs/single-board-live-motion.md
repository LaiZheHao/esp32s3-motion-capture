# 单板板端实时位移实验（2026-11-14）

实板：COM6，ESP32-S3，MAC `98:C3:77:60:9B:14`，设备 `imu_149B6077C398`。已烧录 `imu-motion-usb-20261114-r1`，Flash 写入哈希校验成功。USB 由专用显示服务占用，不要同时从原开发台打开该串口。

## 使用

```powershell
# 仓库根目录，先安装现有 host/requirements.txt
host/.venv/Scripts/python.exe -B -X utf8 tools/live_board_motion.py --serial COM6 --port 8001 --capture host/hardware_tests/single-motion-20261114/live.jsonl
```

打开 http://127.0.0.1:8001/ 。显示板端三轴相对位移（米）、速度、去重力线加速度及含重力原始加速度（m/s²）。断流 0.5 秒后显示失效，不继续显示为有效测量。图保留最近约 30 秒收到的显示点，不是原始100 Hz数据导出。

上电后或点击“重新置零并静置校准”，保持板子不动约2秒；记录加速度和角速度均值与方差，基线通过后开始积分。起点位置、速度设零，Z 向上，水平航向相对起点。独立实验不设置人体安装槽位（上报 unassigned），按MAC维持身份。

板端：100 Hz 积分，25 Hz USB附加遥测。对陀螺仪零偏修正、四元数积分、低增益重力倾角修正、去重力、梯形积分速度和位置。不使用磁力计作为航向参考，航向仍会漂移。现有默认固件编译环境、IMU3格式、TCP/Wi-Fi收发实现保留，新增逻辑仅在独立 `esp32-s3-motion-usb` 环境开启。

可选“静止速度约束”使用角速度、重力模长及相邻加速度变化检测静止候选。它不是外部静止证明，可能抹掉真实匀速运动。固件上电默认关闭；本次静置验证手动开启，当前窗口保留开启状态。重置按钮重新发送当前窗口的约束选择，避免固件复位后模式不一致。刷新窗口不会自动读取已启用状态，若界面选择和实际保持状态不一致，请切换该选项确认模式；复位/重上电也需重新设置。

这不是可靠绝对定位。未约束状态下已观察到静止积分明显漂移，误差会随时间累积。短距离测量请从静止起步，限制单次时长，用外部尺量验证，不能根据静止约束保持零点就宣称毫米或厘米精度。姿态变化、温漂、匀速误判、加速度零偏会影响结果。

## 编译和烧录

```powershell
cd firmware
C:/.platformio/penv/Scripts/pio.exe run -e esp32-s3-motion-usb
C:/.platformio/penv/Scripts/pio.exe run -e esp32-s3-motion-usb -t upload --upload-port COM6
```

烧录前退出串口显示服务。本次编译通过：RAM 49,460 / 327,680 字节，程序区 736,405 / 1,310,720 字节。应用源码使用 `-Wall -Wextra -Werror`。

烧录前4MB完整备份（仅本机忽略目录，不提交）：`host/hardware_tests/single-motion-20261114/before-flash.bin`，SHA256 `F3EE291BE709957B963761FC4227BD1D3068A667B9E433920D97D176BF5029AC`。恢复会恢复该板旧r3固件及备份时的本地配置；不要将备份上传到仓库，因为可能包含网络凭据。

## 本次验证

- 芯片身份与MAC已通过esptool核对；备份4,194,304字节，烧录后哈希校验成功。
- 收到新版本IMU3及板端MOTION1，页面身份、采样计数与数值持续刷新。
- 用户确认板子放稳，重新置零并启用静止约束后，抽取约31.45秒、784帧遥测，98.34%处于静止保持。位置保持接近零，不能据此推断运动测距精度。
- 证据位于本地 `host/hardware_tests/single-motion-20261114/`：`live.jsonl`、`static-summary.json`、`interface.png` 和服务日志。
- 尚未完成已知距离平移、长测、最坏负载时序或外部姿态精度验收。

USB遥测：`[MOTION1],sequence,device_us,ready,held,calibration_count,raw_ax,raw_ay,raw_az,linear_ax,linear_ay,linear_az,vx,vy,vz,px,py,pz`。USB指令：`R`重新置零校准、`Z`开启启发式静止约束、`N`关闭。旧开发台按已有规则忽略以 `[` 开始的诊断行。
