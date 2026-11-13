#pragma once
#include <cmath>
#include <cstdint>

// Experimental relative motion in the initial gravity-aligned frame, SI units.
// No magnetometer: heading is relative and can drift. ZUPT is opt-in because
// a stationary IMU observation cannot distinguish rest from constant velocity.
class OnboardMotion {
 public:
  float q[4]={1,0,0,0}, p[3]={}, v[3]={}, a[3]={};
  bool ready=false, zupt=false, held=false;
  unsigned count=0;
  void reset(){ *this=OnboardMotion(); }
  void update(uint32_t us,const float acc[3],const float gyro[3]) {
    if(!finite(acc)||!finite(gyro)){reset();return;}
    const float dt=last ? static_cast<uint32_t>(us-last)*1e-6f : .01f;
    last=us;
    if(dt<=0||dt>.1f){reset();last=us;return;}
    const float an=length(acc);
    if(!ready){
      if(an<.85f||an>1.15f||length(gyro)>3){clearCalibration();return;}
      ++count; seconds+=dt;
      for(int i=0;i<3;i++){sumA[i]+=acc[i];sumG[i]+=gyro[i];squareA[i]+=acc[i]*acc[i];squareG[i]+=gyro[i]*gyro[i];}
      if(seconds<2||count<100)return;
      float varianceA=0,varianceG=0,meanA[3];
      for(int i=0;i<3;i++){meanA[i]=sumA[i]/count;bias[i]=sumG[i]/count;varianceA+=squareA[i]/count-meanA[i]*meanA[i];varianceG+=squareG[i]/count-bias[i]*bias[i];}
      if(varianceA>.0001f||varianceG>.1f){clearCalibration();return;}
      gravity=length(meanA);euler(std::atan2(meanA[1],meanA[2]),std::atan2(-meanA[0],std::hypot(meanA[1],meanA[2])),0,q);
      ready=true;return;
    }
    float g[3];for(int i=0;i<3;i++)g[i]=(gyro[i]-bias[i])*.01745329252f;
    float dq[4]={-q[1]*g[0]-q[2]*g[1]-q[3]*g[2],q[0]*g[0]+q[2]*g[2]-q[3]*g[1],q[0]*g[1]-q[1]*g[2]+q[3]*g[0],q[0]*g[2]+q[1]*g[1]-q[2]*g[0]};
    for(int i=0;i<4;i++)q[i]+=.5f*dq[i]*dt;
    normalize();
    // Gravity corrects tilt slowly; it supplies no heading observation.
    if(std::fabs(an-gravity)<.06f){
      const float yaw=std::atan2(2*(q[0]*q[3]+q[1]*q[2]),1-2*(q[2]*q[2]+q[3]*q[3]));
      float obs[4];euler(std::atan2(acc[1],acc[2]),std::atan2(-acc[0],std::hypot(acc[1],acc[2])),yaw,obs);
      float dot=0;for(int i=0;i<4;i++)dot+=q[i]*obs[i];
      const float gain=1-std::exp(-dt/6.2f);
      for(int i=0;i<4;i++)q[i]+=(obs[i]*(dot<0?-1:1)-q[i])*gain;
      normalize();
    }
    const float w=q[0],x=q[1],y=q[2],z=q[3],scale=9.80665f/gravity;
    a[0]=scale*((1-2*y*y-2*z*z)*acc[0]+2*(x*y-z*w)*acc[1]+2*(x*z+y*w)*acc[2]);
    a[1]=scale*(2*(x*y+z*w)*acc[0]+(1-2*x*x-2*z*z)*acc[1]+2*(y*z-x*w)*acc[2]);
    a[2]=scale*(2*(x*z-y*w)*acc[0]+2*(y*z+x*w)*acc[1]+(1-2*x*x-2*y*y)*acc[2])-9.80665f;
    float delta[3];for(int i=0;i<3;i++)delta[i]=acc[i]-previousRaw[i];
    restSeconds=(length(g)<.02094f&&std::fabs(an-gravity)<.01f&&length(delta)<.006f)?restSeconds+dt:0;
    held=zupt&&restSeconds>.5f;
    for(int i=0;i<3;i++){
      if(held){v[i]=0;}else{const float nv=v[i]+.5f*(a[i]+previousA[i])*dt;p[i]+=.5f*(v[i]+nv)*dt;v[i]=nv;}
      previousA[i]=a[i];previousRaw[i]=acc[i];
    }
  }
 private:
  uint32_t last=0;
  float sumA[3]={},sumG[3]={},squareA[3]={},squareG[3]={},bias[3]={},previousA[3]={},previousRaw[3]={};
  float seconds=0,gravity=1,restSeconds=0;
  static bool finite(const float u[3]){return std::isfinite(u[0])&&std::isfinite(u[1])&&std::isfinite(u[2]);}
  static float length(const float u[3]){return std::sqrt(u[0]*u[0]+u[1]*u[1]+u[2]*u[2]);}
  void clearCalibration(){count=0;seconds=0;for(int i=0;i<3;i++)sumA[i]=sumG[i]=squareA[i]=squareG[i]=0;}
  void normalize(){float n=0;for(float value:q)n+=value*value;n=std::sqrt(n);for(float &value:q)value/=n;}
  static void euler(float r,float t,float h,float out[4]){const float cr=std::cos(r/2),sr=std::sin(r/2),ct=std::cos(t/2),st=std::sin(t/2),ch=std::cos(h/2),sh=std::sin(h/2);out[0]=cr*ct*ch+sr*st*sh;out[1]=sr*ct*ch-cr*st*sh;out[2]=cr*st*ch+sr*ct*sh;out[3]=cr*ct*sh-sr*st*ch;}
};
