/** Linux native ABI cBPF, including an ABI check and x32 refusal. No caller policy.
 * Threads must share VM/signal handlers/thread group and use only pthread flags.
 * clone3 returns ENOSYS so libc may use the separately checked clone syscall. */
export function nodeFilter(architecture: string): Buffer {
  const arm = architecture === 'arm64';
  const instructions: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], [0x15, 1, 0, arm ? 0xc00000b7 : 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
    [0x15, 0, 1, 435], [0x06, 0, 0, 0x00050026],
  ];
  const denied = arm ? [198, 199, 117, 33, 41, 40, 39, 224, 225, 142, 273, 105,
    106, 104, 217, 218, 219, 97, 265, 268, 270, 271, 280, 282, 425, 438]
    : [41, 53, 57, 58, 101, 133, 155, 165, 166, 167, 168, 169,
      175, 176, 246, 248, 249, 250, 259, 272, 304, 308, 310, 311, 313, 321, 323, 425, 438];
  // Landlock ABI 2 cannot mediate truncation, xattrs or chmod/utime. A fixed
  // root hides host metadata; these syscall denials protect sibling jobs too.
  denied.push(...(arm ? [45,46,52,53,54,55,88,129,130,131,154,157,...Array.from({length:12},(_,i)=>5+i)]
    : [76,77,90,91,92,93,94,132,235,261,268,260,280,62,200,234,109,112,...Array.from({length:12},(_,i)=>188+i)]),424,434,437,452);
  // Chroot and filesystem Landlock do not mediate signals, process memory or
  // System V or POSIX message queues. Deny both queued-signal APIs and every
  // native IPC family, whose namespace is independent of the filesystem root.
  denied.push(...(arm
    ? [138,240,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,238,239,241,272]
    : [129,297,29,30,31,64,65,66,67,68,69,70,71,220,240,241,242,243,244,245,256,279,298,312]),440,448);
  for (const syscall of denied)
    instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  // PID zero is an unambiguous kernel self target. In particular libc uses
  // prlimit64(0, ...) during Node startup. Never substitute the supervisor PID.
  const onlyArguments = (syscall: number, checks: Array<[number,number]>) => {
    const block: Array<[number,number,number,number]> = [];
    for (const [offset,value] of checks)
      block.push([0x20,0,0,offset+4],[0x15,1,0,0],[0x06,0,0,0x00050001],
        [0x20,0,0,offset],[0x15,1,0,value],[0x06,0,0,0x00050001]);
    block.push([0x20,0,0,0]);
    instructions.push([0x15,0,block.length,syscall],...block);
  };
  for (const syscall of (arm ? [261,118,119,122,274] : [302,142,144,203,314]))
    onlyArguments(syscall,[[16,0]]);
  // A zero group/user selector is not self: it can include sibling processes.
  onlyArguments(arm?140:141,[[16,0],[24,0]]); // setpriority(PRIO_PROCESS, 0)
  onlyArguments(arm?30:251,[[16,1],[24,0]]); // ioprio_set(IOPRIO_WHO_PROCESS, 0)
  // Inherited stdio can be Unix sockets. Prevent asynchronous I/O/lease/dnotify
  // signal ownership from bypassing the direct signal syscall restrictions.
  const denyCommands = (syscall: number, commands: number[], asynchronous = false) => {
    const block: Array<[number,number,number,number]> = [[0x20,0,0,24]];
    for (const command of commands)
      block.push([0x15,0,1,command],[0x06,0,0,0x00050001]);
    if (asynchronous)
      block.push([0x15,0,3,4],[0x20,0,0,32],[0x45,0,1,0x2000],[0x06,0,0,0x00050001]);
    block.push([0x20,0,0,0]);
    instructions.push([0x15,0,block.length,syscall],...block);
  };
  denyCommands(arm?25:72,[8,15,10,1024,1026],true); // fcntl: owners, signal, lease, notify, O_ASYNC
  denyCommands(arm?29:16,[0x8901,0x8902,0x5452,0x5410,0x40045436]); // ioctl: socket/tty signal control
  // O_RDONLY|O_TRUNC bypasses ABI-2 write mediation. Ordinary writable opens
  // remain available only where Landlock grants WRITE_FILE (private scratch).
  for (const [syscall,flagsOffset] of (arm ? [[56,32]] : [[2,24],[257,32]]))
    instructions.push([0x15,0,6,syscall!],[0x20,0,0,flagsOffset!],[0x45,0,3,0x200],
      [0x54,0,0,3],[0x15,0,1,0],[0x06,0,0,0x00050001],[0x20,0,0,0]);
  // Do not let a callee remove its parent-death guard. Thread naming and
  // harmless privilege queries still use prctl during Node initialization.
  instructions.push([0x15,0,4,arm?167:157],[0x20,0,0,16],[0x15,0,1,1],
    [0x06,0,0,0x00050001],[0x20,0,0,0]);
  const threadFlags = 0x01000000 | 0x00200000 | 0x00100000 | 0x00080000 | 0x00040000
    | 0x00010000 | 0x00000800 | 0x00000400 | 0x00000200 | 0x00000100;
  instructions.push(
    [0x15, 0, 11, arm ? 220 : 56],
    [0x20, 0, 0, 20], [0x15, 1, 0, 0], [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 16], [0x54, 0, 0, 0x00010900], [0x15, 1, 0, 0x00010900], [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 16], [0x45, 0, 1, (~threadFlags) >>> 0], [0x06, 0, 0, 0x00050001], [0x06, 0, 0, 0x7fff0000],
    [0x06, 0, 0, 0x7fff0000],
  );
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = yes; bytes[i * 8 + 3] = no;
    bytes.writeUInt32LE(value, i * 8 + 4);
  });
  return bytes;
}
