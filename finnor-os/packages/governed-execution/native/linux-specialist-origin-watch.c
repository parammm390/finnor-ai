#define _GNU_SOURCE
/* Read-only original watcher. It never signs, renews, launches a guest, or grants. */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/inotify.h>
#include <sys/timerfd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <errno.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <limits.h>

#define MAX_FILES 4224
#define MAX_LINE 256
struct identity { pid_t pid, parent; unsigned long long ticks; };
struct source_file { int fd; struct stat original; };
static char boot[64];
static struct stat clock_namespace;
static uint64_t last_through, initial_from, original_deadline, census_floor;
static struct identity guardian, guest, worker;
static struct source_file sources[MAX_FILES];
static size_t source_count;
static int cgroup_fd = -1, inotify_fd = -1, deadline_fd = -1, step_fd = -1;
static int pidfds[3] = {-1,-1,-1};
static unsigned long long cgroup_device, cgroup_inode;
static char active_nonce[65];

static int read_text_fd(int fd, char *out, size_t size) {
  ssize_t n;
  if (lseek(fd,0,SEEK_SET)<0) return -1;
  n=read(fd,out,size-1);
  if(n<=0 || (size_t)n==size-1) return -1;
  out[n]='\0'; return 0;
}
static int read_text(const char *path,char *out,size_t size) {
  int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
  if(fd<0)return -1;
  int result=read_text_fd(fd,out,size);close(fd);return result;
}
static uint64_t monotonic_ns(void) {
  struct timespec ts;
  if(clock_gettime(CLOCK_MONOTONIC,&ts)<0) _exit(74);
  return (uint64_t)ts.tv_sec*UINT64_C(1000000000)+(uint64_t)ts.tv_nsec;
}
static int number(const char *raw,unsigned long long *value) {
  char *end=NULL;
  if(!raw || !*raw || (*raw=='0' && raw[1]))return -1;
  for(const char *p=raw;*p;p++)if(*p<'0'||*p>'9')return -1;
  errno=0;*value=strtoull(raw,&end,10);
  return errno || !end || *end ? -1:0;
}
static int nonce_ok(const char *value) {
  if(strlen(value)!=64)return 0;
  for(size_t n=0;n<64;n++)if(!((value[n]>='0'&&value[n]<='9')||(value[n]>='a'&&value[n]<='f')))return 0;
  return 1;
}
static int identity(pid_t pid,struct identity *out) {
  char path[80],raw[8192];snprintf(path,sizeof(path),"/proc/%d/stat",(int)pid);
  if(read_text(path,raw,sizeof(raw))<0)return -1;
  char *end=strrchr(raw,')');if(!end||end[1]!=' ')return -1;
  char *save=NULL,*token=strtok_r(end+2," ",&save);
  int field=3;unsigned long long parent=0,ticks=0;
  while(token){
    if(field==4 && number(token,&parent)<0)return -1;
    if(field==22){if(number(token,&ticks)<0)return -1;break;}
    token=strtok_r(NULL," ",&save);field++;
  }
  if(field!=22 || !ticks || !parent || parent>INT32_MAX)return -1;
  out->pid=pid;out->parent=(pid_t)parent;out->ticks=ticks;return 0;
}
static int same_process(const struct identity *original) {
  struct identity current;
  return identity(original->pid,&current)==0 && current.parent==original->parent && current.ticks==original->ticks;
}
static int initialize_clock(void) {
  if(read_text("/proc/sys/kernel/random/boot_id",boot,sizeof(boot))<0)return -1;
  boot[strcspn(boot,"\r\n")]='\0';
  if(strlen(boot)!=36)return -1;
  for(size_t n=0;n<36;n++)if(!((boot[n]>='0'&&boot[n]<='9')||(boot[n]>='a'&&boot[n]<='f')||boot[n]=='-'))return -1;
  return stat("/proc/self/ns/time",&clock_namespace);
}
static int peer(void) {
  struct ucred credentials;socklen_t length=sizeof(credentials);
  struct identity first,last;char path[80];struct stat ns;
  if(getsockopt(4,SOL_SOCKET,SO_PEERCRED,&credentials,&length)<0 || length!=sizeof(credentials)
    || credentials.pid<=0 || initialize_clock()<0 || identity(credentials.pid,&first)<0)return 74;
  snprintf(path,sizeof(path),"/proc/%d/ns/time",(int)credentials.pid);
  int have_ns=stat(path,&ns)==0;
  if(identity(credentials.pid,&last)<0 || first.ticks!=last.ticks || first.parent!=last.parent)return 74;
  printf("{\"schema\":\"finnor.specialist.actual-unix-peer.v1\",\"pid\":%d,\"uid\":%u,\"gid\":%u,"
    "\"parentPid\":%d,\"startTicks\":\"%llu\",",
    credentials.pid,credentials.uid,credentials.gid,first.parent,first.ticks);
  if(have_ns)printf("\"clockNamespaceDevice\":\"%llu\",\"clockNamespaceInode\":\"%llu\",",
    (unsigned long long)ns.st_dev,(unsigned long long)ns.st_ino);
  else printf("\"clockNamespaceDevice\":null,\"clockNamespaceInode\":null,");
  printf("\"bootId\":\"%s\"}\n",boot);
  return fflush(stdout)==0?0:74;
}
static int cgroup_text(const char *name,char *out,size_t size) {
  int fd=openat(cgroup_fd,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
  if(fd<0)return -1;
  int result=read_text_fd(fd,out,size);close(fd);return result;
}
static int exact_control(const char *name,const char *expected) {
  char raw[256];
  if(cgroup_text(name,raw,sizeof(raw))<0)return 0;
  raw[strcspn(raw,"\r\n")]='\0';return strcmp(raw,expected)==0;
}
static int counters_zero(const char *name,int memory) {
  char raw[4096],key[128];unsigned long long value;int found=0;
  if(cgroup_text(name,raw,sizeof(raw))<0)return 0;
  char *save=NULL,*line=strtok_r(raw,"\n",&save);
  while(line){
    if(sscanf(line,"%127s %llu",key,&value)!=2)return 0;
    if((memory && (!strcmp(key,"oom")||!strcmp(key,"oom_kill")||!strcmp(key,"max")))
      ||(!memory && !strcmp(key,"max"))){found++;if(value)return 0;}
    line=strtok_r(NULL,"\n",&save);
  }
  return found>0;
}
static int member_census(void) {
  char raw[8192];int count=0,has_guardian=0,has_guest=0;
  if(cgroup_text("cgroup.procs",raw,sizeof(raw))<0)return 0;
  char *save=NULL,*token=strtok_r(raw," \r\n\t",&save);
  while(token){
    unsigned long long pid;if(number(token,&pid)<0)return 0;count++;
    if(pid==(unsigned long long)guardian.pid)has_guardian++;
    if(pid==(unsigned long long)guest.pid)has_guest++;
    token=strtok_r(NULL," \r\n\t",&save);
  }
  return count==2 && has_guardian==1 && has_guest==1;
}
static int process_namespace(pid_t pid) {
  char path[80];struct stat ns;snprintf(path,sizeof(path),"/proc/%d/ns/time",(int)pid);
  return stat(path,&ns)==0 && ns.st_dev==clock_namespace.st_dev && ns.st_ino==clock_namespace.st_ino;
}
static int pending_kernel_loss(void) {
  struct pollfd waits[6]={{.fd=inotify_fd,.events=POLLIN},{.fd=deadline_fd,.events=POLLIN},
    {.fd=step_fd,.events=POLLIN},{.fd=pidfds[0],.events=POLLIN},
    {.fd=pidfds[1],.events=POLLIN},{.fd=pidfds[2],.events=POLLIN}};
  return poll(waits,6,0)!=0;
}
static int watch_ancestors(const char *path) {
  char directory[PATH_MAX];
  if(strlen(path)>=sizeof(directory))return -1;
  memcpy(directory,path,strlen(path)+1);
  for(;;){
    char *slash=strrchr(directory,'/');if(!slash)return -1;
    if(slash==directory)directory[1]='\0';else *slash='\0';
    if(inotify_add_watch(inotify_fd,directory,IN_CREATE|IN_DELETE|IN_MOVED_FROM|IN_MOVED_TO
      |IN_ATTRIB|IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT|IN_ONLYDIR|IN_DONT_FOLLOW)<0)return -1;
    if(directory[1]=='\0')return 0;
  }
}
static const char *census(void) {
  struct stat cg;
  census_floor=monotonic_ns();
  if(census_floor>=original_deadline)return "ORIGINAL_DEADLINE";
  if(!same_process(&worker)||!same_process(&guardian)||!same_process(&guest))return "ORIGINAL_PROCESS_CHANGED";
  if(guardian.parent!=worker.pid || guest.parent!=guardian.pid
    ||getpgid(guardian.pid)!=guardian.pid||getpgid(guest.pid)!=guardian.pid)return "ORIGINAL_PARENT_OR_GROUP_CHANGED";
  if(!process_namespace(worker.pid)||!process_namespace(guardian.pid)||!process_namespace(guest.pid))return "CLOCK_NAMESPACE_CHANGED";
  for(size_t n=0;n<3;n++){
    struct pollfd value={.fd=pidfds[n],.events=POLLIN};
    if(poll(&value,1,0)!=0 || value.revents)return "ORIGINAL_PIDFD_LOSS";
  }
  if(fstat(cgroup_fd,&cg)<0 || (unsigned long long)cg.st_dev!=cgroup_device
    || (unsigned long long)cg.st_ino!=cgroup_inode || !member_census())return "ORIGINAL_CGROUP_OR_MEMBERSHIP_LOSS";
  if(!exact_control("memory.max","268435456")||!exact_control("memory.swap.max","0")
    ||!exact_control("pids.max","24")||!exact_control("cpu.max","100000 100000")
    ||!exact_control("cpu.max.burst","0")||!counters_zero("memory.events",1)||!counters_zero("pids.events",0))
    return "ORIGINAL_CGROUP_CONTROL_OR_COUNTER_LOSS";
  for(size_t n=0;n<source_count;n++){
    struct stat now,old=sources[n].original;
    if(fstat(sources[n].fd,&now)<0 || now.st_dev!=old.st_dev || now.st_ino!=old.st_ino
      ||now.st_nlink!=1 || now.st_size!=old.st_size || now.st_mtim.tv_sec!=old.st_mtim.tv_sec
      ||now.st_mtim.tv_nsec!=old.st_mtim.tv_nsec || now.st_ctim.tv_sec!=old.st_ctim.tv_sec
      ||now.st_ctim.tv_nsec!=old.st_ctim.tv_nsec)return "ORIGINAL_SOURCE_CHANGED";
  }
  if(pending_kernel_loss())return "QUEUED_KERNEL_LOSS_OR_WATCH_ERROR";
  return NULL;
}
static int emit(const char *type,const char *event,const char *reason,uint64_t at) {
  /* A healthy watermark precedes every completed check. Never advance it to
     a later stdout/callback timestamp after the authoritative observations. */
  uint64_t through=event?monotonic_ns():census_floor;
  printf("{\"type\":\"%s\",\"nonce\":\"%s\",\"bootId\":\"%s\","
    "\"clockNamespaceDevice\":\"%llu\",\"clockNamespaceInode\":\"%llu\","
    "\"guardianPid\":%d,\"guestPid\":%d,\"workerPid\":%d,"
    "\"guardianStartTicks\":\"%llu\",\"guestStartTicks\":\"%llu\",\"workerStartTicks\":\"%llu\","
    "\"cgroupDevice\":\"%llu\",\"cgroupInode\":\"%llu\","
    "\"fromMonotonicNs\":\"%" PRIu64 "\",\"throughMonotonicNs\":\"%" PRIu64 "\",",
    type,active_nonce,boot,(unsigned long long)clock_namespace.st_dev,(unsigned long long)clock_namespace.st_ino,
    guardian.pid,guest.pid,worker.pid,guardian.ticks,guest.ticks,worker.ticks,cgroup_device,cgroup_inode,
    initial_from,through);
  if(event)printf("\"event\":\"%s\",\"atMonotonicNs\":\"%" PRIu64 "\",",event,at);
  else printf("\"event\":null,\"atMonotonicNs\":null,");
  printf("\"reason\":\"%s\"}\n",reason);
  if(fflush(stdout)!=0)return -1;
  if(!event)last_through=through;
  return 0;
}
static int revoke_child_origin(const char *event,const char *reason) {
  /* A delayed kernel notification is conservatively effective since the last
     completed census, never moved forward to the time it was learned. */
  (void)emit("REVOKED",event,reason,last_through?last_through:initial_from);
  return 74;
}
static int run_watch(int argc,char **argv,int snapshot) {
  unsigned long long gp,cp,wp,dev,ino,nsdev,nsino,deadline;
  if(getuid()!=0||geteuid()!=0||argc<13||argc-12>MAX_FILES||!nonce_ok(argv[2])
    ||number(argv[3],&gp)||number(argv[4],&cp)||number(argv[5],&wp)
    ||number(argv[7],&dev)||number(argv[8],&ino)||number(argv[9],&nsdev)
    ||number(argv[10],&nsino)||number(argv[11],&deadline)||gp>INT32_MAX||cp>INT32_MAX||wp>INT32_MAX
    ||!gp||!cp||!wp||gp==cp||gp==wp||cp==wp || (size_t)(argc-12)>MAX_FILES)return 64;
  pid_t parent=getppid();
  if(prctl(PR_SET_PDEATHSIG,SIGKILL)<0||getppid()!=parent||initialize_clock()<0)return 74;
  memcpy(active_nonce,argv[2],65);
  original_deadline=(uint64_t)deadline;initial_from=monotonic_ns();last_through=initial_from;
  if(original_deadline<=initial_from || (unsigned long long)clock_namespace.st_dev!=nsdev
    ||(unsigned long long)clock_namespace.st_ino!=nsino)return revoke_child_origin("CLOCK_STEP","ORIGINAL_CLOCK_OR_DEADLINE");
  if(identity((pid_t)gp,&guardian)||identity((pid_t)cp,&guest)||identity((pid_t)wp,&worker))
    return revoke_child_origin("PROCESS_LOSS","ORIGINAL_PROCESS_UNAVAILABLE");
  pid_t ids[3]={guardian.pid,guest.pid,worker.pid};
  for(size_t n=0;n<3;n++){pidfds[n]=(int)syscall(SYS_pidfd_open,ids[n],0);if(pidfds[n]<0)return revoke_child_origin("PROCESS_LOSS","ORIGINAL_PIDFD_UNAVAILABLE");}
  cgroup_fd=open(argv[6],O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
  cgroup_device=dev;cgroup_inode=ino;
  struct statfs filesystem;
  if(cgroup_fd<0||fstatfs(cgroup_fd,&filesystem)<0||filesystem.f_type!=CGROUP2_SUPER_MAGIC)
    return revoke_child_origin("CGROUP_LOSS","ORIGINAL_CGROUP_UNAVAILABLE");
  inotify_fd=inotify_init1(IN_NONBLOCK|IN_CLOEXEC);
  if(inotify_fd<0)return revoke_child_origin("SOURCE_CHANGE","SOURCE_WATCH_UNAVAILABLE");
  const char *controls[]={"cgroup.procs","cgroup.threads","cgroup.freeze","memory.max","memory.swap.max",
    "pids.max","cpu.max","cpu.max.burst","cgroup.events","memory.events","pids.events"};
  for(size_t n=0;n<sizeof(controls)/sizeof(controls[0]);n++){
    char control[PATH_MAX];
    if(snprintf(control,sizeof(control),"/proc/self/fd/%d/%s",cgroup_fd,controls[n])>=(int)sizeof(control)
      ||inotify_add_watch(inotify_fd,control,IN_MODIFY|IN_ATTRIB|IN_CLOSE_WRITE|IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT|IN_DONT_FOLLOW)<0)
      return revoke_child_origin("CGROUP_LOSS","ORIGINAL_CGROUP_CONTINUOUS_WATCH_UNAVAILABLE");
  }
  if(inotify_add_watch(inotify_fd,argv[6],IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT|IN_ATTRIB|IN_ONLYDIR|IN_DONT_FOLLOW)<0
    ||watch_ancestors(argv[6])<0)return revoke_child_origin("CGROUP_LOSS","ORIGINAL_CGROUP_PATH_WATCH_UNAVAILABLE");
  for(int at=12;at<argc;at++){
    if(argv[at][0]!='/'||strstr(argv[at],"/../"))return revoke_child_origin("SOURCE_CHANGE","SOURCE_PATH_INVALID");
    int fd=open(argv[at],O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);struct stat value;
    if(fd<0||fstat(fd,&value)<0||!S_ISREG(value.st_mode)||value.st_uid!=0||(value.st_mode&0022)||value.st_nlink!=1)
      return revoke_child_origin("SOURCE_CHANGE","SOURCE_CUSTODY_UNAVAILABLE");
    sources[source_count].fd=fd;sources[source_count].original=value;source_count++;
    if(inotify_add_watch(inotify_fd,argv[at],IN_MODIFY|IN_ATTRIB|IN_CLOSE_WRITE|IN_DELETE_SELF
      |IN_MOVE_SELF|IN_UNMOUNT|IN_DONT_FOLLOW)<0||watch_ancestors(argv[at])<0)
      return revoke_child_origin("SOURCE_CHANGE","SOURCE_WATCH_UNAVAILABLE");
  }
  deadline_fd=timerfd_create(CLOCK_MONOTONIC,TFD_NONBLOCK|TFD_CLOEXEC);
  step_fd=timerfd_create(CLOCK_REALTIME,TFD_NONBLOCK|TFD_CLOEXEC);
  struct timespec realtime;if(clock_gettime(CLOCK_REALTIME,&realtime)<0)return 74;
  struct itimerspec deadline_timer={.it_value={.tv_sec=(time_t)(deadline/UINT64_C(1000000000)),.tv_nsec=(long)(deadline%UINT64_C(1000000000))}};
  struct itimerspec step_timer={.it_value={.tv_sec=realtime.tv_sec+3600,.tv_nsec=realtime.tv_nsec}};
  if(deadline_fd<0||step_fd<0||timerfd_settime(deadline_fd,TFD_TIMER_ABSTIME,&deadline_timer,NULL)<0
    ||timerfd_settime(step_fd,TFD_TIMER_ABSTIME|TFD_TIMER_CANCEL_ON_SET,&step_timer,NULL)<0)
    return revoke_child_origin("CLOCK_STEP","ORIGINAL_TIMER_WATCH_UNAVAILABLE");
  const char *bad=census();if(bad)return revoke_child_origin("GUARDIAN_LOSS",bad);
  if(emit("READY",NULL,"ACTUAL_ORIGINAL_KERNEL_CENSUS",0)<0)return 74;
  if(snapshot)return 0;
  char line[MAX_LINE];size_t used=0;
  for(;;){
    struct pollfd waits[7]={{.fd=STDIN_FILENO,.events=POLLIN},{.fd=inotify_fd,.events=POLLIN},
      {.fd=deadline_fd,.events=POLLIN},{.fd=step_fd,.events=POLLIN},
      {.fd=pidfds[0],.events=POLLIN},{.fd=pidfds[1],.events=POLLIN},{.fd=pidfds[2],.events=POLLIN}};
    int result=poll(waits,7,-1);if(result<0){if(errno==EINTR)continue;return revoke_child_origin("PROCESS_LOSS","KERNEL_WATCH_LOST");}
    for(size_t n=0;n<7;n++)if(waits[n].revents&(POLLERR|POLLNVAL))return revoke_child_origin("PROCESS_LOSS","KERNEL_WATCH_LOST");
    if(waits[1].revents&POLLIN){
      char events[16384];ssize_t n=read(inotify_fd,events,sizeof(events));
      if(n<=0)return revoke_child_origin("SOURCE_CHANGE","SOURCE_WATCH_LOST");
      size_t offset=0;
      while(offset<(size_t)n){
        struct inotify_event *event=(struct inotify_event *)(void *)(events+offset);
        if(event->mask&IN_Q_OVERFLOW)return revoke_child_origin("SOURCE_CHANGE","SOURCE_WATCH_OVERFLOW");
        offset+=sizeof(*event)+event->len;
      }
      return revoke_child_origin("SOURCE_CHANGE","SOURCE_MUTATION_OR_WATCH_LOSS");
    }
    if(waits[2].revents&POLLIN)return revoke_child_origin("ABORT","ORIGINAL_DEADLINE");
    if(waits[3].revents&POLLIN)return revoke_child_origin("CLOCK_STEP","ACTUAL_REALTIME_STEP");
    if(waits[4].revents||waits[5].revents||waits[6].revents)return revoke_child_origin("PROCESS_LOSS","ORIGINAL_PIDFD_LOSS");
    if(waits[0].revents&POLLHUP)return revoke_child_origin("PROCESS_LOSS","ORIGINAL_OBSERVER_OWNER_LOST");
    if(waits[0].revents&POLLIN){
      char byte;ssize_t n=read(STDIN_FILENO,&byte,1);
      if(n!=1)return revoke_child_origin("PROCESS_LOSS","ORIGINAL_SOURCE_CHANNEL_LOST");
      if(byte!='\n'){if(used>=sizeof(line)-1)return revoke_child_origin("PROCESS_LOSS","BARRIER_FRAME_BOUND");line[used++]=byte;continue;}
      line[used]='\0';used=0;
      char command[16],nonce[65],target[32],extra;
      if(sscanf(line,"%15s %64s %31s %c",command,nonce,target,&extra)!=3 || strcmp(command,"BARRIER")
        ||!nonce_ok(nonce))return revoke_child_origin("PROCESS_LOSS","BARRIER_FRAME_INVALID");
      unsigned long long through;if(number(target,&through))return revoke_child_origin("CLOCK_STEP","BARRIER_TIME_INVALID");
      memcpy(active_nonce,nonce,65);
      bad=census();if(bad)return revoke_child_origin("GUARDIAN_LOSS",bad);
      if(census_floor<(uint64_t)through)return revoke_child_origin("CLOCK_STEP","BARRIER_BEFORE_REQUIRED_UPPER");
      if(emit("CENSUS",NULL,"ACTUAL_ORIGINAL_KERNEL_CENSUS",0)<0)return 74;
    }
  }
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--peer"))return peer();
  if(argc>1 && !strcmp(argv[1],"--watch"))return run_watch(argc,argv,0);
  if(argc>1 && !strcmp(argv[1],"--snapshot"))return run_watch(argc,argv,1);
  return 64;
}
