#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <ICM42688.h>
#include <WiFi.h>
#include <esp_system.h>
#include <lwip/sockets.h>
#include <errno.h>
#include "frame_tx_queue.h"
#ifdef IMU_ONBOARD_MOTION
#include "onboard_motion.h"
static OnboardMotion onboardMotion;
#endif
#if __has_include("node_config.h")
#include "node_config.h"
#else
#include "node_config.example.h"
#endif
#if __has_include("wifi_config.h")
#include "wifi_config.h"
#else
#include "wifi_config.example.h"
#endif

// One firmware image can identify different physical nodes without reflashing
// a different ID for each board. Set IMU_USE_MAC_NODE_ID=0 to keep a manual ID.
#ifndef IMU_USE_MAC_NODE_ID
#define IMU_USE_MAC_NODE_ID 1
#endif
static char nodeId[33];
#ifdef IMU_ONBOARD_MOTION
static constexpr char FIRMWARE_VERSION[] = "imu-motion-usb-20261114-r1";
#undef IMU_BODY_SLOT
#define IMU_BODY_SLOT "unassigned"
#else
static constexpr char FIRMWARE_VERSION[] = "imu-body-node-20261027-r5";
#endif
static char bootId[17];
static_assert(sizeof(IMU_BODY_SLOT) <= 33, "Body slot token is too long");
static_assert(sizeof(IMU_NODE_CONFIG_VERSION) <= 65, "Config version token is too long");

#ifndef IMU_JOIN_NODE_AP
#define IMU_JOIN_NODE_AP 0
#endif
#ifndef IMU_CLIENT_IP_LAST_OCTET
#define IMU_CLIENT_IP_LAST_OCTET 0
#endif
static_assert(IMU_CLIENT_IP_LAST_OCTET == 0 ||
              (IMU_CLIENT_IP_LAST_OCTET >= 2 && IMU_CLIENT_IP_LAST_OCTET <= 254),
              "Client address must be DHCP (0) or a valid subnet host octet");
#if IMU_JOIN_NODE_AP
// Reuse the locally configured node AP credentials without overwriting the
// preserved router credentials in wifi_config.h. Never log either password.
static constexpr const char *stationSsid = WIFI_AP_SSID;
static constexpr const char *stationPassword = WIFI_AP_PASSWORD;
#else
static constexpr const char *stationSsid = WIFI_SSID;
static constexpr const char *stationPassword = WIFI_PASSWORD;
#endif

static WiFiServer tcpServer(WIFI_TCP_PORT);
static WiFiClient tcpClient;
// 4 KiB of frame storage, bounded even when a peer stops reading. Network
// congestion must never hold up sensor sampling or the loop watchdog.
static FrameTxQueue<8, 512> tcpFrames;
static uint32_t tcpBackpressureDisconnects = 0, tcpSendErrors = 0, usbSkippedFrames = 0;

void serviceTcpOutput() {
  if (!tcpFrames.remaining()) return;
  if (!tcpClient.connected()) { tcpFrames.clear(); return; }
  const int sent = ::send(tcpClient.fd(), tcpFrames.data(), tcpFrames.remaining(), MSG_DONTWAIT);
  if (sent > 0) {
    tcpFrames.consume(static_cast<size_t>(sent));
  } else if (sent == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
    ++tcpSendErrors;
    tcpClient.stop();
    tcpFrames.clear();
  }
}
static bool tcpServerStarted = false;
static unsigned long lastWifiAttemptMs = 0;
static uint32_t lastSampleUs = 0;
static uint32_t sampleSequence = 0;
static_assert(IMU_SAMPLE_RATE_HZ == 25 || IMU_SAMPLE_RATE_HZ == 50 || IMU_SAMPLE_RATE_HZ == 100,
              "Supported sample rates: 25, 50, 100 Hz");
static unsigned long lastSensorErrorMs = 0;
static bool imuReady = false;
static bool magReady = false;
static bool accessPointMode = false;
static bool accessPointReady = false;
static unsigned long lastMagRetryMs = 0;
static unsigned long lastNetworkLogMs = 0;

