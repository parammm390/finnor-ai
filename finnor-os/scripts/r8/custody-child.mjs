/** Fixed nonbusiness subprocess fixture, not a supplied candidate executable. */
import {createInterface} from 'node:readline';

if(process.argv[2]==='NONREADING'){
  setInterval(()=>undefined,1000);
}else{
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
    if(Buffer.byteLength(line)>262144)throw Error('REGISTERED_FRAME_BOUND');
    process.stdout.write(JSON.stringify({observed:JSON.parse(line),pid:process.pid})+'\n');
  }
}
