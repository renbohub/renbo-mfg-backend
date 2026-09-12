const fs=require('fs'),path=require('path');
const {prisma}=require('../src/prisma/index');
const approvals=require('../src/prisma/services/approvalRuleService');
const {userHasPermission}=require('../src/prisma/services/ai/permissionEvaluator');
const permit=(user,action)=>userHasPermission(user,{resourceCode:'salesOrder',moduleCode:'sales',pageCode:'sales-orders',action});
function distinctCoverage(stepUsers,steps,excludeId) {
  const slots=steps.flatMap((step,index)=>Array.from({length:Math.max(1,Number(step.requiredApprovals)||1)},()=>index));
  const assigned=new Map();
  function assign(slotIndex,seen){
    for(const userId of stepUsers[slots[slotIndex]]){
      if(userId===excludeId||seen.has(userId))continue;seen.add(userId);
      if(!assigned.has(userId)||assign(assigned.get(userId),seen)){assigned.set(userId,slotIndex);return true;}
    }
    return false;
  }
  let count=0;for(let index=0;index<slots.length;index++)if(assign(index,new Set()))count++;
  return{required:slots.length,available:count,complete:count===slots.length};
}
(async()=>{
  const now=new Date();
  const [rules,users]=await Promise.all([
    prisma.approvalRule.findMany({where:{isDeleted:false,isActive:true,moduleCode:{in:['sales','*']},pageCode:{in:['sales-orders','*']},actionCode:{in:['approve','*']},AND:[{OR:[{effectiveFrom:null},{effectiveFrom:{lte:now}}]},{OR:[{effectiveUntil:null},{effectiveUntil:{gte:now}}]}]},include:{steps:{where:{isDeleted:false,isActive:true},orderBy:{stepOrder:'asc'},include:{role:{select:{roleCode:true,isActive:true,isDeleted:true}}}}},orderBy:{priority:'asc'}}),
    prisma.user.findMany({where:{isDeleted:false,partnerAccess:{is:null}},select:{id:true,isSuperAdmin:true,listMenu:true,roleAssignments:{include:{role:{include:{permissions:true}}}}}}),
  ]);
  const candidates=rules.filter(rule=>!rule.documentType||rule.documentType.toLowerCase()==='salesorderheader');
  const submitters=users.filter(user=>permit(user,'update'));
  const results=[];
  for(const rule of candidates){
    const eligible=[];
    for(const step of rule.steps){const ids=[];for(const user of users)if(permit(user,'approve')&&await approvals.canApproveStep(user,{moduleCode:'sales',pageCode:'sales-orders'},step,prisma))ids.push(user.id);eligible.push(ids);}
    const structuralReady=rule.requireSequential&&!rule.allowSelfApproval&&rule.steps.length>=2&&rule.steps.every(step=>step.requiredApprovals>=1);
    const coverage=distinctCoverage(eligible,rule.steps);
    const usableSubmitterCount=structuralReady?submitters.filter(user=>distinctCoverage(eligible,rule.steps,user.id).complete).length:0;
    results.push({ruleCode:rule.ruleCode,activeStepCount:rule.steps.length,requireSequential:rule.requireSequential,allowSelfApproval:rule.allowSelfApproval,structuralReady,hasAmountCurrencyOrContextConditions:rule.minAmount!==null||rule.maxAmount!==null||Boolean(rule.currencyCode)||Boolean(rule.conditions&&Object.keys(rule.conditions).length),steps:rule.steps.map((step,index)=>({stepName:step.stepName,roleCode:step.role?.roleCode||'(page permission)',requiredApprovals:step.requiredApprovals,eligibleInternalUserCount:eligible[index].length})),distinctEligibleUserCount:new Set(eligible.flat()).size,distinctCoverage:coverage,usableSubmitterCount,readyWithExistingAccounts:structuralReady&&coverage.complete&&usableSubmitterCount>0});
  }
  const report={checkedAt:now.toISOString(),readOnly:true,activeScopeCandidateCount:candidates.length,validSequentialMultiLevelRuleCount:results.filter(rule=>rule.structuralReady).length,readyRuleCount:results.filter(rule=>rule.readyWithExistingAccounts).length,eligibleInternalSubmitterCount:submitters.length,eligibleInternalApproverCount:users.filter(user=>permit(user,'approve')).length,rules:results,configurationUrl:'/master-data/approval-rules'};
  const destination=path.resolve(__dirname,'../../output/step1-completion/sales-approval-readiness.json');fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error('Readiness check failed:',error.code||error.name);process.exitCode=1;}).finally(()=>prisma.$disconnect());