void manageWifi() {
  if (accessPointMode && !accessPointReady) return;
  if (!accessPointMode && WiFi.status() != WL_CONNECTED) {
    if (tcpClient) tcpClient.stop();
    tcpFrames.clear();
    if (tcpServerStarted) {
      tcpServer.end();
      tcpServerStarted = false;
    }
    if (millis() - lastWifiAttemptMs >= 15000) {
      lastWifiAttemptMs = millis();
      Serial.printf("[WiFi] Connecting to %s\n", stationSsid);
      WiFi.reconnect();
    }
    return;
  }
  if (!tcpServerStarted) {
    tcpServer.begin();
    tcpServer.setNoDelay(true);
    tcpServerStarted = true;
    Serial.println(accessPointMode ? "[WiFi] Hotspot ready" : "[WiFi] Connected");
    Serial.print("[WiFi] IP: ");
    Serial.println(accessPointMode ? WiFi.softAPIP() : WiFi.localIP());
    Serial.printf("[TCP] Listening on port %u\n", WIFI_TCP_PORT);
  }
  if (!tcpClient || !tcpClient.connected()) {
    if (tcpClient) tcpClient.stop();
    tcpFrames.clear();
    WiFiClient candidate = tcpServer.available();
    if (candidate) {
      tcpClient = candidate;
      tcpClient.setNoDelay(true);
      Serial.println("[TCP] Client connected");
    }
  }
  // Exactly one nonblocking socket send per loop, preserving any partial line.
  serviceTcpOutput();
}

// ================================================================
// 硬件连接说明（依据原理图网表 Netlist_Schematic1_2026-08-26.tel 推导）
//
//  ICM-42688-P (U10)  —— SPI 从机
//    IMU_INTERUPT : ESP32-S3 GPIO9  (模块引脚13) -> U10.4  INT1  (可选)
//    IMU_/SS      : ESP32-S3 GPIO10 (模块引脚14) -> U10.12 CS
//    IMU_MOSI     : ESP32-S3 GPIO11 (模块引脚15) -> U10.14 SDI
//    IMU_SCK      : ESP32-S3 GPIO12 (模块引脚16) -> U10.13 SCLK
//    IMU_MISO     : ESP32-S3 GPIO13 (模块引脚17) -> U10.1  SDO
//
//  LIS2MDLTR (U2) —— I2C 从机（器件地址 0x1E）
//    SCL        : ESP32-S3 GPIO33 (模块引脚28) -> U2.1 SCL/SPC
//    SDA        : ESP32-S3 GPIO34 (模块引脚29) -> U2.4 SDA/SDI/SDO
//    INT/DRDY   : ESP32-S3 GPIO47 (模块引脚27) -> U2.7 INT/DRDY (可选)
// ================================================================

// ---- ICM-42688-P SPI 引脚 ----
#define PIN_ICM_CS    10
#define PIN_ICM_SCK   12
#define PIN_ICM_MOSI  11
#define PIN_ICM_MISO  13
#define PIN_ICM_INT   9

// ---- LIS2MDLTR I2C 引脚 ----
#define PIN_LIS_SDA   34
#define PIN_LIS_SCL   33
#define PIN_LIS_DRDY  47

// ---- LIS2MDLTR 寄存器 ----
#define LIS2MDL_ADDR        0x1E
#define LIS2MDL_WHO_AM_I_REG  0x4F
#define LIS2MDL_CFG_A         0x60
#define LIS2MDL_CFG_B         0x61
#define LIS2MDL_CFG_C         0x62
#define LIS2MDL_OUTX_L_REG    0x68
#define LIS2MDL_WHO_AM_I_VAL  0x40

// ICM-42688 SPI 对象（构造时指定 CS 引脚）
ICM42688 icm(SPI, PIN_ICM_CS);

// ---------- LIS2MDLTR 底层 I2C 读写 ----------
bool lis2mdlWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(LIS2MDL_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

uint8_t lis2mdlRead(uint8_t reg) {
  Wire.beginTransmission(LIS2MDL_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0xFF;
  if (Wire.requestFrom((uint8_t)LIS2MDL_ADDR, (uint8_t)1) != 1) return 0xFF;
  return Wire.read();
}

bool lis2mdlReadData(int16_t &mx, int16_t &my, int16_t &mz, int16_t &mt) {
  Wire.beginTransmission(LIS2MDL_ADDR);
  Wire.write(LIS2MDL_OUTX_L_REG);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)LIS2MDL_ADDR, (uint8_t)8) != 8) return false;
  uint8_t buf[8];
  for (uint8_t i = 0; i < 8; i++) buf[i] = Wire.read();
  mx = (int16_t)((buf[1] << 8) | buf[0]);
  my = (int16_t)((buf[3] << 8) | buf[2]);
  mz = (int16_t)((buf[5] << 8) | buf[4]);
  mt = (int16_t)((buf[7] << 8) | buf[6]);
  return true;
}

