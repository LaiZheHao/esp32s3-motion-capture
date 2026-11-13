#include <cassert>
#include <cmath>
#include "../include/onboard_motion.h"

static void settle(OnboardMotion &m, uint32_t &clock) {
  const float a[3]={0,0,1},g[3]={.1f,-.1f,.2f};
  for(int i=0;i<220;i++){clock+=10000;m.update(clock,a,g);}
  assert(m.ready);
}
int main(){
  OnboardMotion m;uint32_t clock=1000;settle(m,clock);
  for(float p:m.p)assert(std::fabs(p)<1e-5f);
  const float moving[3]={.1f,0,1},gyro[3]={.1f,-.1f,.2f};
  for(int i=0;i<100;i++){clock+=10000;m.update(clock,moving,gyro);}
  assert(m.p[0]>.2f && m.v[0]>.5f);
  // Unconstrained integration must not erase velocity just because IMU input
  // looks stationary (constant physical velocity is indistinguishable here).
  const float before=m.p[0],rest[3]={0,0,1};
  for(int i=0;i<100;i++){clock+=10000;m.update(clock,rest,gyro);}
  assert(m.p[0]>before && !m.held);
  m.zupt=true;
  for(int i=0;i<100;i++){clock+=10000;m.update(clock,rest,gyro);}
  assert(m.held && m.v[0]==0);
  clock+=200000;m.update(clock,rest,gyro);assert(!m.ready);
  m.reset();clock=UINT32_MAX-500000;settle(m,clock);assert(m.ready);
  const float invalid[3]={NAN,0,1};m.update(clock+10000,invalid,gyro);assert(!m.ready);
  const float spinning[3]={10,0,0};
  for(int i=0;i<300;i++){clock+=10000;m.update(clock,rest,spinning);}
  assert(!m.ready);
}
