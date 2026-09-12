"use strict";
const { randomUUID } = require('node:crypto');
const d = require('./ppicWorkspaceDomain');
const scenarioService = require('./ppicWorkspaceScenarioService');
const domain = require('../../../../../library/ppic-workspace/domain');
const engine = require('../../../../../library/ppic-planning/engine');
const id = value => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(value || ''))) throw d.fail('Identitas paket tidak valid.'); return value; };
// Bump whenever release checks or scheduling semantics change. Approvals bind
// the complete business bundle, including this policy, rather than input alone.
const POLICY_VERSION = 'PPIC_RELEASE_SCENARIO_EVIDENCE_V3';
const VOLATILE_EVALUATION_FIELDS = new Set(['elapsedMs','validationMs','requestMs','evaluatedAt','reviewedAt','generatedAt','checkedAt']);
function canonicalBundle(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonicalBundle(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !VOLATILE_EVALUATION_FIELDS.has(key) && value[key] !== undefined).map(key => [key,canonicalBundle(value[key])]));
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}
function bundleHash(bundle) { if (!d.plain(bundle)) throw d.fail('Isi paket review tidak tersedia. Ajukan paket baru.','RELEASE_BUNDLE_REQUIRED',409); return d.hash({hashVersion:2,bundle:canonicalBundle(bundle)}); }
const actor = user => ({ id: user.id, name: user.username || user.email || user.id });
const permissions = user => Object.fromEntries(['submit','approve','release'].map(action => [action,d.scopedPermission(user,'monthlyProductionPlan',action)]));
function access(user, query, action) { d.assertAccess(user,query); if (action && !permissions(user)[action]) throw d.fail(`Hak ${action} rencana bulanan diperlukan.`, 'RELEASE_FORBIDDEN',403); }
const CATALOG = [
  ['demand','Demand sah','Sales','demand'],['bom','BOM berlaku','Engineering','bom-routing'],['routing','Routing layak','Engineering','bom-routing'],
  ['material','Material tersedia pada need-by','Inventory','material'],['incoming','Incoming terkonfirmasi','Purchasing','material'],['machine','Kapasitas interval mesin','Production','resource'],
  ['tool','Dies / tool siap','Engineering','resource'],['operator','Operator dan skill per shift','Production',null],['setup','Setup dies / coil dan kru','Production',null],
  ['dependency','Dependency dan transfer','PPIC',null],['vendor','Vendor layak','Purchasing','vendor'],['delivery','Delivery feasible','PPIC',null],
  ['quantity','Lot, yield, cavity dan satuan','Engineering','bom-routing'],['version','Versi, frozen horizon dan paket eksekusi','PPIC',null],
];
function inspect(workspace, record, result, analysis = null) {
  const datasets = new Map(workspace.readiness.map(row=>[row.id,row])), nodes=record.payload.seed.nodes || [];
  return CATALOG.map(([checkId,label,owner,source])=>{
    const dataset=datasets.get(source); let status=dataset?.status||'UNKNOWN',reason=dataset?.issues?.join(' ')||'Bukti pemeriksaan belum tersedia untuk snapshot skenario ini.',evidence=dataset?.evidence||[],route=dataset?.route||'/modules/planning-ppic/labs/mps-gantt';
    // Existing readiness belongs to the official MPS. Its PASS is not evidence
    // for an independently edited scenario. Only scenario-specific checks below
    // can turn green; absent execution mappings remain visibly unknown.
    if(source && !['demand','vendor'].includes(checkId) && ['OK','NA'].includes(status)) {status='UNKNOWN';reason='Evaluasi rencana resmi tersedia, tetapi belum tervalidasi terhadap revisi skenario ini.';}
    if(checkId==='bom') {reason='Identitas revisi dan effectivity BOM per FG/subassembly belum tertaut lengkap pada snapshot skenario.';evidence=nodes.filter(row=>row.kind==='fg').map(row=>({nodeId:row.id,partCode:row.partCode,groupId:row.groupId,requiredBomRevision:null,effectivityStatus:'UNKNOWN'}));}
    if(checkId==='routing') {const operations=result.rows.filter(row=>['process','vendor'].includes(row.kind)&&row.qty>0),invalid=operations.filter(row=>!row.routeId||row.kind==='process'&&(!row.machineId||!row.machineOptions?.some(option=>option.machineId===row.machineId)));status=invalid.length?'BLOCKER':'UNKNOWN';reason=invalid.length?'Ada operasi yang belum mempunyai routing atau mesin qualified dalam snapshot.':'Urutan, routing dan pilihan mesin tersedia; basis standard ideal/effective, cavity dan revisi kualifikasi belum tertaut lengkap untuk release.';evidence=operations.map(row=>({nodeId:row.id,partCode:row.partCode,routeId:row.routeId,machineId:row.machineId,vendorId:row.vendorId,cycleSeconds:row.cycleSeconds,performanceFactor:row.efficiency,rateBasis:row.rateBasis||null,issues:row.issues}));}
    if(checkId==='demand') { const nonFirm=workspace.demand.items.filter(row=>!row.firm); evidence=workspace.demand.items.map(row=>({deliveryScheduleId:row.id,partCode:row.partCode,qty:row.qty,uom:row.uom,firm:row.firm,sourceType:row.sourceType,sourceNumber:row.sourceNumber,dueAt:row.dueAt,duePrecision:row.duePrecision})); if(!workspace.demand.items.length) {status='UNKNOWN';reason='Belum ada delivery dalam scope release.';} else if(nonFirm.length) {const forecastReason=`${nonFirm.length} delivery berupa forecast; scope firm release belum ditetapkan. ${workspace.demand.items.length-nonFirm.length} delivery lainnya bersumber dari SO.`;if(status==='BLOCKER')reason+=` ${forecastReason}`;else{status='UNKNOWN';reason=forecastReason;}} }
    if(checkId==='material'&&analysis) {
      const materials=analysis.materials.rows.filter(row=>row.grossQty!==0),short=materials.filter(row=>row.uncoveredQty>0);
      status=short.length?'BLOCKER':materials.length?d.worst(materials.map(row=>row.status)):'NA';
      reason=short.length?`${short.length} kebutuhan material skenario memiliki shortage tanpa supply recovery. Qty dan need-by dihitung ulang dari revisi skenario ini.`:materials.length?'Qualified stock, incoming dan kebutuhan diperiksa ulang pada need-by skenario. Suplai probable tidak dianggap firm.':'Skenario tidak memerlukan material dengan quantity positif.';
      evidence=materials.map(row=>({nodeId:row.id,partCode:row.partCode,uom:row.uom,grossQty:row.grossQty,onHandQty:row.onHandQty,firmSupplyQty:row.firmSupplyQty,plannedSupplyQty:row.plannedSupplyQty,shortageQty:row.shortageQty,uncoveredQty:row.uncoveredQty,needBy:row.needBy,status:row.status,issues:row.issues}));route='/modules/planning-ppic/labs/mrp-material-readiness';
    }
    if(checkId==='incoming'&&analysis) {
      const materials=analysis.materials.rows.filter(row=>row.grossQty!==0),noIncoming=materials.every(row=>Number.isFinite(row.grossQty)&&Number.isFinite(row.onHandQty)&&row.onHandQty>=row.grossQty);
      status=noIncoming?'NA':'UNKNOWN';reason=noIncoming?'Kebutuhan material skenario telah ditutup qualified opening stock; tidak bergantung pada incoming.':'Kebutuhan yang belum ditutup stok memerlukan kepastian incoming pada need-by. Referensi supply yang dihitung tersedia; lead time penerimaan/QC dan komitmen lengkap tetap harus diverifikasi.';
      evidence=materials.filter(row=>row.onHandQty==null||row.onHandQty<row.grossQty).map(row=>({nodeId:row.id,partCode:row.partCode,uom:row.uom,firmSupplyQty:row.firmSupplyQty,plannedSupplyQty:row.plannedSupplyQty,needBy:row.needBy,supplies:row.supplies}));route='/modules/planning-ppic/labs/mrp-material-readiness';
    }
    if(checkId==='machine'&&analysis) {
      const active=result.rows.filter(row=>row.kind==='process'&&row.qty>0),resources=analysis.capacity.resources.filter(row=>row.operationIds.length),conflicts=analysis.capacity.conflicts.filter(row=>row.type!=='DIES_OVERLAP'),unknown=resources.some(row=>row.availableMinutes==null||row.existingMinutes==null||row.plannedMinutes==null)||analysis.capacity.issues.some(row=>['RESOURCE_UNKNOWN','CAPACITY_UNKNOWN'].includes(row.code));
      const unscheduled=resources.some(row=>row.unscheduledOperationIds.length);
      status=!active.length?'NA':conflicts.length||unscheduled?'BLOCKER':unknown?'UNKNOWN':'OK';
      reason=status==='NA'?'Tidak ada operasi mesin aktif pada skenario.':status==='BLOCKER'?'Ada konflik interval kalender/reservasi atau operasi belum muat pada resource skenario.':status==='UNKNOWN'?'Kalender, klasifikasi reservasi atau durasi operasi belum lengkap pada snapshot skenario.':`Beban ${active.length} operasi unik berada dalam kalender ${resources.length} resource; interval dihitung ulang memakai adjustment skenario. Validasi standard, tooling dan operator tetap terpisah.`;
      evidence=[...resources.map(row=>({resourceId:row.id,resourceCode:row.code,availableMinutes:row.availableMinutes,existingMinutes:row.existingMinutes,plannedMinutes:row.plannedMinutes,unscheduledOperationIds:row.unscheduledOperationIds,issues:row.issues})),...conflicts];route='/modules/planning-ppic/labs/capacity-bottleneck';
    }
    if(checkId==='tool'&&analysis) {const conflicts=analysis.capacity.conflicts.filter(row=>row.type==='DIES_OVERLAP');const tools=result.rows.filter(row=>row.kind==='process'&&row.qty>0&&(row.diesId||row.machineOptions?.some(option=>option.diesId)));status=conflicts.length?'BLOCKER':'UNKNOWN';reason=conflicts.length?'Dies dipakai oleh operasi berbeda pada interval yang sama.':'Beban dan konflik dies dihitung, tetapi masa berlaku kualifikasi, maintenance/counter dan kalender dies belum seluruhnya terbukti.';evidence=[...tools.map(row=>({nodeId:row.id,partCode:row.partCode,diesId:row.machineOptions?.find(option=>option.machineId===row.machineId)?.diesId||row.diesId,issues:row.issues})),...conflicts];}
    if(checkId==='quantity') {
      const discrete=new Set(['PCS','PC','EA','EACH','SET','UNIT']),invalid=result.rows.filter(row=>!Number.isFinite(row.qty)||row.qty<0||row.uom&&discrete.has(String(row.uom).toUpperCase())&&Math.abs(row.qty-Math.round(row.qty))>1e-6),missingUnit=result.rows.filter(row=>row.qty>0&&!row.uom);
      status=invalid.length||missingUnit.length?'BLOCKER':'UNKNOWN';reason=status==='BLOCKER'?'Ada quantity non-finite, negatif, pecahan satuan diskret atau satuan yang hilang pada hasil skenario.':'Quantity manual dan turunannya diperiksa terhadap tipe/satuan. Nilai bukan kelipatan 1000 (termasuk 1123) tetap sah untuk adjustment PPIC; bukti MOQ, yield, cavity dan basis standard masih harus dilengkapi.';
      evidence=[...result.rows.filter(row=>row.kind==='fg').map(row=>({nodeId:row.id,partCode:row.partCode,qty:row.qty,uom:row.uom,manuallyAdjusted:Object.prototype.hasOwnProperty.call(record.payload.overrides||{},row.id),quantityShapeValid:!invalid.includes(row)&&!missingUnit.includes(row)})),...invalid.map(row=>({nodeId:row.id,qty:row.qty,uom:row.uom,issue:'INVALID_QUANTITY'})),...missingUnit.map(row=>({nodeId:row.id,issue:'UOM_REQUIRED'}))];
    }
    if(checkId==='vendor') {const vendors=result.rows.filter(row=>row.kind==='vendor'&&row.qty>0);if(!vendors.length){status='NA';reason='Hasil skenario tidak memuat operasi vendor dengan quantity positif.';}else if(['OK','NA'].includes(status)){status='UNKNOWN';reason='Komitmen kapasitas vendor belum diverifikasi pada interval dan quantity skenario ini.';}evidence=[...(datasets.get('vendor-lead-time')?.evidence||[]),...vendors.map(row=>({nodeId:row.id,vendorId:row.vendorId,partCode:row.partCode,qty:row.qty,uom:row.uom,leadDays:row.leadDays,capacityConfirmation:'UNKNOWN',issues:row.issues}))];}
    if(checkId==='dependency') {
      const unscheduled=result.rows.filter(n=>n.kind!=='fg'&&n.active!==false&&Number(n.qty)>0&&(n.planned?.error||n.earliest?.error||!Number.isFinite(n.planned?.start)||!Number.isFinite(n.planned?.end)));
      status=unscheduled.length?'BLOCKER':'UNKNOWN';reason=unscheduled.length?`${unscheduled.length} aktivitas belum terjadwal.`:'Urutan simulasi dihitung. Bukti QC / transfer operasional dan minimum transfer lot belum tertaut pada node skenario.';
      evidence=result.rows.filter(row=>row.qty>0&&row.dependencies?.length).map(row=>({nodeId:row.id,predecessorIds:row.dependencies,transitionMinutes:row.calculation?.transitionMinutes??row.transitionMinutes??null,placementError:row.planned?.error||null,qcReleaseEvidence:null,minimumTransferLot:null}));
    }
    if(checkId==='delivery') {const late=result.groups.some(g=>g.active!==false&&(g.status==='late'||Number.isFinite(g.targetSpareDays)&&g.targetSpareDays<0)),risk=result.groups.some(g=>g.active!==false&&g.status==='risk');status=late?'BLOCKER':'UNKNOWN';reason=late?'Ada pembagian melewati target FG atau delivery pada simulasi.':risk?'Ada pembagian dengan spare rendah. Ini belum berarti terlambat; waktu komitmen dan mitigasi risiko perlu diverifikasi.':'Waktu komitmen delivery dan forecast good FG belum tertaut sebagai bukti feasibility per delivery.';}
    if(checkId==='operator') reason='Jumlah operator qualified dan ketersediaan per shift belum tertaut ke operasi skenario.';
    if(checkId==='setup') {reason='Durasi setup dihitung dalam beban; bukti kru dan aturan overlap setup belum tersedia.';evidence=result.rows.filter(row=>row.kind==='process'&&row.qty>0).map(row=>({nodeId:row.id,downtime:row.downtime,occupiedMinutes:row.calculation?.minutes??null,setupCrewEvidence:null}));}
    if(checkId==='version') {status=record.stale||workspace.source.stale?'BLOCKER':'UNKNOWN';reason=status==='BLOCKER'?'Sumber berubah sejak skenario atau rencana resmi dibuat.':'Versi skenario teridentifikasi. Mapping operasi ke paket eksekusi, alokasi delivery, serta validasi frozen horizon belum lengkap.';evidence=[{scenarioId:record.id,scenarioRevision:record.revision,seedFingerprint:record.sourceFingerprint,sourceFingerprint:workspace.source.fingerprint,stale:Boolean(record.stale||workspace.source.stale),frozenHorizonValidation:null,executionPackageMapping:null}];}
    return {id:checkId,label,owner,mandatory:true,status,reason,route,evidence,basis:'SCENARIO_RELEASE',affectedDeliveryCount:analysis&&['material','incoming','machine','tool','quantity'].includes(checkId)?null:dataset?.affectedDeliveryCount ?? null};
  });
}
const captureDependencies = {getScenario:scenarioService.get,snapshot:(...args)=>require('./ppicWorkspaceService').snapshot(...args),sourceFingerprint:scenarioService.sourceFingerprint,calculate:engine.calculate,analyze:(seed,overrides,options)=>require('../../../../../library/ppic-workspace/scenario-analysis').analyzeScenario(seed,overrides,options)};
async function capture(prisma,scenarioId,query,user,dependencies=captureDependencies) {
  access(user,query); id(scenarioId);
  const record=await dependencies.getScenario(prisma,scenarioId,query,user);
  const workspace=await dependencies.snapshot(prisma,{month:record.month,plant:query.plant},user);
  const captured=await prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const rows=await tx.$queryRaw`SELECT revision,month,source_fingerprint,source_data_fingerprint FROM tbl_ppic_workspace_scenario WHERE id=${scenarioId}`;
    const current=await dependencies.sourceFingerprint(tx,record.month),stored=rows[0];
    if(!stored||stored.revision!==record.revision||stored.month!==record.month||stored.source_fingerprint!==record.sourceFingerprint||current!==workspace.source.fingerprint) throw d.fail('Skenario atau sumber berubah saat checklist diperiksa. Muat ulang review.','RELEASE_SOURCE_CHANGED',409);
    return {current,stale:stored.source_data_fingerprint!==current};
  },{isolationLevel:'RepeatableRead',timeout:45000});
  const current=captured.current,checkedRecord={...record,stale:captured.stale||workspace.source.stale};
  const result=dependencies.calculate(record.payload.seed,record.payload.overrides),analysis=dependencies.analyze?.(record.payload.seed,record.payload.overrides,{stale:checkedRecord.stale}),checks=inspect(workspace,checkedRecord,result,analysis);
  const readiness=domain.evaluateReadiness(checks,{now:new Date().toISOString()});
  const bundle={version:2,policyVersion:POLICY_VERSION,scope:'ERP_GLOBAL',month:record.month,sourceFingerprint:current,scenario:{id:record.id,name:record.name,revision:record.revision,sourceFingerprint:record.sourceFingerprint,payload:record.payload},demand:workspace.demand.items,operations:result.rows,groups:result.groups,checks};
  return {scenarioId:record.id,scenarioName:record.name,scenarioRevision:record.revision,month:record.month,sourceFingerprint:current,stale:checkedRecord.stale,checks,readiness,bundle,bundleHash:bundleHash(bundle),evaluatedAt:new Date().toISOString(),capabilities:permissions(user)};
}
const publicRow=(row,full=false)=>({id:row.id,scenarioId:row.scenario_id,scenarioRevision:row.scenario_revision,month:row.month,revision:row.revision,status:row.status,submittedBy:row.submitted_by,submittedActorId:row.submitted_actor_id,approvedBy:row.approved_by,note:row.note,sourceFingerprint:row.source_fingerprint,createdAt:d.iso(row.created_at_utc||row.created_at),updatedAt:d.iso(row.updated_at_utc||row.updated_at),...(full?{review:row.review}: {})});
async function list(prisma,query,user) {
  access(user,query);const month=d.monthKey(query.month);
  const rows=await prisma.$queryRaw`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_release_request WHERE month=${month} ORDER BY updated_at DESC LIMIT 200`;
  return {items:rows.map(r=>publicRow(r)),capabilities:permissions(user)};
}
async function get(prisma,key,query,user) {
  access(user,query);id(key);
  const rows=await prisma.$queryRaw`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_release_request WHERE id=${key}`;
  if(!rows[0])throw d.fail('Paket review tidak ditemukan.','RELEASE_NOT_FOUND',404);
  const history=await prisma.$queryRaw`SELECT action,actor,note,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc FROM tbl_ppic_release_operation WHERE request_id=${key} ORDER BY created_at`;
  return {...publicRow(rows[0],true),history:history.map(r=>({action:r.action,actor:r.actor,note:r.note,createdAt:d.iso(r.created_at_utc)})),capabilities:permissions(user)};
}
function input(body,update=false) {if(!d.plain(body)||!/^[a-zA-Z0-9_-]{16,100}$/.test(body.operationId||''))throw d.fail('Identitas operasi wajib diisi.');if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<1)throw d.fail('Revisi wajib diisi.');const note=d.text(body.note);if(!note||note.length>2000)throw d.fail('Alasan keputusan wajib diisi (maksimal 2000 karakter).');return {operationId:body.operationId,expectedRevision:body.expectedRevision,note,...(!update?{scenarioId:id(body.scenarioId)}:{})};}
async function replay(db,key,hash) {
  const rows=await db.$queryRaw`SELECT o.request_hash,o.result,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc FROM tbl_ppic_release_operation o JOIN tbl_ppic_release_request r ON r.id=o.request_id WHERE o.operation_id=${key}`;
  if(!rows[0])return null;if(rows[0].request_hash!==hash)throw d.fail('Identitas operasi telah digunakan untuk keputusan berbeda.','OPERATION_ID_CONFLICT',409);
  return {...rows[0].result,createdAt:d.iso(rows[0].created_at_utc)||rows[0].result.createdAt,updatedAt:d.iso(rows[0].updated_at_utc)||rows[0].result.updatedAt,replayed:true};
}
async function log(tx,key,requestId,hash,action,user,note,result) {const person=actor(user),json=JSON.stringify(result);await tx.$executeRaw`INSERT INTO tbl_ppic_release_operation(operation_id,request_id,request_hash,action,actor_id,actor,note,result) VALUES(${key},${requestId},${hash},${action},${person.id},${person.name},${note},${json}::jsonb)`;}
async function consistent(prisma,fn,recovery) {
  try{return await prisma.$transaction(fn,{isolationLevel:'Serializable',timeout:120000});}
  catch(error){
    if(['P2034','P2002','40001'].includes(error.code)||['23505','40001'].includes(error.meta?.code)){
      if(recovery){const prior=await replay(prisma,recovery.operationId,recovery.hash);if(prior)return prior;}
      throw d.fail('Paket berubah di sesi lain. Muat ulang sebelum melanjutkan.','RELEASE_REVISION_CONFLICT',409);
    }
    throw error;
  }
}
async function submit(prisma,body,user,dependencies={capture}) {
  access(user,body,'submit');const normalized=input(body),hash=d.hash({action:'SUBMIT',actorId:user.id,...normalized});const prior=await replay(prisma,normalized.operationId,hash);if(prior)return prior;
  const review=await dependencies.capture(prisma,normalized.scenarioId,body,user);if(review.scenarioRevision!==normalized.expectedRevision)throw d.fail('Revisi skenario berubah.','RELEASE_REVISION_CONFLICT',409);
  return consistent(prisma,async tx=>{const duplicate=await replay(tx,normalized.operationId,hash);if(duplicate)return duplicate;
    const scenario=await tx.$queryRaw`SELECT revision FROM tbl_ppic_workspace_scenario WHERE id=${normalized.scenarioId} FOR SHARE`;
    if(scenario[0]?.revision!==normalized.expectedRevision||await (dependencies.sourceFingerprint||scenarioService.sourceFingerprint)(tx,review.month)!==review.sourceFingerprint)throw d.fail('Skenario atau sumber berubah setelah pemeriksaan.','RELEASE_SOURCE_CHANGED',409);
    const key=randomUUID(),person=actor(user),json=JSON.stringify(review);const rows=await tx.$queryRaw`INSERT INTO tbl_ppic_release_request(id,scenario_id,scenario_revision,month,source_fingerprint,bundle_hash,review,submitted_actor_id,submitted_by,note) VALUES(${key},${review.scenarioId},${review.scenarioRevision},${review.month},${review.sourceFingerprint},${review.bundleHash},${json}::jsonb,${person.id},${person.name},${normalized.note}) RETURNING *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`;
    const result=publicRow(rows[0],true);await log(tx,normalized.operationId,key,hash,'SUBMIT',user,normalized.note,result);return result;
  },{operationId:normalized.operationId,hash});
}
function assertDecision(row,action,user,fresh) {
  if(!['RETURN','APPROVE','RELEASE'].includes(action))throw d.fail('Tindakan review tidak dikenal.');
  if(row.submitted_actor_id===user.id)throw d.fail('Pengusul tidak boleh menyetujui, mengembalikan, atau mempublikasikan pengajuannya sendiri.','SELF_APPROVAL_FORBIDDEN',403);
  if(action==='RETURN'&&row.status!=='SUBMITTED'||action==='APPROVE'&&row.status!=='SUBMITTED'||action==='RELEASE'&&row.status!=='APPROVED')throw d.fail('Status paket tidak sesuai tindakan.','RELEASE_STATE_CONFLICT',409);
  if(action!=='RETURN') {
    if(fresh.stale||fresh.scenarioRevision!==row.scenario_revision||fresh.sourceFingerprint!==row.source_fingerprint||fresh.bundleHash!==row.bundle_hash||fresh.bundle?.policyVersion!==POLICY_VERSION||bundleHash(fresh.bundle)!==row.bundle_hash||bundleHash(row.review?.bundle)!==row.bundle_hash)throw d.fail('Skenario, isi paket, atau kebijakan perhitungan berubah. Ajukan paket baru.','RELEASE_SOURCE_CHANGED',409);
    const evaluated=domain.evaluateReadiness(fresh.bundle.checks,{now:new Date().toISOString()});
    if(!evaluated.canRelease)throw Object.assign(d.fail('Pemeriksaan wajib belum memenuhi syarat release.','RELEASE_BLOCKED',409),{details:evaluated});
  }
}
async function decide(prisma,key,actionName,body,user,dependencies={capture}) {
  const action=String(actionName).toUpperCase();access(user,body,action==='RELEASE'?'release':'approve');id(key);const normalized=input(body,true),hash=d.hash({key,action,actorId:user.id,...normalized});const prior=await replay(prisma,normalized.operationId,hash);if(prior)return prior;
  const saved=await get(prisma,key,body,user);const fresh=action==='RETURN'?null:await dependencies.capture(prisma,saved.scenarioId,body,user);
  return consistent(prisma,async tx=>{const duplicate=await replay(tx,normalized.operationId,hash);if(duplicate)return duplicate;const rows=await tx.$queryRaw`SELECT * FROM tbl_ppic_release_request WHERE id=${key} FOR UPDATE`;const row=rows[0];if(!row||row.revision!==normalized.expectedRevision)throw d.fail('Revisi review berubah.','RELEASE_REVISION_CONFLICT',409);assertDecision(row,action,user,fresh);
    if(action!=='RETURN') {const scenario=await tx.$queryRaw`SELECT revision,source_data_fingerprint FROM tbl_ppic_workspace_scenario WHERE id=${row.scenario_id} FOR SHARE`;if(scenario[0]?.revision!==row.scenario_revision||scenario[0]?.source_data_fingerprint!==row.source_fingerprint||await (dependencies.sourceFingerprint||scenarioService.sourceFingerprint)(tx,row.month)!==row.source_fingerprint)throw d.fail('Sumber berubah saat keputusan disimpan.','RELEASE_SOURCE_CHANGED',409);}
    const person=actor(user),status=action==='RETURN'?'RETURNED':action==='APPROVE'?'APPROVED':'RELEASED';
    if(action==='RELEASE') {const existing=await tx.$queryRaw`SELECT id FROM tbl_ppic_released_baseline WHERE month=${row.month}`;if(existing.length)throw d.fail('Baseline bulan ini sudah dirilis. Perubahan harus melalui Change Control.','CHANGE_CONTROL_REQUIRED',409);const json=JSON.stringify(row.review.bundle);await tx.$executeRaw`INSERT INTO tbl_ppic_released_baseline(id,request_id,month,scenario_id,scenario_revision,bundle_hash,bundle,published_by) VALUES(${randomUUID()},${key},${row.month},${row.scenario_id},${row.scenario_revision},${row.bundle_hash},${json}::jsonb,${person.name})`;}
    const updated=await tx.$queryRaw`UPDATE tbl_ppic_release_request SET status=${status},revision=revision+1,approved_by=CASE WHEN ${action}='APPROVE' THEN ${person.name} ELSE approved_by END,note=${normalized.note},updated_at=CURRENT_TIMESTAMP WHERE id=${key} RETURNING *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`;
    const result=publicRow(updated[0],true);await log(tx,normalized.operationId,key,hash,action,user,normalized.note,result);return result;
  },{operationId:normalized.operationId,hash});
}
module.exports={capture,inspect,list,get,submit,decide,assertDecision,permissions,publicRow,CATALOG,POLICY_VERSION,bundleHash,canonicalBundle,consistent,captureDependencies};