bool lis2mdlSetup() {
  delay(50);
  if (lis2mdlRead(LIS2MDL_WHO_AM_I_REG) != LIS2MDL_WHO_AM_I_VAL) return false;
  // CFG_REG_A(0x60) = 0x8C:
  //   COMP_TEMP_EN=1(温度补偿), ODR[1:0]=11(100Hz), MD[1:0]=00(连续模式)
  if (!lis2mdlWrite(LIS2MDL_CFG_A, 0x8C)) return false;
  // CFG_REG_B(0x61) = 0x02: 启用偏移消除 OFF_CANC
  if (!lis2mdlWrite(LIS2MDL_CFG_B, 0x02)) return false;
  // CFG_REG_C(0x62) = 0x11: BDU=1(数据块更新) + DRDY_on_PIN=1
  if (!lis2mdlWrite(LIS2MDL_CFG_C, 0x11)) return false;
  return true;
}

void setup() {
#if ARDUINO_USB_MODE
  // The default HWCDC buffer is only 256 bytes; IMU3 lines may be larger.
  const bool usbBufferReady = Serial.setTxBufferSize(1024) >= 512;
#endif
  Serial.begin(115200);
  // USB output is optional. An attached but non-reading host must not stall
  // Wi-Fi sampling; leave at most 1 ms for diagnostic writes.
  Serial.setTxTimeoutMs(1);
  delay(1000);
#if ARDUINO_USB_MODE
  if (!usbBufferReady) Serial.println("[USB] Larger TX buffer unavailable; oversized USB frames will be skipped");
#endif
  Serial.printf("[Reset] Reason=%d\n", static_cast<int>(esp_reset_reason()));
  // Each reset has a new sampling session, independent from the physical MAC.
  snprintf(bootId, sizeof(bootId), "%08lX%08lX",
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));

#if IMU_USE_MAC_NODE_ID
  snprintf(nodeId, sizeof(nodeId), "imu_%012llX",
           static_cast<unsigned long long>(ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL));
#else
  snprintf(nodeId, sizeof(nodeId), "%s", IMU_NODE_ID);
#endif
  Serial.printf("[Node] Firmware=%s ID=%s BodySlot=%s Boot=%s Config=%s Rate=%uHz\n", FIRMWARE_VERSION,
                nodeId, IMU_BODY_SLOT, bootId, IMU_NODE_CONFIG_VERSION,
                static_cast<unsigned>(IMU_SAMPLE_RATE_HZ));
  // Set before WiFi.mode/begin/softAP, as required by Arduino-ESP32.
  WiFi.setHostname(nodeId);

  if (strlen(stationSsid) > 0) {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
#if IMU_JOIN_NODE_AP && IMU_CLIENT_IP_LAST_OCTET != 0
    // The AP DHCP pool has at most 100 leases; .201 stays outside that pool.
    const IPAddress clientAddress(192, 168, 4, IMU_CLIENT_IP_LAST_OCTET);
    if (!WiFi.config(clientAddress, IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0))) {
      Serial.println("[WiFi] Static client IP configuration failed");
    }
    Serial.printf("[WiFi] Role=NODE_CLIENT StaticIP=%s\n", clientAddress.toString().c_str());
