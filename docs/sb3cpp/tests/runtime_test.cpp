#include <cassert>
#include <cmath>
#include <cstring>

extern "C" {
void sb3cpp_reset();
int sb3cpp_add_sprite(const char*,double,double,double,double,int);
void sb3cpp_add_command(int,int,double,double,const char*);
void sb3cpp_run();
double sb3cpp_get_x(int);
double sb3cpp_get_y(int);
double sb3cpp_get_direction(int);
double sb3cpp_get_size(int);
int sb3cpp_get_visible(int);
const char* sb3cpp_get_say(int);
int sb3cpp_get_unsupported();
}
int main(){
  sb3cpp_reset();
  int s=sb3cpp_add_sprite("Test",0,0,90,100,1);
  sb3cpp_add_command(s,1,10,0,"");
  sb3cpp_add_command(s,2,90,0,"");
  sb3cpp_add_command(s,1,10,0,"");
  sb3cpp_add_command(s,8,0,0,"hello");
  sb3cpp_add_command(s,11,150,0,"");
  sb3cpp_add_command(s,10,0,0,"");
  sb3cpp_run();
  assert(std::abs(sb3cpp_get_x(s)-10.0)<1e-9);
  assert(std::abs(sb3cpp_get_y(s)-10.0)<1e-9);
  assert(std::abs(sb3cpp_get_direction(s)-180.0)<1e-9);
  assert(std::abs(sb3cpp_get_size(s)-150.0)<1e-9);
  assert(sb3cpp_get_visible(s)==0);
  assert(std::strcmp(sb3cpp_get_say(s),"hello")==0);
  assert(sb3cpp_get_unsupported()==0);
}
