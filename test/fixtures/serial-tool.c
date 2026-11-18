#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
int main(void) {
  int fd = open("/dev/ttyACM0", 0x02);
  if (fd < 0) { printf("open failed\n"); return 1; }
  unsigned char buf[8] = {0};
  int n = read(fd, buf, 8);
  printf("read %d: %02x %02x\n", n, buf[0], buf[1]);
  close(fd);
  return n == 2 && buf[0] == 0x14 ? 0 : 2;
}
