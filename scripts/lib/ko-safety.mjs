import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
import {run,atomicJson} from './ko-release.mjs';

// T3 0.1.0 seeds userdata/statev2.sqlite once from the V1 state.sqlite and then serves only V2.
// Both stay on disk; the V2 file is live once it exists.
export const DATABASES=['statev2.sqlite','state.sqlite'];
export function liveDatabase(baseDir) {
  return DATABASES.map(name=>path.join(baseDir,'userdata',name)).find(file=>fs.existsSync(file)) ?? null;
}
export function databaseState(baseDir) {
  const file=liveDatabase(baseDir);
  if (!file) return null;
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if (integrity.length!==1 || Object.values(integrity[0])[0]!=='ok') throw Error('Database integrity check failed');
    const migrations=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migration%' ORDER BY name").all()
      .map(({name})=>({name,rows:db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY 1`).all()}));
    return {database:path.basename(file),migrations,integrity:'ok'};
  } finally {db.close();}
}
export async function assertIdle(c) {
  if (!liveDatabase(c.baseDir)) return;
  const environmentId=fs.readFileSync(path.join(c.baseDir,'userdata/environment-id'),'utf8').trim();
  const argv=installedCli(c);
  const helper=path.resolve(import.meta.dirname,'../ko-session.mjs');
  const result=JSON.parse(run(c.node,[helper,'idle','--home-dir',c.baseDir,'--origin',`http://127.0.0.1:${c.port}`,'--environment-id',environmentId,'--t3-command',JSON.stringify(argv)]));
  if(result.status!=='idle') throw Error('Machine is busy or idle inspection failed; defer activation.');
}
export function installedCli(c) {
  const selection=path.join(c.root,c.platform && c.platform!=='linux'?'current.json':'current');
  if(fs.existsSync(selection)) {
    const target=c.platform && c.platform!=='linux'?JSON.parse(fs.readFileSync(selection,'utf8')).target:fs.realpathSync(selection);
    return [c.node,path.join(target,'node_modules/t3/dist/bin.mjs')];
  }
  if(Array.isArray(c.initialCli) && c.initialCli.length && c.initialCli.every(x=>typeof x==='string' && x)) return c.initialCli;
  throw Error('No selected runtime; configure the verified initial CLI argv for first migration.');
}
export function snapshotStoppedHome(c, previous) {
  const state=databaseState(c.baseDir);
  const backup=path.join(c.root,'backups',new Date().toISOString().replaceAll(':','-'));
  fs.mkdirSync(backup,{recursive:true,mode:0o700});
  for (const name of [...DATABASES.flatMap(db=>[db,db+'-wal',db+'-shm']),'settings.json','keybindings.json','environment-id','secrets','themes']) {
    const source=path.join(c.baseDir,'userdata',name);
    if(fs.existsSync(source)) fs.cpSync(source,path.join(backup,name),{recursive:true,dereference:false});
  }
  atomicJson(path.join(backup,'recovery.json'),{createdAt:new Date().toISOString(),baseDir:c.baseDir,previous,state});
  return {backup,before:state};
}
export async function assertStopped(c) {
  await new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port:c.port});
    socket.setTimeout(2000);
    socket.once('connect',()=>{socket.destroy();reject(Error('T3 port is still listening; stopped-home backup refused.'));});
    socket.once('timeout',()=>{socket.destroy();reject(Error('Could not establish that T3 stopped.'));});
    socket.once('error',e=>{socket.destroy();if(e.code==='ECONNREFUSED')resolve();else reject(e);});
  });
}
export function requireSafeBinaryRollback(c,journal) {
  if (liveDatabase(c.baseDir))
    throw Error('Live database exists: binary-only rollback is disabled. An agent must review the recorded backup and migrations; never overwrite newer work automatically.');
}
export function verifyMigrationSource(c,target) {
  if(!liveDatabase(c.baseDir)) return;
  if(!c.migrationSource) throw Error('Configure migrationSource to the verified candidate checkout before upgrading a database.');
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'release.json'),'utf8'));
  const commit=run('git',['rev-parse','HEAD'],{cwd:c.migrationSource});
  if(commit!==manifest.commit || run('git',['status','--porcelain','--untracked-files=no'],{cwd:c.migrationSource})) throw Error('Migration source must be clean and match the installed candidate commit.');
  for(const p of ['apps/server/node_modules/effect/dist/Effect.js','apps/server/src/persistence/Migrations.ts','packages/shared/src/nodeSqliteClient.ts'])
    if(!fs.existsSync(path.join(c.migrationSource,p))) throw Error('Migration source dependencies are missing.');
}
export async function rehearseMigrations(c,target,safety) {
  if(!safety.before) return;
  verifyMigrationSource(c,target);
  const script=path.resolve(import.meta.dirname,'../rehearse-migrations.mjs');
  // Large stopped-home snapshots can need several minutes just for integrity
  // verification. Keep a finite ceiling without aborting an otherwise valid
  // rehearsal at the general command runner's two-minute default.
  const report=parseMigrationReport(run(c.node,[script,c.migrationSource,safety.backup],{timeout:30*60_000}));
  atomicJson(path.join(safety.backup,'migration-report.json'),report);
}
// A release's first start applies its migrations to the live database before it serves
// (T3 answers 503 meanwhile). On a large home that takes minutes, so the post-switch
// health check uses the rehearsal's finite ceiling instead of the ordinary minute.
export const MIGRATION_BOOT_MS=30*60_000;
const migrationIds=state=>{
  const table=state?.migrations?.find(t=>t.name==='effect_sql_migrations') ?? state?.migrations?.[0];
  return (table?.rows ?? []).map(row=>Number(Object.values(row)[0]));
};
// Completing an interrupted activation forward is safe only when the live database is the
// backed-up one plus a prefix of the migrations the rehearsal applied and verified.
export function requireCompletable(c,journal,releaseId,selectedTarget,target) {
  if(journal?.phase!=='recovery-required') throw Error('Only a recovery-required activation can be completed.');
  if(journal.releaseId!==releaseId) throw Error('Release differs from the interrupted activation.');
  if(!selectedTarget || path.resolve(selectedTarget)!==path.resolve(target)) throw Error('The interrupted release is not the selected one.');
  const backup=journal.safety?.backup, before=journal.safety?.before;
  if(!backup || !before || !fs.existsSync(backup)) throw Error('The interrupted activation has no stopped-home backup.');
  const reportFile=path.join(backup,'migration-report.json');
  if(!fs.existsSync(reportFile)) throw Error('The interrupted activation has no passed migration rehearsal.');
  const report=validMigrationReport(JSON.parse(fs.readFileSync(reportFile,'utf8')));
  const live=databaseState(c.baseDir);
  if(!live || live.database!==before.database) throw Error('The live database is not the backed-up one.');
  const was=migrationIds(before), now=migrationIds(live), rehearsed=report.applied.map(([id])=>Number(id));
  const added=now.slice(was.length);
  if(now.length<was.length || was.some((id,i)=>now[i]!==id) || added.some((id,i)=>rehearsed[i]!==id))
    throw Error('Live migrations diverge from the backup and rehearsal; restore the backup instead.');
  return {live,added:added.length,remaining:rehearsed.length-added.length};
}
export function parseMigrationReport(stdout) {
  // Upstream migration logging may precede our final one-line JSON result.
  return validMigrationReport(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
}
function validMigrationReport(report) {
  if(!Array.isArray(report.applied) || !Array.isArray(report.events) || !Array.isArray(report.integrity) || report.integrity.length!==1 || report.integrity[0].integrity_check!=='ok') throw Error('Migration worker did not report a valid integrity result');
  return report;
}
// An activation that fails before it selects the candidate (while stopping the old service,
// taking the stopped-home backup or rehearsing migrations) never ran the candidate against the
// live home, so the live database is still the one the previous release served. Keep the
// previous service when it still runs unchanged and serves its own client; otherwise restore it
// as a database-free rollback would. Only failures after the switch need recovery-required.
// A failed restore is left to the caller.
export async function settleBeforeSwitch({active,unchanged,servedHash,expectedHash,restore}) {
  let kept=false;
  try {kept=Boolean(expectedHash) && active() && unchanged() && (await servedHash())===expectedHash;} catch {kept=false;}
  if (kept) return 'kept';
  await restore();
  return 'restored';
}
