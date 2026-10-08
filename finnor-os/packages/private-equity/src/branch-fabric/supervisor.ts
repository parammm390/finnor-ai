import { Socket } from 'node:net';

/** Registered-native H0 only. Pipe EOF observes controller death without giving
 * the child database/broker credentials. This is not hostile-code isolation. */
export function armNativeParentMonitor() {
  if (process.env.FINNOR_P3_PARENT_CHANNEL !== '3') return () => {};
  let armed = true;
  // libuv's nonblocking pipe watcher can be cancelled on normal completion.
  // A filesystem read stream leaves a blocking threadpool read alive.
  const channel = new Socket({ fd: 3, readable: true, writable: false });
  const stop = () => {
    if (!armed) return;
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(70); }
  };
  channel.on('end', stop);
  channel.on('error', stop);
  channel.resume();
  return () => { armed = false; channel.destroy(); };
}