#endif
    WiFi.begin(stationSsid, stationPassword);
    lastWifiAttemptMs = millis();
    Serial.printf("[WiFi] Connecting to %s\n", stationSsid);
  } else {
    accessPointMode = true;
    WiFi.mode(WIFI_AP);
    const IPAddress apAddress(192, 168, 4, 1);
    const bool ipReady = WiFi.softAPConfig(apAddress, apAddress, IPAddress(255, 255, 255, 0));
    // Visible 2.4 GHz channel 1, room for the PC plus two future sensor nodes.
    accessPointReady = ipReady && WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD, 1, 0, 4);
    Serial.printf("[WiFi] Hotspot %s: %s\n", WIFI_AP_SSID,
                  accessPointReady ? "started" : "failed (check AP configuration)");
  }

  Serial.println("==============================================");
  Serial.println("  IMU 数据读取 : ICM-42688-P (SPI) + LIS2MDLTR (I2C)");
  Serial.println("==============================================");

  // ---- SPI 总线（自定义引脚）----
  SPI.begin(PIN_ICM_SCK, PIN_ICM_MISO, PIN_ICM_MOSI, PIN_ICM_CS);

  // ---- 初始化 ICM-42688-P ----
  int st = icm.begin();
  if (st > 0) {
    // begin() estimates a bias without checking that the board is still. A
    // moving power-up can therefore turn real motion into a persistent offset.
    // Send uncorrected sensor rates; the host owns explicit, gated calibration.
    icm.setGyroBiasX(0.f);
    icm.setGyroBiasY(0.f);
    icm.setGyroBiasZ(0.f);
    imuReady = icm.setAccelFS(ICM42688::gpm8) > 0 &&
               icm.setGyroFS(ICM42688::dps2000) > 0;
    ICM42688::ODR rate = IMU_SAMPLE_RATE_HZ == 100 ? ICM42688::odr100 :
                        IMU_SAMPLE_RATE_HZ == 50 ? ICM42688::odr50 : ICM42688::odr25;
    imuReady = imuReady && icm.setAccelODR(rate) > 0 && icm.setGyroODR(rate) > 0;
    Serial.println(imuReady ? "[ICM-42688] 初始化成功 (WHO_AM_I = 0x47)" :
                             "[ICM-42688] 量程配置失败");
  } else {
    Serial.printf("[ICM-42688] 初始化失败, 错误码 %d (请检查 SPI 接线)\r\n", st);
  }

  // ---- 初始化 LIS2MDLTR ----
  Wire.begin(PIN_LIS_SDA, PIN_LIS_SCL);
  Wire.setClock(400000);
  magReady = lis2mdlSetup();
  if (magReady) {
    Serial.println("[LIS2MDL]   初始化成功 (WHO_AM_I = 0x40)");
  } else {
    Serial.println("[LIS2MDL]   初始化失败 (请检查 I2C 接线 / CS 引脚电平)");
  }

  Serial.println();
  Serial.println("数据格式 (CSV):");
  Serial.println("[Protocol] IMU3,device_id,body_slot,boot_id,firmware,config,sequence,device_us,sensor_flags,ax,ay,az,gx,gy,gz,temp,mx,my,mz,mag_temp");
  enableLoopWDT();
}

