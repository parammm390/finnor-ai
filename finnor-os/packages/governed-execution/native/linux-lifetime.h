#ifndef FINNOR_LINUX_LIFETIME_H
#define FINNOR_LINUX_LIFETIME_H

#include <errno.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct finnor_lifetime {pid_t original_parent,guardian_pid;};
static volatile sig_atomic_t finnor_guard_group;

static void finnor_stop_owned_group(int signal_number) {
  pid_t group=(pid_t)finnor_guard_group;
  if(group>1)(void)kill(-group,SIGKILL);
  _exit(128+signal_number);
}

/* Only the guest returns. The trusted guardian never executes guest code.
 * Call after privilege drop, chroot and Landlock, before guest seccomp. */
static int finnor_start_lifetime_guard(pid_t original_parent,int guardian_close_fd,
                                     struct finnor_lifetime *identity) {
  pid_t guardian=getpid();
  if(guardian<=1||original_parent<1||getppid()!=original_parent||getpgrp()!=guardian){errno=EPERM;return -1;}
  finnor_guard_group=(sig_atomic_t)guardian;
  const int watched[]={SIGUSR1,SIGTERM,SIGINT,SIGHUP,SIGALRM};
  struct sigaction action={.sa_handler=finnor_stop_owned_group};
  sigfillset(&action.sa_mask);
  sigset_t enabled;sigemptyset(&enabled);
  for(size_t i=0;i<sizeof(watched)/sizeof(watched[0]);i++)
    if(sigaction(watched[i],&action,NULL)||sigaddset(&enabled,watched[i]))return -1;
  if(sigprocmask(SIG_UNBLOCK,&enabled,NULL))return -1;
  if(prctl(PR_SET_PDEATHSIG,SIGUSR1,0,0,0)||getppid()!=original_parent)return -1;
  pid_t guest=fork();
  if(guest<0)return -1;
  if(!guest){
    action.sa_handler=SIG_DFL;
    sigemptyset(&action.sa_mask);
    for(size_t i=0;i<sizeof(watched)/sizeof(watched[0]);i++)
      if(sigaction(watched[i],&action,NULL))_exit(125);
    if(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0)||getppid()!=guardian)_exit(125);
    *identity=(struct finnor_lifetime){original_parent,guardian};
    return 0;
  }
  if(guardian_close_fd>=0&&close(guardian_close_fd))finnor_stop_owned_group(SIGTERM);
  int status;
  for(;;){
    pid_t observed=waitpid(guest,&status,0);
    if(observed==guest)break;
    if(observed<0&&errno==EINTR)continue;
    finnor_stop_owned_group(SIGTERM);
  }
  if(WIFEXITED(status))_exit(WEXITSTATUS(status));
  if(WIFSIGNALED(status)){
    int number=WTERMSIG(status);
    action.sa_handler=SIG_DFL;
    sigemptyset(&action.sa_mask);
    if(sigaction(number,&action,NULL)&&number!=SIGKILL)_exit(125);
    sigset_t unblocked;sigemptyset(&unblocked);sigaddset(&unblocked,number);
    if(sigprocmask(SIG_UNBLOCK,&unblocked,NULL)||kill(guardian,number))_exit(125);
    _exit(128+number);
  }
  _exit(125);
}

#endif
