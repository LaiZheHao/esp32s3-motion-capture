# SlimeVR VQF 单节点迁移实验

2026-11-27：已编译并烧录 COM9 的 node1（ESP32-S3，MAC 98:C3:77:60:5A:30，设备 imu_305A6077C398）。固件版本 `imu-slime-vqf-20261127-r1`。

## 迁移范围

迁移 SlimeVR Tracker ESP 使用的 VQF 六轴融合核心及其 SensorFusion 适配方式，加入既有板端实验固件。使用本项目原有 ICM-42688 SPI 采样和 IMU3/TCP/Wi-Fi 代码，不将本板变成完整 SlimeVR 协议设备。未部署 SlimeVR Server、骨架解算、Stay Aligned 或完整六面加速度校准。旧编译环境仍保留。

- 源码来自 https://github.com/SlimeVR/SlimeVR-Tracker-ESP ，固定提交 `9fae27ac71e0f8236a72f890da213f7dbf3f6908`，目录 `lib/vqf`。
- vendored `vqf.h` / `vqf.cpp` 保持下载原文，版本和 SHA256 见 `firmware/lib/slimevr-vqf/UPSTREAM.json`。保留 Daniel Laidig 原始 SPDX 版权标记及 MIT 许可文本。
- 四项参数沿用 SlimeVR SensorFusion 的配置：tauAcc=2 s、restMinT=2 s、restThGyr=0.6 deg/s、restThAcc=0.06 m/s²。其余参数使用该固定版本的默认值，不能与上游 VQF 其他版本默认值混同。
- 保留既有两秒静止质量门控。通过后将初始重力姿态和平均陀螺零偏置入 VQF；后续由 VQF 在线估计偏差。加速度从 g 转 m/s²，陀螺从 deg/s 转 rad/s。加速度按原实验的初始重力模长归一化，不是完整的加速度三轴标定。
- `updateAcc` 后执行 `updateGyr`，与 SlimeVR 适配器一致；陀螺预测使用真实设备时钟间隔。加速度滤波和静止计时仍使用100 Hz名义周期，采样频率变化时须重新核对。
- 不输入磁力计，输出是六轴相对姿态。没有绝对航向观测，不承诺长期航向无漂移。
- 位移部分保留原实验积分，不是 SlimeVR 的位置计算方法。静止速度约束默认关闭，打开后改用 VQF 的静止检测，但静止检测依然无法可靠区分匀速平移。

## 运行与回退

```powershell
cd firmware
C:/.platformio/penv/Scripts/pio.exe run -e esp32-s3-slime-vqf
C:/.platformio/penv/Scripts/pio.exe run -e esp32-s3-slime-vqf -t upload --upload-port COM9
cd ..
host/.venv/Scripts/python.exe -B -X utf8 tools/live_board_motion.py --serial COM9 --capture host/hardware_tests/slime-vqf-20261127/live.jsonl
```

显示窗口：http://127.0.0.1:8001/ 。新增三轴姿态角、旋转板模型、VQF陀螺偏差和静止检测状态。位移显示仍是实验积分结果。原始IMU3不附加姿态字段；`[FUSION1]` 是独立USB诊断遥测，旧开发台按已有规则忽略以`[`开头的行，因此旧开发台仍运行自身融合，不会自动切换到板端VQF。

`FUSION1` 字段：序号、设备微秒、四元数wxyz、陀螺零偏XYZ（deg/s）、静止标记。遥测25 Hz，板端100 Hz。采集文件同时包含原有运动结果行和 `kind="fusion"` 的姿态行，按kind区分后处理。

烧录前已备份本板完整4MB Flash：`host/hardware_tests/slime-vqf-20261127/before-flash.bin`。目录在Git忽略范围，备份可能含Wi-Fi配置，不上传。恢复需停止占用COM9的服务后将该文件按地址0写回；不要把其他板的备份混用。

## 已完成验证和限制

- 编译成功（应用源码 `-Wall -Wextra -Werror`）；RAM 50,036字节（15.3%），程序区748,977字节（57.1%）。烧录成功且写入哈希校验通过。
- 用户确认放稳后采集的30秒静置窗口：748帧姿态遥测，设备序号未发现缺口；最大姿态相对变化0.07292°、末端变化0.07141°；四元数模长最大偏差约2.21e-7。静止检测占81.8%。这不是绝对角度精度或长期漂移验收。
- 未开启位置保持时，同一窗口线加速度RMS约0.02669 m/s²，积分位置已明显漂移。VQF迁移没有解决自由位移误差；不将静止约束后的零点保持当成测距精度。
- 完成静置检查后，通过窗口重新置零、开启可选静止约束，留给用户后续转动验证。
- 三项遥测解析回归及页面脚本语法检查通过。新增C++回归覆盖侧放重力对齐、零偏估计、90°/s转动跟随、四元数归一化、静止约束、采样中断；加入CI，但本轮本机尚未执行原生C++测试。
- 未完成与原融合的相同原始数据对比、已知角度转动精度、长测、六面标定、多节点或SlimeVR Server接入。

本地证据：`host/hardware_tests/slime-vqf-20261127/live.jsonl`、`static-summary.json`、`backup.log`、服务日志和界面截图。以上为本地硬件证据，不随本轮自动发布。
