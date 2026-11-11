#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define KEEP EMSCRIPTEN_KEEPALIVE
#else
#define KEEP
#endif

namespace {
struct Command { int op; double a, b; std::string text; };
struct Sprite {
  std::string name, say;
  double x=0, y=0, direction=90, size=100;
  bool visible=true;
  std::vector<Command> commands;
};
std::vector<Sprite> sprites;
int unsupported=0;
}
extern "C" {
KEEP std::uint32_t sb3cpp_runtime_abi(){ return 2; }
KEEP const char* sb3cpp_runtime_name(){ return "SB3 C++ Runtime"; }
KEEP void sb3cpp_reset(){ sprites.clear(); unsupported=0; }
KEEP int sb3cpp_add_sprite(const char* name,double x,double y,double direction,double size,int visible){
  Sprite s; s.name=name?name:"Sprite"; s.x=x; s.y=y; s.direction=direction; s.size=size; s.visible=visible!=0;
  sprites.push_back(s); return (int)sprites.size()-1;
}
KEEP void sb3cpp_add_command(int sprite,int op,double a,double b,const char* text){
  if(sprite<0 || sprite>=(int)sprites.size()) return;
  sprites[sprite].commands.push_back({op,a,b,text?text:""});
}
KEEP void sb3cpp_add_unsupported(){ ++unsupported; }
KEEP int sb3cpp_get_unsupported(){ return unsupported; }
KEEP void sb3cpp_run(){
  for(auto& s:sprites){
    for(const auto& c:s.commands){
      switch(c.op){
        case 1: { const double r=s.direction*3.14159265358979323846/180.0; s.x+=std::sin(r)*c.a; s.y+=std::cos(r)*c.a; break; }
        case 2: s.direction+=c.a; break;
        case 3: s.x=c.a; break;
        case 4: s.y=c.a; break;
        case 5: s.x+=c.a; break;
        case 6: s.y+=c.a; break;
        case 7: s.direction=c.a; break;
        case 8: s.say=c.text; break;
        case 9: s.visible=true; break;
        case 10: s.visible=false; break;
        case 11: s.size=c.a; break;
        case 12: s.size+=c.a; break;
        case 13: s.x=c.a; s.y=c.b; break;
        default: ++unsupported; break;
      }
    }
  }
}
KEEP int sb3cpp_get_sprite_count(){ return (int)sprites.size(); }
KEEP double sb3cpp_get_x(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].x:0; }
KEEP double sb3cpp_get_y(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].y:0; }
KEEP double sb3cpp_get_direction(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].direction:90; }
KEEP double sb3cpp_get_size(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].size:100; }
KEEP int sb3cpp_get_visible(int i){ return i>=0&&i<(int)sprites.size()&&sprites[i].visible?1:0; }
KEEP const char* sb3cpp_get_name(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].name.c_str():""; }
KEEP const char* sb3cpp_get_say(int i){ return i>=0&&i<(int)sprites.size()?sprites[i].say.c_str():""; }
}
