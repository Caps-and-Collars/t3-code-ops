import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settleBeforeSwitch} from './lib/ko-safety.mjs';

// The previous service as an activation found it: running, unchanged, serving its own client.
const found=(changes={})=>({
  active:()=>true,
  unchanged:()=>true,
  servedHash:async()=>'old-client',
  expectedHash:'old-client',
  restore:async()=>{throw Error('a running, unchanged service must not be restored');},
  ...changes,
});
test('a failure before the switch keeps a previous service that still runs unchanged',async()=>{
  // For example: Windows denied disabling the task before anything was stopped.
  assert.equal(await settleBeforeSwitch(found()),'kept');
});
test('a failure before the switch restores a previous service that stopped, changed or serves another client',async()=>{
  for (const changes of [
    {active:()=>false},
    {active:()=>{throw Error('systemctl is-active exited 3');}},
    {unchanged:()=>false},
    {servedHash:async()=>'other-client'},
    {servedHash:async()=>{throw Error('connect ECONNREFUSED');}},
    {expectedHash:null},
  ]) {
    let restored=0;
    assert.equal(await settleBeforeSwitch(found({...changes,restore:async()=>{restored++;}})),'restored');
    assert.equal(restored,1,JSON.stringify(Object.keys(changes)));
  }
});
test('a failed restore is left to the caller',async()=>{
  await assert.rejects(settleBeforeSwitch(found({active:()=>false,restore:async()=>{throw Error('Access is denied');}})),/Access is denied/);
});
