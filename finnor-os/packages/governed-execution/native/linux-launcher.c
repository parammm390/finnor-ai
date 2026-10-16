/* Fixed-root, non-root ordinary Node launcher. No caller command/root/policy.
 * File capability is exactly SYS_CHROOT, never setuid-root. It is consumed only
 * by trusted setup; generated code receives zero caps and no-new-privileges. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <openssl/sha.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__x86_64__)
#define JAIL "/opt/finnor-s6-jail-x64/root"
#elif defined(__aarch64__)
#define JAIL "/opt/finnor-s6-jail-arm64/root"
#else
#error Unsupported native kernel ABI
#endif

static void refuse(const char *reason) {
  fprintf(stderr,"ISOLATION_LAUNCHER_REFUSED:%s:%d\n",reason,errno);
  _exit(125);
}
static void caps(struct __user_cap_data_struct data[2]) {
  struct __user_cap_header_struct header={_LINUX_CAPABILITY_VERSION_3,0};
  if(syscall(SYS_capget,&header,data))refuse("CAPGET");
}
static void allow_path(int rules,const char *path,uint64_t rights) {
  int fd=open(path,O_PATH|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)refuse("LANDLOCK_PATH");
  struct landlock_path_beneath_attr rule={.allowed_access=rights,.parent_fd=fd};
  if(syscall(SYS_landlock_add_rule,rules,LANDLOCK_RULE_PATH_BENEATH,&rule,0))refuse("LANDLOCK_RULE");
  if(close(fd))refuse("CLOSE_PATH");
}
int main(int argc,char **argv) {
  uid_t uid=getuid();gid_t gid=getgid();pid_t parent=getppid();
  if(argc!=3||uid==0||getegid()!=gid||geteuid()!=uid||parent<=1)refuse("CALLER");
  if(strlen(argv[1])<5||strlen(argv[1])>80||strncmp(argv[1],"job-",4)||strspn(argv[1],"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")!=strlen(argv[1]))refuse("JOB");
  int writable=!strcmp(argv[2],"rw");
  if(!writable&&strcmp(argv[2],"ro"))refuse("ACCESS");
  struct __user_cap_data_struct before[2]={{0}};caps(before);
  if(before[0].effective!=(1U<<CAP_SYS_CHROOT)||before[0].permitted!=(1U<<CAP_SYS_CHROOT)||before[0].inheritable||before[1].effective||before[1].permitted||before[1].inheritable)refuse("BOOTSTRAP_CAPS");
  struct stat root,filter,receipt;
  if(lstat(JAIL,&root)||!S_ISDIR(root.st_mode)||root.st_uid!=0||(root.st_mode&0022))refuse("ROOT_CUSTODY");
  if(fstat(3,&filter)||!S_ISREG(filter.st_mode)||filter.st_uid!=uid||filter.st_nlink!=1||(filter.st_mode&0077)||filter.st_size<=0||filter.st_size>32768||filter.st_size%sizeof(struct sock_filter))refuse("FILTER_FD");
  if(fstat(4,&receipt)||!S_ISREG(receipt.st_mode)||receipt.st_uid!=uid||receipt.st_nlink!=1||(receipt.st_mode&0077)||receipt.st_size!=0)refuse("RECEIPT_FD");
  struct sock_filter instructions[4096];size_t bytes=(size_t)filter.st_size,offset=0;
  if(bytes>sizeof(instructions))refuse("FILTER_BOUND");
  while(offset<bytes){ssize_t got=read(3,(char *)instructions+offset,bytes-offset);if(got<=0)refuse("FILTER_READ");offset+=(size_t)got;}
  unsigned char digest[SHA256_DIGEST_LENGTH];char filter_hash[SHA256_DIGEST_LENGTH*2+1];
  if(!SHA256((const unsigned char *)instructions,bytes,digest))refuse("FILTER_HASH");
  for(size_t index=0;index<sizeof(digest);index++)snprintf(filter_hash+index*2,3,"%02x",digest[index]);
  if(close(3))refuse("FILTER_CLOSE");
  if(chdir(JAIL)||chroot(".")||chdir("/"))refuse("CHROOT");
  struct __user_cap_header_struct header={_LINUX_CAPABILITY_VERSION_3,0};
  struct __user_cap_data_struct empty[2]={{0}};
  if(syscall(SYS_capset,&header,empty))refuse("DROP_CAPS");
  struct __user_cap_data_struct after[2]={{0}};caps(after);
  if(after[0].effective||after[0].permitted||after[0].inheritable||after[1].effective||after[1].permitted||after[1].inheritable)refuse("CAPS_REMAIN");
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))refuse("NO_NEW_PRIVS");
  /* exec of a capability-bearing helper clears an inherited PDEATHSIG. Reset
   * it after privilege drop and fence the parent-death setup race explicitly. */
  if(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0)||getppid()!=parent)refuse("PARENT_CHANGED");
  int abi=(int)syscall(SYS_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION);
  if(abi<2)refuse("LANDLOCK_ABI");
  /* Exactly ABI-2 filesystem rights. Truncation and metadata holes are closed
   * by the mandatory seccomp filter, not silently treated as mediated here. */
  struct landlock_ruleset_attr attributes={.handled_access_fs=(1ULL<<14)-1};
  int rules=(int)syscall(SYS_landlock_create_ruleset,&attributes,sizeof(attributes),0);
  if(rules<0)refuse("LANDLOCK_CREATE");
  const uint64_t read=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR;
  allow_path(rules,"/node",LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_EXECUTE);
  allow_path(rules,"/lib",read|LANDLOCK_ACCESS_FS_EXECUTE);
  allow_path(rules,"/lib64",read|LANDLOCK_ACCESS_FS_EXECUTE);
  allow_path(rules,"/usr/lib",read|LANDLOCK_ACCESS_FS_EXECUTE);
  allow_path(rules,"/dev/null",LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_WRITE_FILE);
  allow_path(rules,"/dev/random",LANDLOCK_ACCESS_FS_READ_FILE);
  allow_path(rules,"/dev/urandom",LANDLOCK_ACCESS_FS_READ_FILE);
  char job[100],script[128],home[110],temporary[112];
  if(snprintf(job,sizeof(job),"/jobs/%s",argv[1])>=(int)sizeof(job))refuse("JOB_LENGTH");
  struct stat directory;
  if(lstat(job,&directory)||!S_ISDIR(directory.st_mode)||directory.st_uid!=uid||(directory.st_mode&0077))refuse("JOB_CUSTODY");
  uint64_t rights=read;
  if(writable)rights|=LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_REMOVE_DIR|LANDLOCK_ACCESS_FS_REMOVE_FILE|LANDLOCK_ACCESS_FS_MAKE_DIR|LANDLOCK_ACCESS_FS_MAKE_REG|LANDLOCK_ACCESS_FS_MAKE_SYM;
  allow_path(rules,job,rights);
  if(syscall(SYS_landlock_restrict_self,rules,0)||close(rules)||chdir(job))refuse("LANDLOCK_ENFORCE");
  if(syscall(SYS_close_range,5,~0U,0))refuse("EXTRA_DESCRIPTORS");
  struct sock_fprog program={.len=(unsigned short)(bytes/sizeof(struct sock_filter)),.filter=instructions};
  if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))refuse("SECCOMP");
  if(prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1)refuse("PRIVILEGE_RECHECK");
  if(dprintf(4,"{\"schema\":\"finnor.s6.linux-bootstrap.v1\",\"pid\":%ld,\"uid\":%lu,\"capabilities\":0,\"noNewPrivileges\":1,\"fixedJail\":true,\"landlockAbi\":%d,\"filterSha256\":\"%s\"}\n",(long)getpid(),(unsigned long)uid,abi,filter_hash)<0||close(4))refuse("BOOTSTRAP_RECEIPT");
  if(snprintf(script,sizeof(script),"%s/worker.mjs",job)>=(int)sizeof(script)||snprintf(home,sizeof(home),"HOME=%s",job)>=(int)sizeof(home)||snprintf(temporary,sizeof(temporary),"TMPDIR=%s",job)>=(int)sizeof(temporary))refuse("PATH_LENGTH");
  char *const arguments[]={"/node","--max-old-space-size=128","--no-addons",script,NULL};
  char *const environment[]={home,temporary,"LANG=C","TZ=UTC","NODE_ENV=production",NULL};
  execve("/node",arguments,environment);
  refuse("EXEC_NODE");
}
