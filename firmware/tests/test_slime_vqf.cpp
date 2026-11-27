#include <cassert>
#include <cmath>
#include "../include/onboard_motion.h"

int main(){
  OnboardMotion m;uint32_t t=1000;
  const float acc[3]={0,1,0},stationary[3]={.1f,-.1f,.2f};
  for(int i=0;i<600;i++){t+=10000;m.update(t,acc,stationary);}
  assert(m.ready && m.fusionRest());
  for(float value:m.a)assert(std::fabs(value)<.005f);
  float bias[3];m.fusionBias(bias);assert(std::fabs(bias[2]-.2f)<.02f);
  const float flat[3]={0,0,1};
  m.reset();for(int i=0;i<600;i++){t+=10000;m.update(t,flat,stationary);}
  const float turn[3]={.1f,-.1f,90.2f};
  for(int i=0;i<100;i++){t+=10000;m.update(t,flat,turn);}
  const float yaw=std::atan2(2*(m.q[0]*m.q[3]+m.q[1]*m.q[2]),1-2*(m.q[2]*m.q[2]+m.q[3]*m.q[3]));
  assert(std::fabs(yaw-1.5707963f)<.03f); // dynamic tracking, not slow heading correction
  float n=0;for(float value:m.q)n+=value*value;assert(std::fabs(n-1)<.001f);
  m.zupt=true;for(int i=0;i<500;i++){t+=10000;m.update(t,flat,stationary);}
  assert(m.held);
  m.update(t+200000,flat,stationary);assert(!m.ready);
}
