import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivitySnapshot } from './activity-snapshot.ts';
/** Summary only. No prompts, outputs, or control commands are persisted. */
export function createPiloActivityWriter(root=path.join(process.env.PI_CODING_AGENT_DIR??path.join(os.homedir(),'.pi/agent'),'extensions/subagent/pilo-activity')){
 const writerId=randomUUID();
 return (snapshot:ActivitySnapshot,ctx:ExtensionContext)=>{
  const sessionFile=ctx.sessionManager?.getSessionFile();
  if(!sessionFile||!snapshot.sessionId||!/^[A-Za-z0-9_-]+$/.test(snapshot.sessionId))return;
  try{
   const data={...snapshot,sessionPath:fs.realpathSync(sessionFile),pid:process.pid,writerId};
   fs.mkdirSync(root,{recursive:true,mode:0o700});const dest=path.join(root,`${snapshot.sessionId}.${process.pid}.json`);const temporary=`${dest}.${writerId}.tmp`;
   fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o600});fs.renameSync(temporary,dest);
  }catch{/* Optional GUI projection must never interrupt a terminal or a running child. */}
 };
}
