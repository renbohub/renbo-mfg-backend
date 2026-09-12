const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSnapshotCache}=require('../src/prisma/services/planning/ppicSnapshotCache');
const {buildCalendar}=require('../src/prisma/services/planning/ppicSandboxCalendar');
const E=require('../../library/ppic-planning/engine');
test('cache reuses unchanged data, invalidates source/TTL, isolates actor/month and supports explicit refresh',async()=>{
  let source='a',calls=0,time=0;
  const get=createSnapshotCache({fingerprint:async()=>source,build:async()=>({run:++calls}),now:()=>time,ttlMs:100,maxEntries:2});
  assert.equal((await get('user-month',{})).cache.hit,false);
  assert.equal((await get('user-month',{})).cache.hit,true);assert.equal(calls,1);
  source='b';assert.equal((await get('user-month',{})).run,2);
  assert.equal((await get('user-month',{}, {force:true})).run,3);
  await get('other-user',{});assert.equal(calls,4);
  time=101;await get('user-month',{});assert.equal(calls,5);
  await get('third',{});await get('fourth',{});await get('user-month',{});assert.equal(calls,8);
});
test('concurrent loads share one build; changed source during build and errors are not cached',async()=>{
  let release,calls=0,source='a';
  const get=createSnapshotCache({fingerprint:async()=>source,build:async()=>{calls++;await new Promise(r=>release=r);return {ok:true};}});
  const a=get('k',{}),b=get('k',{});await new Promise(r=>setImmediate(r));release();
  const [first,second]=await Promise.all([a,b]);assert.equal(calls,1);assert.ok(second.cache.shared);assert.ok(first.ok);
  source='b';const c=get('k',{});await new Promise(r=>setImmediate(r));source='c';release();await c;
  const d=get('k',{});await new Promise(r=>setImmediate(r));release();await d;assert.equal(calls,3);
  let fails=true;const retry=createSnapshotCache({fingerprint:async()=>1,build:async()=>{if(fails)throw Error('solver');return {};}});
  await assert.rejects(retry('k',{}),/solver/);fails=false;assert.equal((await retry('k',{})).cache.hit,false);
});
test('calendar holidays override presets and cut overnight shifts; special working Saturday stays open',()=>{
  const machine={id:'M',shift1Start:'22:00',shift1End:'06:00'};
  const result=buildCalendar({machines:[machine],preset:{shiftCount:1},planOverrides:[],start:new Date('2026-09-10'),end:new Date('2026-09-15'),overrides:[
    {machineId:'M',scheduleDate:'2026-09-11',dayStatus:'HOLIDAY',reason:'[YEARLY-CALENDAR:event:NATIONAL_HOLIDAY:NONE] holiday'},
    {machineId:'M',scheduleDate:'2026-09-12',dayStatus:'WORKING',shiftOverrides:[{startTime:'08:00',endTime:'12:00'}],shiftsPerDay:1}
  ]});
  const windows=result.windowsFor(machine);
  assert.ok(windows.some(([a,b])=>a===E.at('2026-09-10',1320)&&b===E.at('2026-09-11')));
  assert.ok(!windows.some(([a,b])=>a<E.at('2026-09-12')&&b>E.at('2026-09-11')));
  assert.ok(windows.some(([a,b])=>a===E.at('2026-09-12',480)&&b===E.at('2026-09-12',720)));
  assert.ok(result.workingCalendar.closedDates.includes('2026-09-11'));
  assert.ok(!result.workingCalendar.closedDates.includes('2026-09-12'));
});
test('machine working profile controls enabled weekdays and effective shift capacity',()=>{
  const machine={id:'M',workingHourProfile:{isActive:true,rules:[{isEnabled:true,dayOfWeek:4,startTime:'07:00',endTime:'15:00',breakMinutes:60}]}};
  const c=buildCalendar({machines:[machine],preset:null,overrides:[],planOverrides:[],start:new Date('2026-09-10'),end:new Date('2026-09-12')});
  assert.deepEqual(c.windowsFor(machine),[[E.at('2026-09-10',420),E.at('2026-09-10',840)]]);
});
