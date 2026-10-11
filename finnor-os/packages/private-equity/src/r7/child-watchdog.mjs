import { workerData } from 'node:worker_threads';
// An independent event loop remains responsive while exact geometry blocks the
// main thread. Kill only this physical child, never the original supervisor.
const {parentPid,deadlineAt}=workerData;
const check=()=>{
  try{process.kill(parentPid,0);}catch{process.kill(process.pid,'SIGKILL');}
  if(process.ppid!==parentPid||Date.now()>=deadlineAt)process.kill(process.pid,'SIGKILL');
};
check();setInterval(check,100);
