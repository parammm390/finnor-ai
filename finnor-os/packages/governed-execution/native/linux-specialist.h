#ifndef FINNOR_LINUX_SPECIALIST_H
#define FINNOR_LINUX_SPECIALIST_H

#include <inttypes.h>
#include <time.h>
#include <sys/vfs.h>

#if !defined(_POSIX_TIMERS) || _POSIX_TIMERS < 0 || !defined(TIMER_ABSTIME)
#error Protected specialist requires POSIX absolute CLOCK_MONOTONIC timers
#endif

/* Opt-in development ABI only. The controller passes one pinned cgroup2
 * directory at fd 5. No path, controller setting or command comes from a guest.
 * The launcher joins before fork/exec, so the trusted guardian, guest and every
 * guest thread share the same aggregate kernel ceilings. */
static void finnor_specialist_read(int group,const char *name,char *out,size_t maximum) {
  int fd=openat(group,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)refuse("SPECIALIST_CONTROL_OPEN");
  ssize_t length=read(fd,out,maximum);
  if(length<0||(size_t)length>=maximum||close(fd))refuse("SPECIALIST_CONTROL_READ");
  while(length>0&&(out[length-1]=='\n'||out[length-1]==' '||out[length-1]=='\t'))length--;
  out[length]=0;
}
static void finnor_specialist_controls(int group) {
  const char *names[]={"cgroup.type","memory.max","memory.swap.max","memory.oom.group",
    "pids.max","cpu.max","cpu.max.burst"};
  const char *values[]={"domain","268435456","0","1","24","100000 100000","0"};
  char value[128];
  for(size_t index=0;index<sizeof(names)/sizeof(names[0]);index++){
    finnor_specialist_read(group,names[index],value,sizeof(value));
    if(strcmp(value,values[index]))refuse("SPECIALIST_AGGREGATE_CONTROL_CHANGED");
  }
}
static void finnor_specialist_join(int group,uid_t uid,struct stat *identity) {
  struct statfs filesystem;
  if(fstat(group,identity)||!S_ISDIR(identity->st_mode)||identity->st_uid!=uid||
    (identity->st_mode&0077)||fstatfs(group,&filesystem)||
    (unsigned long)filesystem.f_type!=0x63677270UL)refuse("SPECIALIST_CGROUP_DESCRIPTOR");
  finnor_specialist_controls(group);
  char members[128];finnor_specialist_read(group,"cgroup.procs",members,sizeof(members));
  if(members[0])refuse("SPECIALIST_CGROUP_NOT_EMPTY");
  int membership=openat(group,"cgroup.procs",O_WRONLY|O_CLOEXEC|O_NOFOLLOW);
  char own[32];int length=snprintf(own,sizeof(own),"%ld",(long)getpid());
  if(membership<0||length<=0||length>=(int)sizeof(own)||
    write(membership,own,(size_t)length)!=length||close(membership))refuse("SPECIALIST_CGROUP_JOIN");
  finnor_specialist_read(group,"cgroup.procs",members,sizeof(members));
  if(strcmp(members,own))refuse("SPECIALIST_CGROUP_MEMBERSHIP");
  finnor_specialist_controls(group);
}
static void finnor_specialist_wall(long milliseconds,uint64_t deadline_nanoseconds) {
  if(milliseconds<100||milliseconds>10000)refuse("SPECIALIST_WALL_BOUND");
  struct timespec now;
  if(clock_gettime(CLOCK_MONOTONIC,&now)||now.tv_sec<0||now.tv_nsec<0||now.tv_nsec>=1000000000L||
    (uint64_t)now.tv_sec>(UINT64_MAX-(uint64_t)now.tv_nsec)/1000000000ULL)
    refuse("SPECIALIST_MONOTONIC_CLOCK");
  uint64_t observed=(uint64_t)now.tv_sec*1000000000ULL+(uint64_t)now.tv_nsec;
  if(deadline_nanoseconds<=observed||
    deadline_nanoseconds-observed>(uint64_t)milliseconds*1000000ULL)
    refuse("SPECIALIST_ORIGINAL_MONOTONIC_DEADLINE");
  uint64_t seconds=deadline_nanoseconds/1000000000ULL;
  time_t absolute_seconds=(time_t)seconds;
  if(absolute_seconds<0||(uint64_t)absolute_seconds!=seconds)
    refuse("SPECIALIST_MONOTONIC_DEADLINE_RANGE");
  pid_t guardian=getpid();
  if(guardian<=1||getpgrp()!=guardian)refuse("SPECIALIST_GUARDIAN_PROCESS_GROUP");
  finnor_guard_group=(sig_atomic_t)guardian;
  struct sigaction stop={.sa_handler=finnor_stop_owned_group};
  sigfillset(&stop.sa_mask);
  sigset_t enabled;sigemptyset(&enabled);
  if(sigaction(SIGALRM,&stop,NULL)||sigaddset(&enabled,SIGALRM)||
    sigprocmask(SIG_UNBLOCK,&enabled,NULL))refuse("SPECIALIST_GUARDIAN_ALARM_HANDLER");
  /* This per-process timer stays in the original nonexecuting guardian across
   * chroot/close_range/fork. POSIX timers are not inherited by its forked guest.
   * A pause before arming cannot turn an expired original deadline into a new
   * relative allowance. An already-past deadline expires immediately. */
  timer_t guardian_timer;
  struct sigevent event={.sigev_notify=SIGEV_SIGNAL,.sigev_signo=SIGALRM};
  struct itimerspec timer={.it_value={absolute_seconds,
    (long)(deadline_nanoseconds%1000000000ULL)}};
  if(timer_create(CLOCK_MONOTONIC,&event,&guardian_timer)||
    timer_settime(guardian_timer,TIMER_ABSTIME,&timer,NULL))
    refuse("SPECIALIST_ABSOLUTE_MONOTONIC_TIMER_UNAVAILABLE");
}

#endif
