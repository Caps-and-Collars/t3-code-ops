import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {databaseState,snapshotStoppedHome,requireSafeBinaryRollback,installedCli,parseMigrationReport,requireCompletable} from './lib/ko-safety.mjs';
import {nativeManage} from './lib/ko-deployment-native.mjs';
test('rollback cannot replace binaries against a migrated live database',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-safety-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,baseDir:path.join(root,'home'),platform:'darwin',unitDirectory:path.join(root,'units'),service:'test',port:3773};
  fs.mkdirSync(path.join(c.baseDir,'userdata'),{recursive:true});
  const db=new DatabaseSync(path.join(c.baseDir,'userdata/state.sqlite'));
  db.exec('CREATE TABLE effect_sql_migrations (id INTEGER); INSERT INTO effect_sql_migrations VALUES (54);');db.close();
  const backup=snapshotStoppedHome(c,{});
  assert.equal(backup.before.integrity,'ok');assert.ok(fs.existsSync(path.join(backup.backup,'state.sqlite')));
  assert.equal(databaseState(c.baseDir).migrations[0].rows[0].id,54);
  assert.throws(()=>requireSafeBinaryRollback(c,{}),/binary-only rollback is disabled/);
  fs.writeFileSync(path.join(root,'activation.json'),JSON.stringify({config:c,phase:'active',previous:{}}));
  let restored=false;
  await assert.rejects(nativeManage(c,'rollback',undefined,{adapter:{restore:()=>{restored=true;}}}),/binary-only rollback is disabled/);
  assert.equal(restored,false);
});
test('a V2 home backs up both databases and treats statev2 as the live one',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-safety-v2-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,baseDir:path.join(root,'home')};
  fs.mkdirSync(path.join(c.baseDir,'userdata'),{recursive:true});
  for (const [name,id] of [['state.sqlite',54],['statev2.sqlite',62]]) {
    const db=new DatabaseSync(path.join(c.baseDir,'userdata',name));
    db.exec(`CREATE TABLE effect_sql_migrations (id INTEGER); INSERT INTO effect_sql_migrations VALUES (${id});`);db.close();
  }
  const backup=snapshotStoppedHome(c,{});
  assert.equal(backup.before.database,'statev2.sqlite');assert.equal(backup.before.migrations[0].rows[0].id,62);
  for (const name of ['state.sqlite','statev2.sqlite']) assert.ok(fs.existsSync(path.join(backup.backup,name)));
  fs.rmSync(path.join(c.baseDir,'userdata/state.sqlite'));
  assert.equal(databaseState(c.baseDir).database,'statev2.sqlite');
  assert.throws(()=>requireSafeBinaryRollback(c,{}),/binary-only rollback is disabled/);
});
test('after initial Mac migration, idle checks use the selected CLI instead of the old fallback',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-cli-selection-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,platform:'darwin',node:process.execPath,initialCli:['old-node','old-cli']};
  assert.deepEqual(installedCli(c),c.initialCli);
  const target=path.join(root,'releases/new');
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({target}));
  assert.deepEqual(installedCli(c),[c.node,path.join(target,'node_modules/t3/dist/bin.mjs')]);
});
test('upstream migration logging cannot hide or corrupt the final integrity report',()=>{
  const report={applied:[[54,'migration']],events:[{count:141748}],integrity:[{integrity_check:'ok'}]};
  assert.deepEqual(parseMigrationReport('INFO: Migrations ran successfully\n'+JSON.stringify(report)+'\n'),report);
  assert.throws(()=>parseMigrationReport('INFO: success only'));
  assert.throws(()=>parseMigrationReport(JSON.stringify({...report,integrity:[{integrity_check:'corrupt'}]})));
});
function migratedHome(t,ids) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t3-complete-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={root,baseDir:path.join(root,'home')};
  fs.mkdirSync(path.join(c.baseDir,'userdata'),{recursive:true});
  const db=new DatabaseSync(path.join(c.baseDir,'userdata/statev2.sqlite'));
  db.exec('CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)');
  for (const id of ids) db.prepare('INSERT INTO effect_sql_migrations VALUES (?,?)').run(id,'m'+id);
  db.close();
  return c;
}
function interrupted(c,beforeIds,rehearsed) {
  const backup=path.join(c.root,'backups/b');fs.mkdirSync(backup,{recursive:true});
  fs.writeFileSync(path.join(backup,'migration-report.json'),JSON.stringify({applied:rehearsed.map(id=>[id,'m'+id]),events:[{count:1}],integrity:[{integrity_check:'ok'}]},null,2));
  const before={database:'statev2.sqlite',migrations:[{name:'effect_sql_migrations',rows:beforeIds.map(id=>({migration_id:id,name:'m'+id}))}],integrity:'ok'};
  return {phase:'recovery-required',releaseId:'r1',safety:{backup,before}};
}
test('an interrupted activation completes forward only from the backup plus a rehearsed prefix',t=>{
  const target='/deploy/releases/r1';
  const c=migratedHome(t,[72,73,74]);
  const journal=interrupted(c,[72],[73,74,75]);
  assert.deepEqual((({added,remaining})=>({added,remaining}))(requireCompletable(c,journal,'r1',target,target)),{added:2,remaining:1});
  assert.throws(()=>requireCompletable(c,{...journal,phase:'active'},'r1',target,target),/Only a recovery-required/);
  assert.throws(()=>requireCompletable(c,journal,'r2',target,target),/Release differs/);
  assert.throws(()=>requireCompletable(c,journal,'r1','/deploy/releases/old',target),/not the selected one/);
  assert.throws(()=>requireCompletable(c,interrupted(c,[72],[74,73]),'r1',target,target),/diverge/);
  assert.throws(()=>requireCompletable(c,interrupted(c,[71,72],[73,74]),'r1',target,target),/diverge/);
  fs.rmSync(path.join(journal.safety.backup,'migration-report.json'));
  assert.throws(()=>requireCompletable(c,journal,'r1',target,target),/no passed migration rehearsal/);
});
test('complete restarts the selected release with the migration ceiling and records the outcome',async t=>{
  const c={...migratedHome(t,[72,73]),platform:'win32',service:'test',port:3773,userName:'M\U'};
  c.unitDirectory=path.join(c.root,'units');
  const target=path.join(c.root,'releases/9.9.9-test');
  fs.mkdirSync(path.join(target,'node_modules/t3/dist/client'),{recursive:true});
  fs.writeFileSync(path.join(target,'node_modules/t3/dist/client/index.html'),'release');
  fs.writeFileSync(path.join(c.root,'current.json'),JSON.stringify({target}));
  const journal={...interrupted(c,[72],[73,74]),releaseId:'9.9.9-test',schemaVersion:2,config:c,failure:'Service validation failed: HTTP 503',previous:{target:'old'}};
  fs.writeFileSync(path.join(c.root,'activation.json'),JSON.stringify(journal));
  const calls=[];
  const dependencies=(healthy)=>({
    adapter:{info:()=>({state:'inactive',pid:''}),install:t=>calls.push(['install',t]),stop:()=>calls.push(['stop']),restore:()=>calls.push(['restore'])},
    verify:()=>({releaseId:'9.9.9-test'}),stopped:async()=>calls.push(['stopped']),healthy,
  });
  await assert.rejects(nativeManage(c,'complete','9.9.9-test',dependencies(async()=>{throw Error('still migrating');})),/Completing the activation failed/);
  let saved=JSON.parse(fs.readFileSync(path.join(c.root,'activation.json'),'utf8'));
  assert.equal(saved.phase,'recovery-required');assert.equal(saved.failure,'still migrating');
  assert.deepEqual(calls.map(([name])=>name),['stopped','install','stop']);
  calls.length=0;
  let timeout;
  await nativeManage(c,'complete','9.9.9-test',dependencies(async(_c,hash,ms)=>{timeout=ms;assert.match(hash,/^[0-9a-f]{64}$/);}));
  saved=JSON.parse(fs.readFileSync(path.join(c.root,'activation.json'),'utf8'));
  assert.equal(saved.phase,'active');assert.equal(timeout,30*60_000);
  assert.deepEqual(calls,[['stopped'],['install',target]]);
  assert.equal(saved.completion.added,1);assert.equal(saved.completion.remaining,1);
  assert.equal(saved.completion.failure,'still migrating');assert.equal(saved.after.integrity,'ok');
  assert.deepEqual(saved.previous,{target:'old'});
  await assert.rejects(nativeManage(c,'complete','9.9.9-test',dependencies(async()=>{})),/Only a recovery-required/);
});
