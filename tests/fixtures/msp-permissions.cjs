// Deterministic MSP peer for the native permission smoke test. Never shipped.
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const args=process.argv.slice(2);
const log=entry=>fs.appendFileSync(process.env.VELUM_PERMISSION_LOG,JSON.stringify(entry)+'\n');
if(args[0]!=='serve') { console.log('Permission fixture terminal'); process.stdin.resume(); return; }
let sessionId=randomUUID(),turnId,approval,prompt;
const send=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const notify=(method,params)=>send({method,params:{sessionId,turnId,...params}});
const complete=text=>{
  notify('item/completed',{item:{itemId:randomUUID(),kind:'agentMessage',revision:1,status:'completed',text}});
  notify('turn/completed',{terminal:'completed',text});
};
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line),{id,method,params:p={}}=message;
  if(!method)return;
  const result=value=>send({id,result:value});
  if(method==='initialize')return result({schema:{version:1},sessionDurability:'durable'});
  if(method==='initialized')return;
  if(method==='model/list')return result({models:[{modelId:'fixture-muse',displayLabel:'Fixture Muse',variants:['low']}]});
  if(method==='session/start'||method==='session/resume'){sessionId=p.sessionId||sessionId;return result({session:{sessionId,activeTurnId:null}});}
  if(method==='session/setApprovalMode'||method==='session/setModel')return result({status:'accepted'});
  if(method==='approval/listPending')return result({approvals:approval?[approval]:[],userInputs:[]});
  if(method==='turn/start'){
    turnId=randomUUID();prompt=p.displayText;log({method,prompt,sessionId,turnId});
    if(prompt==='QUESTION') {
      result({turnId,disposition:'started'});
      return send({id:'question-receipt',method:'userInput/request',params:{sessionId,turnId,userInputId:'question',toolName:'ask_user',questions:[{id:'features',header:'Features',question:'Choose the features.',selection:{mode:'multiple',minSelections:1,maxSelections:2},options:[{label:'Alpha',description:'First feature'},{label:'Beta',description:'Second feature'}]}]}});
    }
    if(prompt==='SIMPLE'){result({turnId,disposition:'started'});return complete('Simple completion');}
    const approvalId=randomUUID();
    approval={sessionId,turnId,approvalId,toolName:'powershell',rawArgs:JSON.stringify({command:'Write permission fixture marker'}),subject:{kind:'shell',command:'Write permission fixture marker'},currentRequirementId:{approvalId,sourceIndex:0},availableChoices:[{choiceId:'allow_once',label:'Allow once',scope:'once',decision:'approve',acceptsFeedback:false},{choiceId:'deny',label:'Deny',scope:'once',decision:'deny',acceptsFeedback:true}]};
    // Deliberately precede the turn acknowledgement and mirror the request.
    send({id:'approval-receipt',method:'approval/request',params:approval});
    notify('approval/requested',approval);
    return result({turnId,disposition:'started'});
  }
  if(method==='approval/decide'){
    log({method,params:p,prompt});
    if(p.requirementId.sourceIndex!==approval.currentRequirementId.sourceIndex)return send({id,error:{code:-32000,message:'Stage changed'}});
    if(prompt==='STAGED'&&p.choiceId==='allow_once'&&p.requirementId.sourceIndex===0){
      approval.currentRequirementId.sourceIndex=1;
      // Updated notifications omit the original action fields in MSP.
      notify('approval/updated',{approvalId:approval.approvalId,currentRequirementId:approval.currentRequirementId,availableChoices:approval.availableChoices});
      return result({status:'accepted',terminal:false});
    }
    result({status:'accepted',terminal:true});
    notify('approval/resolved',{approvalId:approval.approvalId,decision:p.choiceId==='deny'?'denied':'approvedOnce'});
    approval=null;
    return complete(p.choiceId==='deny'?'Action declined':'Action allowed');
  }
  if(method==='userInput/answer'||method==='userInput/cancel'){
    log({method,params:p});result({status:'accepted'});
    notify('userInput/settled',{userInputId:'question',outcome:method.endsWith('/answer')?'answered':'cancelled'});
    return complete('Question settled');
  }
  send({id,error:{code:-32601,message:`Unsupported fixture method ${method}`}});
});
