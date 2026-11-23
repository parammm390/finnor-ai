#define _GNU_SOURCE
/* Raw Linux clock samples only. This program grants no clock qualification,
 * signer authority, original coverage, model permission or time extension. */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/magic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>

static void refuse(void) {
  (void)fputs("SPECIALIST_NATIVE_CLOCK_SAMPLE_UNAVAILABLE\n",stderr);
  exit(125);
}
static uint64_t nanos(clockid_t clock) {
  struct timespec sample;
  if(clock_gettime(clock,&sample)||sample.tv_sec<0||sample.tv_nsec<0||sample.tv_nsec>=1000000000L||
    (uint64_t)sample.tv_sec>(UINT64_MAX-(uint64_t)sample.tv_nsec)/1000000000ULL)refuse();
  return (uint64_t)sample.tv_sec*1000000000ULL+(uint64_t)sample.tv_nsec;
}
static void boot_id(char result[37]) {
  int fd=open("/proc/sys/kernel/random/boot_id",O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
  struct stat metadata;struct statfs filesystem;
  if(fd<0||fstat(fd,&metadata)||!S_ISREG(metadata.st_mode)||metadata.st_uid!=0||
    fstatfs(fd,&filesystem)||(unsigned long)filesystem.f_type!=(unsigned long)PROC_SUPER_MAGIC)refuse();
  char bytes[38];size_t used=0;unsigned int interrupted=0;
  for(;;){
    if(used==sizeof(bytes))refuse();
    ssize_t count=read(fd,bytes+used,sizeof(bytes)-used);
    if(count<0&&errno==EINTR&&++interrupted<64)continue;
    if(count<0)refuse();
    if(count==0)break;
    used+=(size_t)count;
  }
  if(close(fd)||used!=37||bytes[36]!='\n')refuse();
  for(size_t index=0;index<36;index++){
    if(index==8||index==13||index==18||index==23){if(bytes[index]!='-')refuse();}
    else if(!((bytes[index]>='0'&&bytes[index]<='9')||(bytes[index]>='a'&&bytes[index]<='f')))refuse();
  }
  memcpy(result,bytes,36);result[36]=0;
}
int main(int argc,char **argv) {
  (void)argv;
  if(argc!=1||getuid()!=0||geteuid()!=0||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))refuse();
  int namespace_fd=open("/proc/self/ns/time",O_RDONLY|O_CLOEXEC);
  struct stat namespace_identity;struct statfs namespace_filesystem;
  if(namespace_fd<0||fstat(namespace_fd,&namespace_identity)||fstatfs(namespace_fd,&namespace_filesystem)||
    (unsigned long)namespace_filesystem.f_type!=(unsigned long)NSFS_MAGIC)refuse();
  char before_boot[37],after_boot[37];
  boot_id(before_boot);
  uint64_t before=nanos(CLOCK_MONOTONIC),realtime=nanos(CLOCK_REALTIME),after=nanos(CLOCK_MONOTONIC);
  boot_id(after_boot);
  if(after<before||strcmp(before_boot,after_boot)||close(namespace_fd))refuse();
  if(printf("{\"schema\":\"finnor.specialist.raw-native-clock-sample.v1\",\"bootId\":\"%s\","
    "\"samplerPid\":%ld,\"parentPid\":%ld,\"uid\":0,\"clockNamespaceDevice\":\"%ju\","
    "\"clockNamespaceInode\":\"%ju\",\"monotonicBeforeNs\":\"%" PRIu64
    "\",\"realtimeNs\":\"%" PRIu64 "\",\"monotonicAfterNs\":\"%" PRIu64
    "\",\"monotonicClock\":\"CLOCK_MONOTONIC\",\"utcClock\":\"CLOCK_REALTIME\","
    "\"qualificationGranted\":false}\n",before_boot,(long)getpid(),(long)getppid(),
    (uintmax_t)namespace_identity.st_dev,(uintmax_t)namespace_identity.st_ino,before,realtime,after)<0||
    fflush(stdout)==EOF)refuse();
  return 0;
}
