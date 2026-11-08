# ESP32-S3 惯性动作采集系统

使用 ESP32-S3、ICM-42688-P 和 LIS2MDL 采集惯性数据，通过 **USB 串口或 Wi-Fi TCP** 传到电脑，显示实时姿态并记录数据。

当前保留一套固件和共享上位机代码。8000 开发台已集成可配置十四槽位火柴人、每设备独立处理、引导初始化、节点诊断及完整帧记录回放；支持少量节点起步。8010 旋转监控和三节点预设继续保留作诊断工具。新增能力目前属于离线软件基线，实板验收范围见下表和工程状态。

伙伴迁移包的重力向量倾斜校正和新版静置零偏校准已整合进同一开发台，可按设备切换六轴/磁场门控策略、取消校准及关闭停稳保持。算法配置在 `host/config/attitude_v1.json`，操作和验证见 [伙伴算法整合](docs/validation/partner-drift-20261025.md)。本轮为离线验证，不能称实板长期漂移已解决。

双节点 USB 独立驱动已有用户实测，但中立归零不能保证动作方向一致。当前 [安装与方向标定](docs/direction-calibration.md) 采用**两次定姿采样**：下垂采中立，直肘正前举后采第二姿态，再显式应用。点击后先准备2秒，再自动寻找约1.3秒的稳定数据；容忍轻微晃动和少量瞬时异常，最多等待15秒。开发台将设备检测与标定集中到端点身份下方，移除了模拟入口，模型改用滑条缩放。自动采样改进已通过离线回归，实板效果仍待验证，不消除漂移。

网页与处理链坐标约定见 [统一右手坐标](docs/coordinate-convention.md)。显示投影已统一；物理芯片/PCB 轴仍需实板核对。

## 目前做到哪一步

