'use strict';
// Run after npm run compile, with no user Editor launch/termination. Two TEMP projects only.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {spawn,execFile}=require('child_process');
const {UnityCliAdapter}=require('../../unity-cursor-toolkit/out/core/unityCliAdapter');
const {queryPipelineRegistry,evaluatePipelineEligibility}=require('../../unity-cursor-toolkit/out/core/pipelineEligibility');
const PIN='0.8.0-exp.1',EDITOR='6000.3.9f1',CLI='1.0.0-beta.12';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const psQuote=s=>"'"+s.replace(/'/g,"''")+"'";
const ps=command=>new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:1048576},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const evidence={capturedAt:new Date().toISOString(),cliVersion:CLI,pipelineVersion:PIN,editorVersion:EDITOR,outcome:'incomplete',commands:[],transport:[],composition:[],safety:{}};
const owned=[],clients=new Set(); let binary,editorRoot,sentinel;
const matrix=JSON.parse(fs.readFileSync(path.join(__dirname,'../../unity-cursor-toolkit/src/core/pipelinePolicy.json'),'utf8'));
const interfaceAddresses=Object.values(os.networkInterfaces()).flat().filter(i=>i&&!i.internal).map(i=>i.address);
const secretKey=/auth|credential|token|secret|password|bearer|email|foreignkey|username|userid|session/i;
function safe(value){
 if(Array.isArray(value))return value.map(safe);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!secretKey.test(k)).map(([k,v])=>[k,safe(v)]));
 if(typeof value!=='string')return value;
 let s=value;
 const roots=[...owned.map((f,i)=>[f.root,'<fixture-'+(i+1)+'>']),[editorRoot,'<editor-root>'],[binary,'<cli-binary>'],[os.tmpdir(),'<temp-root>'],[os.homedir(),'<user-home>'],[process.env.APPDATA,'<app-data>'],[process.env.LOCALAPPDATA,'<local-app-data>'],[process.env.USERNAME,'<user>'],[os.hostname(),'<host>']].filter(x=>x[0]);
 for(const [a,b]of roots)for(const form of [a,a.replace(/\\/g,'/'),JSON.stringify(a).slice(1,-1),JSON.stringify(JSON.stringify(a).slice(1,-1)).slice(1,-1)].sort((x,y)=>y.length-x.length))s=s.split(form).join(b);
 for(const address of interfaceAddresses)s=s.split(address).join('<host-interface>');
 return s.replace(/Bearer\s+[^\s"']+/gi,'Bearer <redacted>').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'<redacted>').replace(/[A-Z]:[\\/][^\s"'<>]*/g,'<absolute-path>');
}
function log(f){return fs.existsSync(path.join(f.root,'Editor.log'))?fs.readFileSync(path.join(f.root,'Editor.log'),'utf8'):'';}
function events(f){return [...log(f).matchAll(/\[PipelineSafetyProof\] ([^\r\n]+)/g)].map(m=>m[1]).filter(e=>!f.launchedAt||e.slice(e.lastIndexOf('|')+1)>=f.launchedAt);}
async function wait(f,name,ms=240000){const until=Date.now()+ms;while(Date.now()<until&&alive(f.pid)){if(events(f).some(e=>e.startsWith(name+'|')))return;await sleep(500);}throw Error('Owned fixture '+f.label+' did not reach '+name+' within '+ms+'ms');}
async function killOwned(child){
 if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
 if(process.platform==='win32')await new Promise(resolve=>execFile(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:2000},()=>resolve()));
 else {try{process.kill(-child.pid,'SIGTERM');}catch{}}
 const end=Date.now()+2000;while(alive(child.pid)&&Date.now()<end)await sleep(50);
 if(alive(child.pid))throw Error('Owned CLI PID cleanup remained incomplete');
}
async function raw(args,format='json',bound=30000,cancelAfter){
 const argv=[args[0],'--format',format,'--non-interactive','--no-banner','--no-log-proxy',...args.slice(1)];
 const child=spawn(binary,argv,{shell:false,windowsHide:true,detached:process.platform!=='win32'});clients.add(child);
 let stdout='',stderr='',reason=null;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',s=>{stdout+=s;if(stdout.length>1048576){reason='output_limit';void killOwned(child).catch(e=>{evidence.cleanupFailure=safe(e.message);});}});
 child.stderr.on('data',s=>{stderr+=s;if(stderr.length>1048576){reason='output_limit';void killOwned(child).catch(e=>{evidence.cleanupFailure=safe(e.message);});}});
 const timer=setTimeout(()=>{reason=cancelAfter?'caller_cancelled':'caller_deadline';void killOwned(child).catch(e=>{evidence.cleanupFailure=safe(e.message);});},cancelAfter||bound);
 const result=await new Promise(resolve=>{child.on('error',e=>resolve({exitCode:null,signal:null,spawnError:e.code}));child.on('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 clearTimeout(timer);clients.delete(child);
 let frames;try{frames=format==='json'?[JSON.parse(stdout)]:stdout.trim().split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}catch{frames=null;}
 const record=safe({argv,format,reason,...result,stdout:frames?JSON.stringify(safe(format==='json'?frames[0]:frames)):stdout,stderr:stderr.split(/\r?\n/).filter(s=>!secretKey.test(s)).join('\n'),frames});
 evidence.commands.push(record);return {...result,reason,frames,record};
}
async function command(f,name,params={},format='json',bound=30000,cancelAfter){
 const args=['command','--project-path',f.root,name];
 for(const[k,v]of Object.entries(params))args.push('--'+k,typeof v==='object'?JSON.stringify(v):String(v));
 return raw(args,format,bound,cancelAfter);
}
function full(result,name){const e=result.frames?.[0];if(result.exitCode!==0||e?.success!==true||e.command!=='command '+name)throw Error('Full JSON command failed '+name);return e.data;}
function readOnly(name){const row=matrix.commands.find(x=>x.name===name);if(!row||row.risk!=='read-only')throw Error('Read-only selector refused '+name);}
function request(host,port,headers={}){return new Promise(resolve=>{
 const req=http.request({host,port,path:'/api/status',headers,timeout:2000},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});
 req.on('timeout',()=>req.destroy());req.on('error',e=>resolve({networkError:e.code}));req.end();
});}
class Mcp{
 constructor(f){
  this.f=f;this.next=1;this.pending=new Map();this.frames=[];this.stderr='';
  this.child=spawn(binary,['mcp','--format','json','--non-interactive','--no-banner','--no-log-proxy','--project-path',f.root],{shell:false,windowsHide:true,detached:process.platform!=='win32'});clients.add(this.child);
  let buffer='',bytes=0;this.childError=null;
  const settle=(kind)=>{this.childError=kind;for(const [id,p]of this.pending){clearTimeout(p.timer);p.resolve({localDiagnosis:kind,id});}this.pending.clear();};
  this.child.on('error',e=>settle('spawn_failed:'+e.code));this.child.on('close',()=>settle('owned_process_exited'));
  this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
  this.child.stderr.on('data',s=>{this.stderr+=s;if(this.stderr.length>65536){settle('output_limit');void killOwned(this.child).catch(e=>{evidence.cleanupFailure=safe(e.message);});}});
  this.child.stdout.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>1048576||this.frames.length>2500){settle('output_limit');void killOwned(this.child).catch(e=>{evidence.cleanupFailure=safe(e.message);});return;}buffer+=s;for(let n;(n=buffer.indexOf('\n'))>=0;){let line=buffer.slice(0,n).trim();buffer=buffer.slice(n+1);if(!line)continue;let frame;try{frame=JSON.parse(line);}catch{this.frames.push({invalidFraming:true});continue;}this.frames.push(safe(frame));const p=this.pending.get(frame.id);if(p){clearTimeout(p.timer);this.pending.delete(frame.id);p.resolve({frame});}}});
 }
 notify(method,params={}){if(this.childError||this.child.stdin.destroyed)return;this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
 call(method,params={},bound=10000,cancelAfter){
  const id=this.next++;if(this.childError)return Promise.resolve({localDiagnosis:this.childError,id});return new Promise(resolve=>{const timer=setTimeout(()=>{this.pending.delete(id);if(cancelAfter)this.notify('notifications/cancelled',{requestId:id,reason:'owned proof cancellation'});resolve({localDiagnosis:cancelAfter?'caller_cancelled':'caller_deadline',id});},cancelAfter||bound);this.pending.set(id,{resolve,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 }
 async close(){for(const [id,p]of this.pending){clearTimeout(p.timer);p.resolve({localDiagnosis:'owned_client_closing',id});}this.pending.clear();this.child.stdin.end();const end=Date.now()+2000;while(alive(this.child.pid)&&Date.now()<end)await sleep(50);if(alive(this.child.pid))await killOwned(this.child);clients.delete(this.child);evidence.composition.push(safe({fixture:this.f.label,backend:'stdio-mcp',framing:'newline-delimited JSON-RPC observed',frames:this.frames,stderr:this.stderr.split(/\r?\n/).filter(s=>!secretKey.test(s)).join('\n'),exitCode:this.child.exitCode,signal:this.child.signalCode}));}
}
function findTool(tools,name){const t=tools.find(t=>t.name===name||t.name.endsWith('_'+name));if(!t)throw Error('MCP catalog lacks '+name);return t.name;}
async function launch(f,executable){
 const logPath=path.join(f.root,'Editor.log');if(fs.existsSync(logPath))fs.unlinkSync(logPath);
 f.launchedAt=new Date().toISOString();f.executable=executable;
 const a=['-projectPath','"'+f.root+'"','-logFile','"'+path.join(f.root,'Editor.log')+'"','-silent-crashes'];
 f.pid=Number(await ps('$p=Start-Process -FilePath '+psQuote(executable)+' -ArgumentList @('+a.map(psQuote).join(',')+') -WindowStyle Hidden -PassThru; $p.Id'));
 if(!Number.isInteger(f.pid)||f.pid<=0)throw Error('Owned PID missing');
 console.log('Owned fixture '+f.label+' launched PID '+f.pid);await wait(f,'ready');
 // Exact runtime identity is verified by editor_status; root is verified before safety mutations.
 const lock=JSON.parse(fs.readFileSync(path.join(f.root,'Packages/packages-lock.json')));
 if(lock.dependencies?.['com.unity.pipeline']?.version!==PIN)throw Error('Resolved package pin mismatch');
 if(f.label==='fixture-2')evidence.secondInstall.lock=lock;
}
async function transport(f){
 const descriptorPath=path.join(f.root,'Library','Pipeline','.unity-pipeline-port'),descriptor=JSON.parse(fs.readFileSync(descriptorPath,'utf8'));
 if(!Number.isInteger(descriptor.port)||typeof descriptor.evalToken!=='string'||!descriptor.evalToken)throw Error('Owned endpoint descriptor is invalid');
 const port=descriptor.port,credential=descriptor.evalToken;
 // Never retain credential in evidence, stdout, hashes, or child arguments.
 const checks={missingHeader:await request('127.0.0.1',port),wrongHeader:await request('127.0.0.1',port,{Authorization:'Bearer proof-invalid'}),validHeader:await request('127.0.0.1',port,{Authorization:'Bearer '+credential}),foreignOrigin:await request('127.0.0.1',port,{Authorization:'Bearer '+credential,Origin:'https://example.invalid'}),nullOrigin:await request('127.0.0.1',port,{Authorization:'Bearer '+credential,Origin:'null'})};
 const address=Object.values(os.networkInterfaces()).flat().find(i=>i&&!i.internal&&i.family==='IPv4')?.address;
 checks.routableInterface=address?await request(address,port,{Authorization:'Bearer '+credential}):{notAvailable:true};
 const acl=JSON.parse(await ps('$a=Get-Acl -LiteralPath '+psQuote(descriptorPath)+'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rows=@($a.Access | ForEach-Object { $s=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; [pscustomobject]@{currentUser=($s -eq $sid); broadPrincipal=($s -in @("S-1-1-0","S-1-5-11","S-1-5-32-545")); inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString()} }); [pscustomobject]@{inheritanceProtected=$a.AreAccessRulesProtected; access=$rows} | ConvertTo-Json -Depth 4 -Compress'));
 const ignored=fs.readFileSync(path.join(f.root,'.gitignore'),'utf8').split(/\r?\n/).includes('Library/');
 const gitIgnoreVerified=await new Promise((resolve,reject)=>execFile('git',['-c','core.excludesFile=','check-ignore','--no-index','--quiet','Library/Pipeline/.unity-pipeline-port'],{cwd:f.root,windowsHide:true,timeout:10000,maxBuffer:1048576},error=>error?reject(Error('Owned Pipeline descriptor is not Git-ignored')):resolve(true)));
 const listeners=JSON.parse(await ps('ConvertTo-Json -Compress -InputObject @((Get-NetTCPConnection -State Listen -LocalPort '+port+' -ErrorAction SilentlyContinue) | Select-Object LocalAddress,LocalPort,OwningProcess)'));
 evidence.transport.push(safe({fixture:f.label,checks,acl,descriptorLocation:'Library/Pipeline/.unity-pipeline-port',libraryIgnoreDeclared:ignored,gitIgnoreVerified,listeners:listeners.map(l=>({binding:l.LocalAddress==="127.0.0.1"||l.LocalAddress==="::1"?"loopback":l.LocalAddress==="0.0.0.0"||l.LocalAddress==="::"?"wildcard":"routable",port:l.LocalPort,ownedEditor:l.OwningProcess===f.pid}))}));
 evidence.transport.at(-1).requiredDefaultsMatch=checks.missingHeader.status===401&&checks.wrongHeader.status===401&&checks.validHeader.status===200&&checks.foreignOrigin.status===403&&checks.nullOrigin.status===403;
 if(checks.validHeader.status!==200)throw Error('Valid owned endpoint unavailable; target cannot be verified safely');
 evidence.transport.at(-1).userRestrictedAcl=acl.inheritanceProtected&&!acl.access.some(a=>a.broadPrincipal&&a.type==='Allow');
 evidence.transport.at(-1).routableApiRefused=checks.routableInterface.status!==200;
}
async function compare(f){
 readOnly('read_text_file');
 const direct=full(await command(f,'read_text_file',{path:'Assets/PipelineSafety/identity.txt'}),'read_text_file');
 if(!JSON.stringify(direct).includes(f.label+' exact owned project'))throw Error('Direct CLI selected wrong owned target');
 const missing=await command(f,'read_text_file',{path:'Assets/PipelineSafety/missing.txt'});
 if(missing.exitCode===0||!missing.frames)throw Error('Direct failure did not return framed nonzero error');
 evidence.composition.push(safe({fixture:f.label,backend:'direct-cli',identity:direct,nativeFailure:missing.frames,exitCode:missing.exitCode}));
 const ndjson=await command(f,'proof_delay',{milliseconds:1000},'ndjson');
 if(!ndjson.frames||ndjson.exitCode!==0)throw Error('Direct NDJSON operation failed');
 evidence.composition.push({fixture:f.label,backend:'direct-cli',progressFrameCount:ndjson.frames.length});
 const timeout=await raw(['command','--project-path',f.root,'--timeout','1','proof_delay','--milliseconds','3500'],'json',10000);
 if(timeout.exitCode===0)throw Error('Direct native timeout unexpectedly succeeded');
 await sleep(4000);
 const cancelled=await command(f,'proof_delay',{milliseconds:3000},'json',10000,600);await sleep(3500);
 evidence.composition.push(safe({fixture:f.label,backend:'direct-cli',timeout:{exitCode:timeout.exitCode,frames:timeout.frames},cancelled:{exitCode:cancelled.exitCode,signal:cancelled.signal,localDiagnosis:cancelled.reason},serverDelayEvents:events(f).filter(x=>x.startsWith('delay-'))}));
 const mcp=new Mcp(f);
 try{
  const init=await mcp.call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'owned-pipeline-proof',version:'1.0'}});
  if(!init.frame?.result)throw Error('MCP initialize framing failed');mcp.notify('notifications/initialized');
  const listing=await mcp.call('tools/list');const tools=listing.frame?.result?.tools;if(!Array.isArray(tools))throw Error('MCP tools/list failed');
  const read=findTool(tools,'read_text_file'),delay=findTool(tools,'proof_delay');
  const identity=await mcp.call('tools/call',{name:read,arguments:{path:'Assets/PipelineSafety/identity.txt'}});
  if(!JSON.stringify(identity.frame?.result).includes(f.label+' exact owned project'))throw Error('MCP selected wrong owned target');
  const failure=await mcp.call('tools/call',{name:read,arguments:{path:'Assets/PipelineSafety/missing.txt'}});
  if(failure.frame?.result?.isError!==true&&!failure.frame?.error)throw Error('MCP missing file did not surface tool error');
  const progress=await mcp.call('tools/call',{name:delay,arguments:{milliseconds:1000},_meta:{progressToken:'owned-proof-progress'}});
  const timed=await mcp.call('tools/call',{name:delay,arguments:{milliseconds:3000}},600);await sleep(3500);
  const cancel=await mcp.call('tools/call',{name:delay,arguments:{milliseconds:3000}},10000,600);await sleep(3500);
  evidence.composition.push(safe({fixture:f.label,backend:'stdio-mcp',initialize:init,toolCount:tools.length,identity,failure,progress,timeout:timed,cancellation:cancel,serverDelayEvents:events(f).filter(x=>x.startsWith('delay-'))}));
 }finally{await mcp.close();}
}
async function safety(f,tools){
 const priorRoot=full(await command(f,'get_authoring_root'),'get_authoring_root');
 const configuredRoot=full(await command(f,'set_authoring_root',{root:'Assets/PipelineSafety'}),'set_authoring_root');
 if(configuredRoot.result?.root!=='Assets/PipelineSafety')throw Error('Observed authoring root differs');
 const sceneBefore=fs.readFileSync(path.join(f.root,'Assets/PipelineSafety/proof.unity'));
 const hierarchyBefore=full(await command(f,'get_scene_hierarchy'),'get_scene_hierarchy');
 const before=fs.readFileSync(path.join(f.root,'Assets/PipelineSafety/delete-probe.txt'));
 const dry=await command(f,'delete_asset',{asset:{path:'Assets/PipelineSafety/delete-probe.txt'},dry_run:true});
 const refuse=await command(f,'delete_asset',{asset:{path:'Assets/PipelineSafety/delete-probe.txt'}});
 const untouched=fs.existsSync(path.join(f.root,'Assets/PipelineSafety/delete-probe.txt'))&&before.equals(fs.readFileSync(path.join(f.root,'Assets/PipelineSafety/delete-probe.txt')));
 const escapeDry=await command(f,'write_text_file',{path:'Assets/PipelineOutside/escape.txt',contents:'owned-proof',confirm:true,dry_run:true});
 const escape=await command(f,'write_text_file',{path:'Assets/PipelineOutside/escape.txt',contents:'owned-proof',confirm:true});
 const escapeAbsent=!fs.existsSync(path.join(f.root,'Assets/PipelineOutside/escape.txt'));
 const noopBatch=await command(f,'batch',{operations:[{command:'create_gameobjects',params:{count:2,name:'PipelineUndoProof'}}],dry_run:true});
 const create=tools.find(t=>t.name==='create_gameobjects'),menu=tools.find(t=>t.name==='menu');
 const hierarchyAfter=full(await command(f,'get_scene_hierarchy'),'get_scene_hierarchy');
 const sceneDrySupported=tools.find(t=>t.name==='create_scene').parameters.some(p=>p.name==='dry_run');
 const dryRunSceneUnchanged=sceneBefore.equals(fs.readFileSync(path.join(f.root,'Assets/PipelineSafety/proof.unity')))&&JSON.stringify(hierarchyBefore)===JSON.stringify(hierarchyAfter);
 const createDrySupported=create.parameters.some(p=>p.name==='dry_run'),menuDrySupported=menu.parameters.some(p=>p.name==='dry_run');
 evidence.safety={priorRoot,configuredRoot,requestedRoot:'Assets/PipelineSafety',sceneDryRunSupported:sceneDrySupported,sceneOperationExecuted:false,dryRunSceneUnchanged,dryRun:dry.frames,unconfirmedRefusal:refuse.frames,assetBytesUnchanged:untouched,outsideRootDryRun:escapeDry.frames,outsideRootRefusal:escape.frames,outsideRootFileAbsent:escapeAbsent,batchDryRun:noopBatch.frames,createGameobjectsDryRunSupported:createDrySupported,menuDryRunSupported:menuDrySupported,menuExecuted:false};
 if(createDrySupported)full(await command(f,'create_gameobjects',{count:2,name:'PipelineUndoProof',dry_run:true}),'create_gameobjects');
 if(!untouched||!escapeAbsent||!dryRunSceneUnchanged||refuse.exitCode===0||escape.exitCode===0)throw Error('Mutation refusal invariant failed');
 full(await command(f,'create_gameobjects',{count:2,name:'PipelineUndoProof'}),'create_gameobjects');
 fs.writeFileSync(path.join(f.root,'undo.request'),'');await wait(f,'undo-before=2-after=0',10000);
 evidence.safety.oneUndoRemovedBoth=true;
}
(async()=>{
 if(matrix.commands.length!==160||matrix.commands.some(r=>!r.risk))throw Error('Complete reviewed 160-command risk matrix required before launch');
 const adapter=new UnityCliAdapter(process.env.UNITY_CLI_BINARY),probe=await adapter.probe({timeoutMs:5000});
 if(!probe.ok)throw Error('Pinned CLI refused '+probe.error.code);if(probe.data.version!==CLI)throw Error('CLI pin mismatch');binary=probe.binaryPath;
 const editors=await adapter.invoke('editors',['-i'],{timeoutMs:15000,readOnly:false});
 if(!editors.ok)throw Error('Editor inventory failed');
 const selected=(Array.isArray(editors.data)?editors.data:editors.data.editors).find(x=>x.version===EDITOR);
 if(!selected?.location)throw Error('Exact Editor missing');const executable=selected.location;editorRoot=path.dirname(path.dirname(executable));
 const exact=(await ps('(Get-Item -LiteralPath '+psQuote(executable)+').VersionInfo.ProductVersion')).trim();
 if(exact!==EDITOR+'_7a9955a4f2fa')throw Error('Exact Editor build mismatch');evidence.editorProductVersion=exact;
 // Existing fixture must be explicitly provided; never infer a user project.
 const existing=process.env.PIPELINE_OWNED_FIXTURE;
 if(!existing||!path.resolve(existing).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(existing).startsWith('uct-pipeline-proof-'))throw Error('Explicit prior owned TEMP fixture required');
 const running=await ps('@(Get-CimInstance Win32_Process -Filter '+psQuote("Name = 'Unity.exe'")+ ' | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('+psQuote(path.resolve(existing))+') }).Count');
 if(Number(running)!==0)throw Error('Prior owned fixture is open; refuse file writes');
 owned.push({label:'fixture-1',root:path.resolve(existing)});
 if(JSON.parse(fs.readFileSync(path.join(existing,'Packages/manifest.json'))).dependencies['com.unity.pipeline']!==PIN)throw Error('Prior fixture pin differs');
 const second=fs.mkdtempSync(path.join(os.tmpdir(),'uct-pipeline-composition-'));owned.push({label:'fixture-2',root:second});
 for(const f of owned){
  for(const d of ['Assets/Editor','Assets/PipelineSafety','Packages','ProjectSettings'])fs.mkdirSync(path.join(f.root,d),{recursive:true});
  // Remove exact task-owned old startup/shutdown source only.
  for(const rel of ['Assets/Editor/PipelineInstallProof.cs','Assets/Editor/PipelineInstallProof.cs.meta','quit.request']){const p=path.join(f.root,rel);if(fs.existsSync(p))fs.unlinkSync(p);}
  fs.copyFileSync(path.join(__dirname,'fixture/Assets/Editor/PipelineSafetyProof.cs'),path.join(f.root,'Assets/Editor/PipelineSafetyProof.cs'));
  fs.writeFileSync(path.join(f.root,'Assets/PipelineSafety/identity.txt'),f.label+' exact owned project');
  fs.writeFileSync(path.join(f.root,'Assets/PipelineSafety/delete-probe.txt'),'must remain unchanged');
  fs.writeFileSync(path.join(f.root,'.gitignore'),'Library/\nTemp/\nObj/\nLogs/\n');
  await new Promise((resolve,reject)=>execFile('git',['init','--quiet',f.root],{windowsHide:true,timeout:10000,maxBuffer:1048576},error=>error?reject(Error('Owned Git fixture initialization failed')):resolve()));
 }
 fs.writeFileSync(path.join(second,'Packages/manifest.json'),JSON.stringify({dependencies:{}},null,2));
 fs.writeFileSync(path.join(second,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: '+EDITOR+'\nm_EditorVersionWithRevision: '+EDITOR+' (7a9955a4f2fa)\n');
 const snapshot=await queryPipelineRegistry(),gate=evaluatePipelineEligibility(EDITOR,PIN,snapshot);
 evidence.secondInstall={checkedAt:snapshot.checkedAt,httpDate:snapshot.httpDate,gate,baseline:{manifest:{dependencies:{}}}};
 if(!gate.ok)throw Error('Fresh second fixture install gate refused '+gate.error.code);
 const install=await raw(['pipeline','install','--project-path',second,'--package-version',PIN],'json',120000);
 if(install.exitCode!==0)throw Error('Second exact install failed');
 evidence.secondInstall.manifest=JSON.parse(fs.readFileSync(path.join(second,'Packages/manifest.json')));
 sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});await sleep(200);
 for(const f of owned){await launch(f,executable);const target=full(await command(f,'editor_status'),'editor_status').result;if(target?.projectPath!==f.root||target.unityVersion!==EDITOR)throw Error('Owned target identity mismatch');await transport(f);}
 // Persist only the two owned discovery rows, never unrelated instances.
 const listing=await adapter.invoke('pipeline',['list'],{timeoutMs:30000,readOnly:false});
 const rows=Array.isArray(listing.data)?listing.data:Object.values(listing.data||{}).find(Array.isArray);
 evidence.discovery=safe(rows?.filter(r=>owned.some(f=>Object.values(r).some(v=>typeof v==='string'&&path.normalize(v).toLowerCase()===f.root.toLowerCase()))));
 if(!evidence.discovery||evidence.discovery.length!==2)throw Error('Both exact owned targets were not discovered');
 let tools;
 for(const f of owned){
  const inventory=await raw(['list','--project-path',f.root]);tools=inventory.frames?.[0]?.data?.tools;
  if(!Array.isArray(tools))throw Error('Live command catalog unavailable');
  const packageNames=tools.filter(t=>t.name!=='proof_delay').map(t=>t.name).sort(),reviewed=matrix.commands.map(t=>t.name).sort();
  if(JSON.stringify(packageNames)!==JSON.stringify(reviewed))throw Error('Live catalog differs from reviewed matrix');
  await compare(f);
 }
 await safety(owned[0],tools);
 evidence.sentinelSurvived=alive(sentinel.pid);if(!evidence.sentinelSurvived)throw Error('Unrelated sentinel was terminated');
 evidence.securityRequirementsMet=evidence.transport.every(t=>t.requiredDefaultsMatch&&t.userRestrictedAcl&&t.routableApiRefused);
 evidence.outcome=evidence.securityRequirementsMet?'passed':'completed_with_findings';
})().catch(error=>{evidence.failure=safe(error.message);console.error('Pipeline composition: '+evidence.failure);}).finally(async()=>{
 for(const c of clients){try{await killOwned(c);}catch(e){evidence.cleanupFailure=safe(e.message);}}
 if(sentinel&&alive(sentinel.pid)){sentinel.kill();const end=Date.now()+2000;while(alive(sentinel.pid)&&Date.now()<end)await sleep(50);evidence.sentinelExitConfirmed=!alive(sentinel.pid);if(!evidence.sentinelExitConfirmed)evidence.cleanupFailure='Owned sentinel cleanup incomplete';} // Exact experiment-owned node sentinel.
 evidence.shutdown=[];
 for(const f of owned){
  if(f.pid&&alive(f.pid)){fs.writeFileSync(path.join(f.root,'quit.request'),'');const end=Date.now()+30000;while(alive(f.pid)&&Date.now()<end)await sleep(500);}
  let forced=false;
  if(f.pid&&alive(f.pid)){
   const ownedMatch=await ps('$p=Get-CimInstance Win32_Process -Filter '+psQuote('ProcessId = '+f.pid)+'; if($p -and $p.Name -eq "Unity.exe" -and $p.ExecutablePath -eq '+psQuote(f.executable)+' -and $p.CommandLine.Contains('+psQuote('-projectPath "'+f.root+'"')+')){"owned"}');
   if(ownedMatch==='owned'){await killOwned({pid:f.pid,exitCode:null,signalCode:null});forced=true;}else evidence.cleanupFailure='Owned Editor identity could not be revalidated';
  }
  const ev=events(f),exit=f.pid?!alive(f.pid):null,normal=ev.some(e=>e.startsWith('normal-exit|')),quitting=ev.some(e=>e.startsWith('quitting|'));
  evidence.shutdown.push({fixture:f.label,processExitObserved:exit,normalQuitMarkerObserved:normal,quittingCallbackObserved:quitting,normalExitConfirmed:exit===true&&normal&&quitting&&!forced,forcedCleanup:forced,editorExitCode:null,events:ev,compilerErrors:log(f).split(/\r?\n/).filter(s=>/error CS\d+|Scripts have compiler errors|Compilation failed/i.test(s)).map(safe)});
  if(f.pid&&!(exit&&normal&&quitting&&!forced))evidence.outcome='incomplete';
 }
 if(evidence.cleanupFailure)evidence.outcome='incomplete';
 const output=path.join(__dirname,'results',evidence.capturedAt.replace(/[:.]/g,'-')+'-windows-x64.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(safe(evidence),null,2)+'\n');
 console.log(JSON.stringify({outcome:evidence.outcome,failure:evidence.failure,evidenceFile:path.relative(process.cwd(),output),normalExitConfirmed:evidence.shutdown.every(s=>s.normalExitConfirmed)}));
 process.exitCode=['passed','completed_with_findings'].includes(evidence.outcome)?0:1;
});