void loop() {
  manageWifi();
  // A transient startup I2C failure must not disable the magnetometer forever.
  if (!magReady && millis() - lastMagRetryMs >= 5000) {
    lastMagRetryMs = millis();
    uint8_t identity = lis2mdlRead(LIS2MDL_WHO_AM_I_REG);
    magReady = lis2mdlSetup();
    Serial.printf("[LIS2MDL] Retry WHO_AM_I=0x%02X ready=%d\n", identity, magReady);
  }
  if (millis() - lastNetworkLogMs >= 5000) {
    lastNetworkLogMs = millis();
    IPAddress address = accessPointMode ? WiFi.softAPIP() : WiFi.localIP();
    Serial.printf("[WiFi] Status=%d IP=%s TCP=%u\n", WiFi.status(), address.toString().c_str(), WIFI_TCP_PORT);
    if (accessPointMode) {
      Serial.printf("[WiFi] Mode=AP Channel=%d Stations=%u\n", static_cast<int>(WiFi.channel()),
                    static_cast<unsigned>(WiFi.softAPgetStationNum()));
    }
    Serial.printf("[Transport] TCPBackpressure=%lu TCPErrors=%lu USBSkipped=%lu\n",
                  static_cast<unsigned long>(tcpBackpressureDisconnects),
                  static_cast<unsigned long>(tcpSendErrors),
                  static_cast<unsigned long>(usbSkippedFrames));
  }
  // Keep serving connections between samples; unsigned subtraction handles millis wraparound.
  uint32_t sampledAtUs = micros();
  if (sampledAtUs - lastSampleUs < 1000000UL / IMU_SAMPLE_RATE_HZ) {
    delay(1);
    return;
  }
  lastSampleUs = sampledAtUs;
  uint32_t sequence = sampleSequence++;
  // ---- 读取 ICM-42688-P ----
  float ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0, t = 0;
  bool imuOk = imuReady && icm.getAGT() > 0;
  if (imuOk) {
    ax = icm.accX(); ay = icm.accY(); az = icm.accZ();
    gx = icm.gyrX(); gy = icm.gyrY(); gz = icm.gyrZ();
    t  = icm.temp();
  }

  // ---- 读取 LIS2MDLTR ----
  int16_t mx = 0, my = 0, mz = 0, mt = 0;
  bool magOk = magReady && lis2mdlReadData(mx, my, mz, mt);
  if (!imuOk || !magOk) {
    // Never send a valid-looking zero frame when a sensor read fails.
    if (millis() - lastSensorErrorMs >= 1000) {
      lastSensorErrorMs = millis();
      Serial.printf("[Sensor] Read failed: IMU=%d MAG=%d\n", imuOk, magOk);
    }
    if (!imuOk) return;
  }

  // ---- 串口输出 ----
#ifdef IMU_ONBOARD_MOTION
  while (Serial.available()) {
    const int command=Serial.read();
    if(command=='R') onboardMotion.reset();
    if(command=='Z') onboardMotion.zupt=true;
    if(command=='N') onboardMotion.zupt=false;
  }
  const float motionAcc[3]={ax,ay,az},motionGyro[3]={gx,gy,gz};
  onboardMotion.update(sampledAtUs,motionAcc,motionGyro);
  if(sequence%4==0 && Serial) {
    char motionLine[384];
    const int size=snprintf(motionLine,sizeof(motionLine),"[MOTION1],%lu,%lu,%u,%u,%u,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\n",
      static_cast<unsigned long>(sequence),static_cast<unsigned long>(sampledAtUs),onboardMotion.ready?1U:0U,onboardMotion.held?1U:0U,onboardMotion.count,
      ax*9.80665f,ay*9.80665f,az*9.80665f,onboardMotion.a[0],onboardMotion.a[1],onboardMotion.a[2],onboardMotion.v[0],onboardMotion.v[1],onboardMotion.v[2],onboardMotion.p[0],onboardMotion.p[1],onboardMotion.p[2]);
    if(size>0 && static_cast<size_t>(size)<sizeof(motionLine) && Serial.availableForWrite()>=size) Serial.write(reinterpret_cast<const uint8_t *>(motionLine),static_cast<size_t>(size));
  }
#endif
  char line[512];
  // 磁力计灵敏度 1.5 mgauss/LSB；加速度保持 g，与串口协议一致。
  const int written = snprintf(line, sizeof(line),
           "IMU3,%s,%s,%s,%s,%s,%lu,%lu,%u,%.4f,%.4f,%.4f,%.3f,%.3f,%.3f,%.2f,%.1f,%.1f,%.1f,%d\n",
           nodeId, IMU_BODY_SLOT, bootId, FIRMWARE_VERSION, IMU_NODE_CONFIG_VERSION,
           static_cast<unsigned long>(sequence), static_cast<unsigned long>(sampledAtUs),
           magOk ? 3U : 1U, ax, ay, az, gx, gy, gz, t, mx * 1.5f, my * 1.5f, mz * 1.5f, mt);
  if (written < 0 || static_cast<size_t>(written) >= sizeof(line)) {
    Serial.println("[Protocol] Output frame exceeded buffer; sample rejected");
    return;
  }
  // USB logging must not require an attached/reading host for Wi-Fi sampling.
  const size_t length = static_cast<size_t>(written);
  if (Serial) {
    if (Serial.availableForWrite() >= written) {
      Serial.write(reinterpret_cast<const uint8_t *>(line), length);
    } else {
      ++usbSkippedFrames;
    }
  }
  if (tcpClient && tcpClient.connected()) {
    if (!tcpFrames.enqueue(reinterpret_cast<const uint8_t *>(line), length)) {
      // A stalled receiver cannot consume unbounded RAM or pause acquisition.
      // Close the whole stream so a partial line is never joined to a later one.
      // The receiver can reconnect and observes the sequence gap explicitly.
      ++tcpBackpressureDisconnects;
      tcpClient.stop();
      tcpFrames.clear();
    }
  }
}