| 项目阶段      | 当前状态                                  |
| --------- | ------------------------------------- |
| 电路与硬件     | 已有初版硬件；本仓库保存程序与必要参考，硬件原始工程在仓库外的项目资料目录 |
| 单块板 USB   | 此前用户实测当前电脑与一块板的实时姿态通过；新版骨架绑定/初始化仍待实板验证 |
| 单块板 Wi-Fi | 此前用户实测单板 TCP 实时姿态通过；新版多节点处理仍待实板验证 |
| 多块板 Wi-Fi | 伙伴历史 A/B 记录；本轮没有多板实测，当前板载热点不能视为支持十四板 |
| 十四槽位骨架 | 同一开发台的身份/处理/初始化/骨架/诊断/记录回放已做离线验证；不是十四板硬件验收 |
| 三节点实验     | 已有预设、离线演示和采集分析程序；第三节点尚未完成实板联合验证       |
| 数据与可视化优化  | 已整合伙伴重力向量校正、静置校准重试与质量门控；实板漂移、动态精度仍待验证 |
| 单板短时三维位移 | 六面标定、整段回算和整秒 CSV 已通过离线验证。下一次实测从[六面静置标定](#下次实板位移测量从哪里开始)开始，50 cm 平移的 1 cm 误差门槛待验收 |

当前主线为 **USB → Wi-Fi → 多板**。BLE、ESP-NOW 和旧版全身系统没有纳入当前工程；历史源码可以从 Git 历史找回。

## 工程结构

```text
.
├── firmware/                 ESP32-S3 固件，USB 与 Wi-Fi 共用采集逻辑
│   ├── platformio.ini        A 节点与 B 节点构建环境
│   ├── src/main.cpp          传感器采集、节点标识、串口和 TCP 输出
│   └── include/              可提交的 Wi-Fi 配置示例与本机私有配置
├── host/                     电脑端程序
│   ├── dashboard/            协议、传输、独立节点处理、骨架、录制和 HTTP 服务
│   ├── config/               版本化身体槽位、骨长、坐标和初始化阈值
│   ├── web/                  单板开发台和多节点监控页面
│   ├── motion_presets/       三节点实验分析与报告
│   ├── presets/              实验预设和端点示例
│   ├── tests/                Python 与 JavaScript 测试
│   ├── run_dashboard.py      统一动作捕捉开发台，默认 8000
│   ├── run_wifi_monitor.py   多节点旋转监控，默认 8010
│   └── run_motion_presets.py 离线演示、回放和三节点采集入口
├── tools/                    PowerShell 启动器、诊断和交付打包工具
├── docs/                     使用方法、工程状态及历史验证依据
├── .github/                  CI、代码归属和 PR 模板
├── .codex/                   代码级 AI 工作记录，由 project-workspace 管理
└── README.md                 GitHub 首页与工程入口
```

整体项目（本仓库上一层）的 `.codex/` 保存项目主线、硬件与软件协作及总体交接；本仓库的 `.codex/` 保存代码设计、构建、测试、调试和 Git 操作记录。

## 先运行电脑端

需要 Python **3.10 或更新版本**；CI 使用 3.12。在 PowerShell 中进入本仓库根目录，创建上位机环境：

```powershell
py -3.12 -m venv host/.venv
host/.venv/Scripts/python.exe -m pip install -r host/requirements.txt
```

`py -3.12` 要求本机已安装 Python 3.12。若只有其他版本，先用 `py -0p` 确认，再选择不低于 3.10 的解释器。

**USB 或单板 Wi-Fi 开发台：**

```powershell
.\tools\start_dashboard.ps1
```

打开 [单板开发台](http://127.0.0.1:8000)，在页面选择串口或 Wi-Fi，并填写实际 COM 号或 IP。使用页面前关闭占用串口的监视器。

身体位置绑定、初始化和完整动作会话的背景见 [姿态软件基线](docs/body-baseline.md)。当前开发台已移除模拟入口；旧 IMU2 流须显式绑定位置，不默认右腕。固件位置配置可先预览：`tools/build_node.ps1 -BodySlot left_hand -DryRun`；没有 `-Upload` 就不会上传。

**A/B 两节点旋转监控：**

```powershell
.\tools\start_wifi_monitor.ps1
```

打开 [多节点旋转监控](http://127.0.0.1:8010)。启动器默认使用 A=`192.168.4.1:9000`、B=`192.168.4.201:9000`；这是现有 A 热点、B 加入 A 的拓扑，运行前核实板卡配置与电脑网络。若地址不同，直接指定端点：

```powershell
cd host
.\.venv\Scripts\python.exe -B run_wifi_monitor.py --node A=192.168.4.1:9000 --node B=192.168.4.201:9000
```

每块板当前只接受一个 TCP 接收程序。单板开发台、多节点监控和实时实验采集应分别使用。

## 固件编译与烧录

在 VS Code 中直接打开 `firmware/`，使用 PlatformIO。首次烧录前，将 `include/wifi_config.example.h` 复制为 `include/wifi_config.h`，在本地填写网络参数；私有文件已被 Git 忽略。

```powershell
cd firmware
if (-not (Test-Path include/wifi_config.h)) {
    Copy-Item include/wifi_config.example.h include/wifi_config.h
}
pio run -e esp32-s3-devkitm-1
pio run -e esp32-s3-client-b
```

已有私有配置时保留原文件。默认环境用于 A；`esp32-s3-client-b` 用于加入 A 热点的 B，静态地址尾号为 201。重新烧录 B 时，配置必须与 A 的真实热点一致。编译命令只构建固件；确认板卡和实际串口后再执行上传：

```powershell
pio run -e esp32-s3-devkitm-1 -t upload --upload-port COM9
```

`COM9` 是命令示例，按本机设备管理器或 `pio device list` 的结果替换。第三块板需要独立地址配置，避免复用 B 的静态 IP。

如果 Windows 工具链在中文路径报找不到依赖文件或 `firmware.map`，可将仓库映射到空闲英文盘符，再打开对应工程：

```powershell
subst M: "E:\AAA动作捕捉系统\2.代码"
```

之后在 VS Code 打开 `M:\firmware`。盘符映射指向同一份文件；使用前确认 `M:` 空闲，重启后可能需要重新建立。

## 离线演示与验证

三节点预设演示不需要板子：

```powershell
.\tools\start_preset.ps1 -Preset upper_limb
```

测试从 `host/` 运行：

```powershell
.\.venv\Scripts\python.exe -B -X utf8 -m unittest discover -s tests -v
node --check web/app.js
node --check web/pose_math.js
node tests/test_pose_math.js
node tests/test_body_view.js
```

实验报告的 JavaScript 测试需要先生成四份演示报告，完整命令见 [GitHub CI](.github/workflows/ci.yml)。

## 下次实板位移测量从哪里开始

**从六面静置标定开始。** 这是单板位移流程新增的加速度计标定步骤，用来估计三个轴的零偏和比例。此前已用一块板通过 USB 收到带帧序号和设备时间戳的 IMU3 数据，位移解算和导出已做离线验证。

1. **连接一块板。** 用 `.\tools\start_dashboard.ps1` 启动或重启 8000 开发台，选择板卡当前的 USB 串口，确认有有效采样。位移解算在电脑端运行，现有能正常输出 IMU3 的固件即可使用。
2. **录六个标定会话。** 分别使 ICM-42688-P 的原始 `+X、-X、+Y、-Y、+Z、-Z` 朝上。每一面先放稳，再单独录制约 2 秒，保存后记下历史记录页上的会话 ID。六个会话和动作记录使用同一块板及相同的采样配置。
3. **录第一次已知距离平移。** 保持原始 `+Z` 朝上，将板卡 `+X` 对准实验台 `+X`。开始录制后静置至少 1 秒，沿 `+X` 平移 **50 cm**，停稳后再静置至少 1 秒，然后保存。尺量的 50 cm 只用于验收。
4. **解算并检查摘要。** 在仓库根目录运行下方命令，将 `MOTION` 和六个面对应的占位目录替换为实际会话 ID。若静置窗与默认的首尾各 1 秒不同，按实际录制设置 `--start-still` 和 `--end-still`。

```powershell
host/.venv/Scripts/python.exe -B -X utf8 tools/measure_displacement.py "host/recordings/MOTION" --faces "host/recordings/XP" "host/recordings/XN" "host/recordings/YP" "host/recordings/YN" "host/recordings/ZP" "host/recordings/ZN" --reference 0.50 0 0
```

动作目录中的 `single_node_motion.csv` 保存整秒结果，`single_node_motion_summary.json` 保存实际终点。在摘要里看 `validation.endpoint_error_m` 和 `validation.within_target`。首轮目标为 **三维终点误差 ≤ 0.01 m（2%）**，串轴误差也计入。重复测量并记录误差，再做 Y、Z 和斜向移动。静置窗和导出细节见[单板短时位移测量](docs/usage.md#单板短时位移测量)。

## 接下来按什么顺序做

1. 确认当前端点、身份、角色和记录状态，按两次定姿流程逐步做实板验证。
2. 逐步确认当前板卡与端口，再验证单板绑定身体位置和初始化；此前 USB/Wi-Fi 实时姿态已实测通过。
3. 逐步复查 A/B 两节点：观察转动后停稳、动态一致性和长期数据质量。
4. 接入第三节点，再优化安装标定、数据处理和可视化。

详细操作见 [使用说明](docs/usage.md)，三节点预设见 [实验说明](docs/experiments.md)。当前位移是会漂移的估算；三节点对齐是近似时间对齐，不能视为硬件同步或精确人体关节角。
