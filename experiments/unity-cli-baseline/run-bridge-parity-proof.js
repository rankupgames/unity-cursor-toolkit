// Compare the production backends against the same closed, agent-owned fixture.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert');
const {spawnSync}=require('child_process');
const {UnityCliAdapter}=require('../../unity-cursor-toolkit/out/core/unityCliAdapter');
const {UnityCliTestAdapter}=require('../../unity-cursor-toolkit/out/core/unityCliTestAdapter');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const fixture=path.resolve(arg('--project')||''),baseline=arg('--bridge-capture'),cli=arg('--cli');
if(path.dirname(fixture)!==path.resolve(os.tmpdir())||!path.basename(fixture).startsWith('uct-test-bridge-')||!baseline||!cli)throw Error('Pass a retained owned bridge fixture, capture and CLI.');
const reference=JSON.parse(fs.readFileSync(baseline,'utf8'));
if(!reference.passed||!reference.normalEditorExit)throw Error('Bridge baseline must pass and exit normally.');
const selectedCases=(arg('--cases')||'literal-metacharacter-name,failure-stack,skipped-mapping,inconclusive-mapping,play-reload-and-heartbeat').split(',');
const output=path.join(__dirname,'captures','test-backend-parity-'+new Date().toISOString().replace(/[:.]/g,'-'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record={passed:false,observedAt:new Date().toISOString(),editorVersion:reference.editorVersion,bridgeCapture:path.basename(path.dirname(baseline)),cases:[],fixtureRemoved:false,sources:['unityCliTestAdapter.ts','unityTestTypes.ts','unityTestPrivacy.ts'].map(file=>({file,sha256:hash(path.join(__dirname,'../../unity-cursor-toolkit/src/core',file))}))};
function clean(value){
 if(typeof value==='string'){for(const [root,marker] of [[fixture,'fixture'],[os.homedir(),'home-redacted'],[os.tmpdir(),'temp-redacted'],[os.hostname(),'host-redacted']])for(const form of [root,root.replace(/\\/g,'/')])value=value.split(form).join(marker);return value;}
 if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)]));return value;
}
function processes(){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$root=$env:UCT_PARITY_PROJECT;ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Unity.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | Select-Object -ExpandProperty ProcessId)"],{encoding:'utf8',windowsHide:true,env:{...process.env,UCT_PARITY_PROJECT:fixture}});if(result.status!==0)throw Error('Owned process query failed');return JSON.parse(result.stdout);}
(async()=>{
 try{
  assert.deepEqual(processes(),[]);assert(!fs.existsSync(path.join(fixture,'Temp','UnityLockfile')));
  const version=/m_EditorVersion: (.+)/.exec(fs.readFileSync(path.join(fixture,'ProjectSettings','ProjectVersion.txt'),'utf8'))[1].trim();assert.equal(version,reference.editorVersion);
  const transport=new UnityCliAdapter(cli),adapter=new UnityCliTestAdapter(transport);
  const invoke=transport.invoke.bind(transport);let currentName;
  transport.invoke=async(...args)=>{const result=await invoke(...args);if(args[0]==='test'){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,currentName+'-native.json'),JSON.stringify(clean({ok:result.ok,exitCode:result.exitCode,stdout:JSON.parse(result.stdout),error:result.ok?undefined:result.error}),null,2)+'\n');}return result;};
  for(const name of selectedCases){
   currentName=name;
   const bridge=reference.cases.find(item=>item.name===name).result;assert.equal(bridge.selection.length,1);
   const read=fs.readFileSync;let result;const start=Date.now();
   fs.readFileSync=(file,...args)=>{const value=read(file,...args);if(typeof file==='string'&&path.basename(file)==='results.xml'&&path.basename(path.dirname(file)).startsWith('uct-cli-tests-')){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name+'.xml'),clean(String(value)));}return value;};
   try{result=await adapter.runTests({projectPath:fixture,mode:bridge.mode,filters:{test:bridge.selection[0]},timeoutMs:180000});}finally{fs.readFileSync=read;}
   const remaining=processes();
   const nativeDifference=name==='inconclusive-mapping'&&bridge.status==='completed'&&result.status==='failed'&&result.error?.nativeCode==='TESTS_FAILED'&&result.error?.exitCode===8&&result.summary.inconclusive===1;
   const matched=result.editorVersion===bridge.editorVersion&&(result.status===bridge.status||nativeDifference)&&JSON.stringify(result.selection)===JSON.stringify(bridge.selection)&&result.tests.length===1&&result.tests[0].status===bridge.tests[0].status;
   record.cases.push({name,elapsedMs:Date.now()-start,matched,nativeDifference:nativeDifference?'CLI reports TESTS_FAILED for an inconclusive leaf; the bridge reports completed with an inconclusive leaf.':undefined,bridge:{status:bridge.status,selection:bridge.selection,testStatus:bridge.tests[0].status},cli:result,editorsRemaining:remaining});
   console.log(JSON.stringify({name,matched,status:result.status,error:result.error?.code,editorsRemaining:remaining}));
   if(remaining.length)throw Error('Owned Editor remains; refusing the next case.');
  }
  record.passed=record.cases.every(item=>item.matched);
 }catch(error){record.failure=String(error.message).replace(/[A-Za-z]:[\\/][^\r\n]*/g,'<private-path>');}
 finally{
  record.editorsRemaining=processes();
  record.fixtureRetained=process.argv.includes('--keep-project-on-failure')&&!record.passed;
  if(record.editorsRemaining.length===0&&!record.fixtureRetained){fs.rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:300});record.fixtureRemoved=true;}
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'observation.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({output,passed:record.passed,fixtureRemoved:record.fixtureRemoved}));if(!record.passed)process.exitCode=1;
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
