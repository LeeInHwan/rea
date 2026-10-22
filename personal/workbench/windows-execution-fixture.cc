// Owned, finite execution fixture. This is not a reconstructed third-party app.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#ifndef RESULT_DELTA
#define RESULT_DELTA 0
#endif

int main(int argc, char** argv) {
  if (argc != 2) return 64;
  if (std::strcmp(argv[1], "wait") == 0) {
    std::puts("started");
    std::fflush(stdout);
#ifdef _WIN32
    Sleep(30000);
#endif
    return 0;
  }
  if (std::strcmp(argv[1], "fail") == 0) {
    std::fputs("owned fixture failure\n", stderr);
    return 7;
  }
  char* end = nullptr;
  const long value = std::strtol(argv[1], &end, 10);
  if (!end || *end || value < -10000 || value > 10000) return 65;
  std::printf("{\"result\":%ld}\n", value * 3 + 7 + RESULT_DELTA);
  return 0;
}
