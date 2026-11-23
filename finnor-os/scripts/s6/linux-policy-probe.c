/* Test support only. The controller never installs seccomp. Only its disposable
 * children do; every process and IPC object targeted here belongs to this run. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/sched/types.h>
#include <linux/seccomp.h>
#include <linux/sockios.h>
#include <mqueue.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "../../packages/governed-execution/native/linux-lifetime.h"

union semun { int val; struct semid_ds *buf; unsigned short *array; };
struct outcome { long result; int error; };
struct target_state {
  unsigned long long soft,hard;
  int signals,nice,policy,cpus,ioprio;
};
static int shm_id=-1,msg_id=-1,sem_id=-1;
static key_t shm_key,msg_key,sem_key;
static char *shared=(void *)-1;
static mqd_t posix_queue=(mqd_t)-1;
static char posix_name[96];
static pid_t target=-1,attacker=-1;
static pid_t owned_group=-1;
static volatile sig_atomic_t signals_seen;
static struct sock_filter filter[4096];
static struct sock_fprog program;

static int remove_posix_queue(void) {
  if(posix_queue==(mqd_t)-1)return 0;
  int failed=0;
  struct stat owned,named;
  if(fstat((int)posix_queue,&owned))return 1;
  mqd_t current=mq_open(posix_name,O_RDONLY|O_NONBLOCK);
  if(current!=(mqd_t)-1){
    if(fstat((int)current,&named)||owned.st_dev!=named.st_dev||owned.st_ino!=named.st_ino)failed=1;
    else if(mq_unlink(posix_name))failed=1;
    if(mq_close(current))failed=1;
  }else if(errno!=ENOENT)failed=1;
  if(mq_close(posix_queue))failed=1;
  posix_queue=(mqd_t)-1;
  current=mq_open(posix_name,O_RDONLY|O_NONBLOCK);
  if(current!=(mqd_t)-1){failed=1;if(mq_close(current))failed=1;}
  else if(errno!=ENOENT)failed=1;
  return failed;
}
static int cleanup(void) {
  int failed=0,status;
  if(owned_group>1){if(kill(-owned_group,SIGKILL)&&errno!=ESRCH)failed=1;owned_group=-1;}
  if(attacker>0){if(kill(attacker,SIGKILL)&&errno!=ESRCH)failed=1;if(waitpid(attacker,&status,0)<0&&errno!=ECHILD)failed=1;attacker=-1;}
  if(target>0){if(kill(target,SIGKILL)&&errno!=ESRCH)failed=1;if(waitpid(target,&status,0)<0&&errno!=ECHILD)failed=1;target=-1;}
  if(remove_posix_queue())failed=1;
  if(shared!=(void *)-1){if(shmdt(shared))failed=1;shared=(void *)-1;}
  if(shm_id>=0){
    if(shmctl(shm_id,IPC_RMID,NULL))failed=1;
    struct shmid_ds state;errno=0;
    if(!shmctl(shm_id,IPC_STAT,&state)||(errno!=EINVAL&&errno!=EIDRM))failed=1;
    shm_id=-1;
  }
  if(msg_id>=0){
    if(msgctl(msg_id,IPC_RMID,NULL))failed=1;
    struct msqid_ds state;errno=0;
    if(!msgctl(msg_id,IPC_STAT,&state)||(errno!=EINVAL&&errno!=EIDRM))failed=1;
    msg_id=-1;
  }
  if(sem_id>=0){
    if(semctl(sem_id,0,IPC_RMID))failed=1;
    errno=0;
    if(semctl(sem_id,0,GETVAL)>=0||(errno!=EINVAL&&errno!=EIDRM))failed=1;
    sem_id=-1;
  }
  return failed;
}
static void stopped(int signum) {
  int failed=cleanup();
  _exit(failed?126:128+signum);
}
static void die(const char *what) {
  int saved=errno;fprintf(stderr,"POLICY_PROBE_SETUP:%s:%d\n",what,saved);
  (void)cleanup();exit(125);
}
static void transfer(int fd,void *data,size_t bytes,int writing) {
  char *p=data;
  while(bytes){
    ssize_t n=writing?write(fd,p,bytes):read(fd,p,bytes);
    if(n<0&&errno==EINTR)continue;
    if(n<=0)die("TRANSFER");
    p+=n;bytes-=(size_t)n;
  }
}
static void child_guard(pid_t parent) {
  signal(SIGALRM,SIG_DFL);signal(SIGTERM,SIG_DFL);signal(SIGINT,SIG_DFL);
  alarm(3);
  if(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0)||getppid()!=parent)_exit(125);
  struct rlimit core={0,0};
  if(setrlimit(RLIMIT_CORE,&core))_exit(125);
}
static void load_filter(const char *path) {
  int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);struct stat st;
  if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||
     st.st_size<=0||st.st_size>(off_t)sizeof(filter)||st.st_size%sizeof(filter[0]))die("FILTER");
  transfer(fd,filter,(size_t)st.st_size,0);
  if(close(fd))die("FILTER_CLOSE");
  program.len=(unsigned short)(st.st_size/sizeof(filter[0]));program.filter=filter;
}
static void install(void) {
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||
     prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))_exit(125);
}
static void seen(int signum) {(void)signum;signals_seen++;}
static struct target_state observe(void) {
  struct rlimit limits;cpu_set_t affinity;
  if(getrlimit(RLIMIT_NOFILE,&limits)||sched_getaffinity(0,sizeof(affinity),&affinity))_exit(125);
  return (struct target_state){limits.rlim_cur,limits.rlim_max,(int)signals_seen,
    getpriority(PRIO_PROCESS,0),sched_getscheduler(0),CPU_COUNT(&affinity),
    (int)syscall(SYS_ioprio_get,1,0)};
}
static void target_loop(int input,int output,pid_t parent) {
  child_guard(parent);alarm(5);
  if(setpgid(0,0))_exit(125);
  struct sigaction action={.sa_handler=seen,.sa_flags=SA_RESTART};
  sigemptyset(&action.sa_mask);
  if(sigaction(SIGUSR1,&action,NULL)||sigaction(SIGIO,&action,NULL))_exit(125);
  char ready='R';transfer(output,&ready,1,1);
  for(;;){
    char command;transfer(input,&command,1,0);
    if(command=='Q')_exit(0);
    struct target_state state=observe();transfer(output,&state,sizeof(state),1);
  }
}
static struct target_state target_observation(int input,int output) {
  char command='S';struct target_state state;
  transfer(input,&command,1,1);transfer(output,&state,sizeof(state),0);return state;
}
static long async_owner(int fd,int other,const char *name) {
  long result;int id=(int)target;
  if(!strcmp(name,"fcntl-owner-ex")){
    struct f_owner_ex owner={.type=F_OWNER_PID,.pid=target};
    return fcntl(fd,F_SETOWN_EX,&owner);
  }
  if(!strcmp(name,"fcntl-signal"))return fcntl(fd,F_SETSIG,SIGUSR1);
  if(!strcmp(name,"fcntl-async"))return fcntl(fd,F_SETFL,O_NONBLOCK|O_ASYNC);
  if(!strcmp(name,"ioctl-async")){int yes=1;return ioctl(fd,FIOASYNC,&yes);}
  if(!strcmp(name,"ioctl-owner"))result=ioctl(fd,FIOSETOWN,&id);
  else if(!strcmp(name,"ioctl-pgrp"))result=ioctl(fd,SIOCSPGRP,&id);
  else result=fcntl(fd,F_SETOWN,target);
  if(result<0)return result;
  if(fcntl(fd,F_SETSIG,SIGUSR1)||fcntl(fd,F_SETFL,O_NONBLOCK|O_ASYNC))return -1;
  char byte='X';return write(other,&byte,1)==1?0:-1;
}
static long attempt(const char *name,int sockets[2],int lease,int directory) {
  siginfo_t info={0};info.si_signo=SIGUSR1;info.si_code=SI_QUEUE;
  info.si_pid=getpid();info.si_uid=getuid();info.si_value.sival_int=42;
  struct rlimit limits={16,64};struct sched_param parameter={.sched_priority=0};
  struct sembuf operation={.sem_num=0,.sem_op=-1,.sem_flg=IPC_NOWAIT};
  struct timespec no_wait={0,0};
  struct {long type;char text[8];} message={1,"CHANGED"};
  if(!strcmp(name,"rt_sigqueueinfo"))return syscall(SYS_rt_sigqueueinfo,target,SIGUSR1,&info);
  if(!strcmp(name,"rt_tgsigqueueinfo"))return syscall(SYS_rt_tgsigqueueinfo,target,target,SIGUSR1,&info);
  if(!strcmp(name,"kill"))return syscall(SYS_kill,target,SIGUSR1);
  if(!strcmp(name,"tkill"))return syscall(SYS_tkill,target,SIGUSR1);
  if(!strcmp(name,"tgkill"))return syscall(SYS_tgkill,target,target,SIGUSR1);
  if(!strcmp(name,"prlimit-peer"))return syscall(SYS_prlimit64,target,RLIMIT_NOFILE,&limits,NULL);
  if(!strcmp(name,"priority-peer"))return syscall(SYS_setpriority,PRIO_PROCESS,target,19);
  if(!strcmp(name,"sched-param-peer"))return syscall(SYS_sched_setparam,target,&parameter);
  if(!strcmp(name,"sched-policy-peer"))return syscall(SYS_sched_setscheduler,target,SCHED_BATCH,&parameter);
  if(!strcmp(name,"sched-affinity-peer")){
    cpu_set_t old,one;CPU_ZERO(&one);
    if(sched_getaffinity(0,sizeof(old),&old))return -1;
    for(int cpu=0;cpu<CPU_SETSIZE;cpu++)if(CPU_ISSET(cpu,&old)){CPU_SET(cpu,&one);break;}
    return syscall(SYS_sched_setaffinity,target,sizeof(one),&one);
  }
  if(!strcmp(name,"sched-attr-peer")){
    struct sched_attr attr={.size=sizeof(attr),.sched_policy=SCHED_OTHER,.sched_nice=19};
    return syscall(SYS_sched_setattr,target,&attr,0);
  }
  if(!strcmp(name,"ioprio-peer"))return syscall(SYS_ioprio_set,1,target,3<<13);
  if(!strcmp(name,"fcntl-lease"))return fcntl(lease,F_SETLEASE,F_RDLCK);
  if(!strcmp(name,"fcntl-dnotify"))return fcntl(directory,F_NOTIFY,DN_CREATE);
  if(!strncmp(name,"fcntl-",6)||!strncmp(name,"ioctl-",6))return async_owner(sockets[0],sockets[1],name);
  if(!strcmp(name,"shmget"))return shmget(shm_key,64,0600);
  if(!strcmp(name,"shmat-write")){
    char *p=shmat(shm_id,NULL,0);
    if(p==(void *)-1)return -1;
    memcpy(p,"CHANGED",8);return shmdt(p);
  }
  if(!strcmp(name,"shmctl")){struct shmid_ds state;return shmctl(shm_id,IPC_STAT,&state);}
  if(!strcmp(name,"shmdt"))return shmdt(shared);
  if(!strcmp(name,"msgget"))return msgget(msg_key,0600);
  if(!strcmp(name,"msgsnd"))return msgsnd(msg_id,&message,sizeof(message.text),IPC_NOWAIT);
  if(!strcmp(name,"msgrcv"))return msgrcv(msg_id,&message,sizeof(message.text),0,IPC_NOWAIT);
  if(!strcmp(name,"msgctl")){struct msqid_ds state;return msgctl(msg_id,IPC_STAT,&state);}
  if(!strcmp(name,"semget"))return semget(sem_key,1,0600);
  if(!strcmp(name,"semctl"))return semctl(sem_id,0,GETVAL);
  if(!strcmp(name,"semop"))return semop(sem_id,&operation,1);
  if(!strcmp(name,"semtimedop"))return semtimedop(sem_id,&operation,1,&no_wait);
  if(!strcmp(name,"mq-open"))return syscall(SYS_mq_open,posix_name+1,O_RDONLY|O_NONBLOCK,0,NULL);
  if(!strcmp(name,"mq-unlink"))return syscall(SYS_mq_unlink,posix_name+1);
  if(!strcmp(name,"mq-timedsend"))return syscall(SYS_mq_timedsend,posix_queue,message.text,sizeof(message.text),1,&no_wait);
  if(!strcmp(name,"mq-timedreceive")){
    unsigned priority=0;
    return syscall(SYS_mq_timedreceive,posix_queue,message.text,sizeof(message.text),&priority,&no_wait);
  }
  if(!strcmp(name,"mq-notify")){
    struct sigevent notification={.sigev_notify=SIGEV_NONE};
    return syscall(SYS_mq_notify,posix_queue,&notification);
  }
  if(!strcmp(name,"mq-getsetattr")){
    struct mq_attr attributes={.mq_flags=0};
    return syscall(SYS_mq_getsetattr,posix_queue,&attributes,NULL);
  }
  if(!strcmp(name,"prlimit-self-get"))return syscall(SYS_prlimit64,0,RLIMIT_NOFILE,NULL,&limits);
  if(!strcmp(name,"prlimit-self-set")){
    if(syscall(SYS_prlimit64,0,RLIMIT_NOFILE,NULL,&limits))return -1;
    return syscall(SYS_prlimit64,0,RLIMIT_NOFILE,&limits,NULL);
  }
  if(!strcmp(name,"priority-self"))return syscall(SYS_setpriority,PRIO_PROCESS,0,19);
  if(!strcmp(name,"sched-self"))return syscall(SYS_sched_setparam,0,&parameter);
  errno=EINVAL;return -1;
}
struct posix_state {long messages,flags;int named;};
static struct posix_state observe_posix(void) {
  struct mq_attr attributes;
  if(mq_getattr(posix_queue,&attributes))die("POSIX_QUEUE_OBSERVE");
  mqd_t named=mq_open(posix_name,O_RDONLY|O_NONBLOCK);
  int present=named!=(mqd_t)-1;
  if(present){
    struct stat owned,opened;
    if(fstat((int)posix_queue,&owned)||fstat((int)named,&opened)||owned.st_dev!=opened.st_dev||owned.st_ino!=opened.st_ino)die("POSIX_QUEUE_IDENTITY");
    if(mq_close(named))die("POSIX_QUEUE_OBSERVE_CLOSE");
  }else if(errno!=ENOENT)die("POSIX_QUEUE_NAME_OBSERVE");
  return (struct posix_state){attributes.mq_curmsgs,attributes.mq_flags,present};
}
static void print_state(const struct target_state *s,int queued,int value,const char *memory,struct posix_state queue) {
  printf("{\"soft\":%llu,\"hard\":%llu,\"signals\":%d,\"nice\":%d,\"policy\":%d,\"cpus\":%d,\"ioprio\":%d,\"messages\":%d,\"semaphore\":%d,\"memory\":\"%s\",\"posixQueue\":{\"messages\":%ld,\"flags\":%ld,\"named\":%d}}",
    s->soft,s->hard,s->signals,s->nice,s->policy,s->cpus,s->ioprio,queued,value,memory,queue.messages,queue.flags,queue.named);
}
static void ipc_state(int *queued,int *value) {
  struct msqid_ds state;
  if(msgctl(msg_id,IPC_STAT,&state))die("QUEUE_OBSERVE");
  *queued=(int)state.msg_qnum;*value=semctl(sem_id,0,GETVAL);
  if(*value<0)die("SEMAPHORE_OBSERVE");
}
static void reset_ipc(void) {
  if(remove_posix_queue())die("POSIX_QUEUE_RESET_REMOVE");
  struct mq_attr attributes={.mq_maxmsg=4,.mq_msgsize=8};
  posix_queue=mq_open(posix_name,O_CREAT|O_EXCL|O_RDWR|O_NONBLOCK,0600,&attributes);
  if(posix_queue==(mqd_t)-1)die("POSIX_QUEUE_EXCLUSIVE_CREATE");
  if(mq_send(posix_queue,"SAFE",5,0))die("POSIX_QUEUE_SEED");
  memcpy(shared,"SAFE",5);
  union semun argument={.val=2};
  if(semctl(sem_id,0,SETVAL,argument))die("SEMAPHORE_RESET");
  struct {long type;char text[8];} message={1,"SAFE"};
  while(msgrcv(msg_id,&message,sizeof(message.text),0,IPC_NOWAIT)>=0){}
  if(errno!=ENOMSG)die("QUEUE_DRAIN");
  memcpy(message.text,"SAFE",5);
  if(msgsnd(msg_id,&message,sizeof(message.text),IPC_NOWAIT))die("QUEUE_RESET");
}
struct lifetime_notice {int phase;pid_t pid,tid,parent,group;int parent_death_signal;};
struct thread_exec {int output;char **arguments;};
static struct lifetime_notice lifetime_notice(int phase) {
  int death=0;
  if(prctl(PR_GET_PDEATHSIG,&death,0,0,0))_exit(125);
  return (struct lifetime_notice){phase,getpid(),(pid_t)syscall(SYS_gettid),getppid(),getpgrp(),death};
}
static void *thread_exec(void *raw) {
  struct thread_exec *context=raw;
  struct lifetime_notice notice=lifetime_notice(1);
  transfer(context->output,&notice,sizeof(notice),1);
  execv(context->arguments[0],context->arguments);
  _exit(125);
}
static int lifetime_case(const char *binary,const char *filter_path,int guarded) {
  int channel[2],status;
  signal(SIGTERM,stopped);signal(SIGINT,stopped);signal(SIGALRM,stopped);alarm(10);
  if(prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)||pipe(channel))die("LIFETIME_CONTROLLER_SETUP");
  pid_t controller=getpid();
  fflush(stdout);target=fork();if(target<0)die("LIFETIME_SUPERVISOR_FORK");
  if(!target){
    child_guard(controller);alarm(5);
    if(close(channel[0]))_exit(125);
    pid_t supervisor=getpid(),launcher=fork();
    if(launcher<0)_exit(125);
    if(!launcher){
      if(setpgid(0,0))_exit(125);
      child_guard(supervisor);
      if(guarded){
        struct finnor_lifetime identity;
        if(finnor_start_lifetime_guard(supervisor,channel[1],&identity))_exit(125);
      }
      alarm(3);install();
      char descriptor[32];
      if(snprintf(descriptor,sizeof(descriptor),"%d",channel[1])>=(int)sizeof(descriptor))_exit(125);
      char *arguments[]={(char *)binary,(char *)filter_path,"lifetime-reexec",descriptor,NULL};
      struct thread_exec context={channel[1],arguments};pthread_t thread;
      if(pthread_create(&thread,NULL,thread_exec,&context))_exit(125);
      for(;;)pause();
    }
    if(setpgid(launcher,launcher)&&errno!=EACCES)_exit(125);
    struct lifetime_notice created={.phase=0,.pid=launcher,.parent=supervisor,.group=launcher};
    transfer(channel[1],&created,sizeof(created),1);
    if(close(channel[1]))_exit(125);
    for(;;)pause();
  }
  if(close(channel[1]))die("LIFETIME_PARENT_CHANNEL_CLOSE");
  struct lifetime_notice created={0},thread={0},reexec={0};
  /* The supervisor and guest share a pipe, so phase zero can race the real
   * thread's first notice. Read all three phases and bind them by identity. */
  int found[3]={0,0,0};
  for(int i=0;i<3;i++){
    struct lifetime_notice notice;transfer(channel[0],&notice,sizeof(notice),0);
    if(notice.phase<0||notice.phase>2||found[notice.phase]++)die("LIFETIME_NOTICE_PHASE");
    if(notice.phase==0){
      created=notice;
      if(created.pid<=1||created.parent!=target||created.group!=created.pid||
          created.group==getpgrp()||getpgid(created.pid)!=created.group)die("LIFETIME_OWNED_GROUP");
      owned_group=created.group;
    }else if(notice.phase==1)thread=notice;
    else reexec=notice;
  }
  if(!found[0]||!found[1]||!found[2])die("LIFETIME_NOTICE_COMPLETENESS");
  if(close(channel[0]))die("LIFETIME_CONTROLLER_CHANNEL_CLOSE");
  if(thread.pid!=reexec.pid||thread.tid==thread.pid||reexec.tid!=reexec.pid||
      thread.parent_death_signal||reexec.parent_death_signal||
      thread.group!=created.group||reexec.group!=created.group||
      reexec.parent!=(guarded?created.pid:target))die("LIFETIME_REAL_THREADED_EXEC_REQUIRED");
  pid_t supervisor=target;
  struct timespec killed,observed;
  if(clock_gettime(CLOCK_MONOTONIC,&killed))die("LIFETIME_KILL_CLOCK");
  if(kill(target,SIGKILL)||waitpid(target,&status,0)!=target||!WIFSIGNALED(status)||WTERMSIG(status)!=SIGKILL)die("LIFETIME_ORIGINAL_SUPERVISOR_KILL");
  target=-1;
  struct timespec delay={0,200000000};
  while(nanosleep(&delay,&delay)&&errno==EINTR){}
  pid_t waited=waitpid(reexec.pid,&status,WNOHANG);
  int alive=waited==0;
  if(waited<0){if(errno!=ECHILD)die("LIFETIME_GUEST_OBSERVE");alive=kill(reexec.pid,0)==0;}
  if(clock_gettime(CLOCK_MONOTONIC,&observed))die("LIFETIME_OBSERVATION_CLOCK");
  double milliseconds=(observed.tv_sec-killed.tv_sec)*1000.0+(observed.tv_nsec-killed.tv_nsec)/1000000.0;
  if(milliseconds<100||milliseconds>=1000)die("LIFETIME_OBSERVATION_MUST_PRECEDE_SAFETY_ALARM");
  if(kill(-owned_group,SIGKILL)&&errno!=ESRCH)die("LIFETIME_OWNED_GROUP_CLEANUP");
  int reaped=waited>0?1:0,complete=0;
  for(int i=0;i<200;i++){
    pid_t child=waitpid(-1,&status,WNOHANG);
    if(child>0){reaped++;continue;}
    if(child<0){if(errno!=ECHILD)die("LIFETIME_REAP");complete=1;break;}
    struct timespec interval={0,10000000};nanosleep(&interval,NULL);
  }
  if(!complete)die("LIFETIME_OWNED_CHILDREN_REMAIN");
  owned_group=-1;
  printf("{\"kind\":\"threaded-reexec-lifetime\",\"originalMechanism\":%s,\"supervisorPid\":%ld,\"group\":%ld,\"preExecPid\":%ld,\"preExecTid\":%ld,\"postExecPid\":%ld,\"postExecTid\":%ld,\"postExecParent\":%ld,\"postExecParentDeathSignal\":%d,\"aliveAfterSupervisorDeath\":%s,\"observationAfterKillMs\":%.3f,\"allOwnedChildrenReaped\":true,\"reaped\":%d}\n",
    guarded?"false":"true",(long)supervisor,(long)created.group,(long)thread.pid,(long)thread.tid,
    (long)reexec.pid,(long)reexec.tid,(long)reexec.parent,reexec.parent_death_signal,alive?"true":"false",milliseconds,reaped);
  return 0;
}
int main(int argc,char **argv) {
  if(argc<3||getuid()==0)return 125;
  load_filter(argv[1]);pid_t controller=getpid();
  if(!strcmp(argv[2],"lifetime-reexec")){
    if(argc!=4)return 125;
    char *end=NULL;long descriptor=strtol(argv[3],&end,10);
    if(!argv[3][0]||*end||descriptor<3||descriptor>1024)return 125;
    alarm(3);
    struct lifetime_notice notice=lifetime_notice(2);
    transfer((int)descriptor,&notice,sizeof(notice),1);
    if(close((int)descriptor))return 125;
    for(;;)pause();
  }
  if(!strcmp(argv[2],"lifetime")||!strcmp(argv[2],"lifetime-original"))
    return lifetime_case(argv[0],argv[1],!strcmp(argv[2],"lifetime"));
  if(!strcmp(argv[2],"verify")||!strcmp(argv[2],"x32")){
    child_guard(getppid());install();
    if(!strcmp(argv[2],"x32"))(void)syscall((long)SYS_getpid|0x40000000L);
    else (void)syscall(SYS_getpid);
    _exit(0);
  }
  if(!strcmp(argv[2],"node")){
    if(argc!=5)return 125;
    child_guard(getppid());alarm(10);install();
    char *arguments[]={argv[3],"--max-old-space-size=128","--no-addons",argv[4],NULL};
    execv(argv[3],arguments);_exit(125);
  }
  if(strcmp(argv[2],"cases")||argc!=4)return 125;
  signal(SIGTERM,stopped);signal(SIGINT,stopped);signal(SIGALRM,stopped);alarm(90);
  if(prctl(PR_SET_PDEATHSIG,SIGTERM,0,0,0))die("CONTROLLER_PARENT_GUARD");
  shm_key=ftok(argv[3],'A');msg_key=ftok(argv[3],'B');sem_key=ftok(argv[3],'C');
  struct stat controlled;
  if(stat(argv[3],&controlled)||snprintf(posix_name,sizeof(posix_name),"/finnor-s6-policy-%ld-%llu",
      (long)getpid(),(unsigned long long)controlled.st_ino)>=(int)sizeof(posix_name))die("POSIX_QUEUE_NAME");
  printf("{\"kind\":\"owned-posix-queue\",\"name\":\"%s\",\"exclusiveCreate\":true}\n",posix_name);
  if(shm_key==-1||msg_key==-1||sem_key==-1)die("TEST_KEYS");
  shm_id=shmget(shm_key,64,IPC_CREAT|IPC_EXCL|0600);
  if(shm_id<0)die("SHM_CREATE");
  shared=shmat(shm_id,NULL,0);if(shared==(void *)-1)die("SHM_ATTACH");
  msg_id=msgget(msg_key,IPC_CREAT|IPC_EXCL|0600);if(msg_id<0)die("QUEUE_CREATE");
  sem_id=semget(sem_key,1,IPC_CREAT|IPC_EXCL|0600);if(sem_id<0)die("SEMAPHORE_CREATE");
  printf("{\"kind\":\"owned-ipc\",\"uid\":%lu,\"shmid\":%d,\"msgid\":%d,\"semid\":%d,\"shmKey\":%ld,\"msgKey\":%ld,\"semKey\":%ld}\n",
    (unsigned long)getuid(),shm_id,msg_id,sem_id,(long)shm_key,(long)msg_key,(long)sem_key);
  const char *names[]={"rt_sigqueueinfo","rt_tgsigqueueinfo","prlimit-peer",
    "kill","tkill","tgkill","priority-peer","sched-param-peer","sched-policy-peer",
    "sched-affinity-peer","sched-attr-peer","ioprio-peer","fcntl-owner","fcntl-owner-ex",
    "fcntl-signal","fcntl-async","fcntl-lease","fcntl-dnotify","ioctl-owner","ioctl-pgrp","ioctl-async",
    "shmget","shmat-write","shmctl","shmdt","msgget","msgsnd","msgrcv","msgctl",
    "semget","semctl","semop","semtimedop","mq-open","mq-timedsend","mq-timedreceive",
    "mq-notify","mq-getsetattr","mq-unlink","prlimit-self-get","prlimit-self-set","priority-self","sched-self"};
  for(size_t index=0;index<sizeof(names)/sizeof(names[0]);index++){
    reset_ipc();
    int query[2],reply[2],result[2],sockets[2],status;
    if(pipe(query)||pipe(reply)||pipe(result)||socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,sockets))die("CHANNELS");
    int directory=open(argv[3],O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    char lease_path[4096];
    if(snprintf(lease_path,sizeof(lease_path),"%s/lease",argv[3])>=(int)sizeof(lease_path))die("LEASE_PATH");
    int create=open(lease_path,O_WRONLY|O_CREAT|O_CLOEXEC,0600);
    if(create<0||close(create))die("LEASE_CREATE");
    int lease=open(lease_path,O_RDONLY|O_CLOEXEC);if(directory<0||lease<0)die("FIXTURE_FILES");
    fflush(stdout);target=fork();if(target<0)die("TARGET_FORK");
    if(!target)target_loop(query[0],reply[1],controller);
    char ready;transfer(reply[0],&ready,1,0);if(ready!='R')die("TARGET_READY");
    struct target_state before=target_observation(query[1],reply[0]);
    int queued_before,value_before;ipc_state(&queued_before,&value_before);
    struct posix_state posix_before=observe_posix();
    char memory_before[16];snprintf(memory_before,sizeof(memory_before),"%s",shared);
    attacker=fork();if(attacker<0)die("ATTACKER_FORK");
    if(!attacker){
      child_guard(controller);install();errno=0;
      long value=attempt(names[index],sockets,lease,directory);
      struct outcome out={value,value<0?errno:0};
      transfer(result[1],&out,sizeof(out),1);_exit(0);
    }
    if(close(result[1]))die("RESULT_CLOSE");
    struct outcome out;transfer(result[0],&out,sizeof(out),0);
    if(waitpid(attacker,&status,0)!=attacker||!WIFEXITED(status)||WEXITSTATUS(status))die("ATTACKER_EXIT");
    attacker=-1;
    struct target_state after=target_observation(query[1],reply[0]);
    int queued_after,value_after;ipc_state(&queued_after,&value_after);
    struct posix_state posix_after=observe_posix();
    printf("{\"kind\":\"case\",\"name\":\"%s\",\"targetPid\":%ld,\"result\":%ld,\"errno\":%d,\"before\":",
      names[index],(long)target,out.result,out.error);
    print_state(&before,queued_before,value_before,memory_before,posix_before);printf(",\"after\":");
    print_state(&after,queued_after,value_after,shared,posix_after);printf("}\n");fflush(stdout);
    char quit='Q';transfer(query[1],&quit,1,1);
    if(waitpid(target,&status,0)!=target||!WIFEXITED(status)||WEXITSTATUS(status))die("TARGET_EXIT");
    target=-1;
    int descriptors[]={query[0],query[1],reply[0],reply[1],result[0],sockets[0],sockets[1],lease,directory};
    for(size_t i=0;i<sizeof(descriptors)/sizeof(descriptors[0]);i++)if(close(descriptors[i]))die("DESCRIPTOR_CLOSE");
  }
  int failed=cleanup();
  printf("{\"kind\":\"cleanup\",\"ownedIPCRemoved\":%s,\"allChildrenReaped\":true}\n",failed?"false":"true");
  return failed?1:0;
}
