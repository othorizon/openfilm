// @ts-check
/** Cloud commands share the local desktop account. No session or OSS secret is passed to agents. */
import { ensureStudio } from '../studio/client.mjs';
const HELP=`openfilm cloud configure <https://your-cloud-service>
openfilm cloud register|login <username> --password-stdin
openfilm cloud password --password-stdin   (stdin JSON: oldPassword, newPassword)
openfilm cloud status|logout
openfilm cloud list [--scope mine|public] [--kind asset|snapshot|result] [--q text] [--tag tag] [--type video|audio|image] [--project id] [--offset number]
openfilm cloud preview <item-id>
openfilm cloud upload <file-path> --project <id> [--kind asset|result] [--tags comma,separated] --yes
openfilm cloud snapshot <project-id> --yes
openfilm cloud download <item-id> [--project <id>]  (project required except for snapshots)
openfilm cloud publish|share|delete <item-id> --yes
openfilm cloud withdraw <item-id>
openfilm cloud transfers
openfilm cloud pause|resume|cancel|wait <transfer-id>

JSON responses. Upload/download return a durable transfer ID; wait prints the final result,
including its local project-relative path. Snapshot downloads create a new project.
--yes confirms a cloud mutation already authorized by the person; never invent that authorization.
Cloud tokens stay in local Studio outside projects. Editing and exporting remain local.
HTTP is allowed only on localhost. Passwords come from stdin, never command arguments.
Exit status: 0 success, 1 request/transfer failed, 2 invalid command.`;

/** @param {string[]} args */
export async function cloudCommand(args) {
  if(!args.length || args.includes('--help') || args.includes('-h')){console.log(HELP);return 0;}
  const [action,value]=args;
  const option=(/** @type {string} */ name)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
  /** @type {unknown} */ let body;
  let path='cloud';
  const confirmed=args.includes('--yes');
  try {
    if(action==='configure' && value){path+='/configure';body={serviceUrl:value};}
    else if(['register','login','password'].includes(action) && args.includes('--password-stdin')) {
      if(process.stdin.isTTY)throw new Error('Pipe the password on stdin.');
      let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4096)throw new Error('Password input is too large.');}
      body=action==='password'?JSON.parse(input):{username:value,password:input.replace(/\r?\n$/,'')};path+=`/${action}`;
    } else if(action==='status'){} else if(action==='logout'){path+='/logout';body={};}
    else if(action==='list') {
      const query=new URLSearchParams();for(const key of ['scope','kind','q','tag','type','offset']){const v=option(key);if(v)query.set(key,v);}
      if(option('project'))query.set('projectId',option('project') ?? '');path+=`/items?${query}`;
    } else if(['preview','publish','share','delete','withdraw'].includes(action) && value) {
      if(['publish','share','delete'].includes(action) && !confirmed)throw new Error('Use --yes only after the person authorizes this cloud change.');
      path+=`/items/${encodeURIComponent(value)}/${action==='preview'?'download':action}`;body={confirmed};
    } else if(['upload','snapshot'].includes(action) && value) {
      if(!confirmed)throw new Error('Use --yes only after the person authorizes this upload.');
      path+='/transfers';body={direction:'upload',kind:action==='snapshot'?'snapshot':option('kind')??'asset',projectId:action==='snapshot'?value:option('project'),path:value,confirmed,tags:option('tags')?.split(',').filter(Boolean)??[]};
    } else if(action==='download' && value){path+='/transfers';body={direction:'download',itemId:value,projectId:option('project')};}
    else if(action==='transfers' || (action==='wait' && value)){path+='/transfers';}
    else if(['pause','resume','cancel'].includes(action) && value){path+=`/transfers/${encodeURIComponent(value)}/${action}`;body={};}
    else {console.error(HELP);return 2;}
    const studio=await ensureStudio(line=>console.error(line));
    async function request() {
      const response=await fetch(`${studio.origin}/api/${path}`,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(45_000),headers:{'x-studio-key':studio.key,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw new Error(String(result.error??'Cloud operation failed.'));return result;
    }
    for(;;) {
      const result=await request();
      if(action!=='wait'){console.log(JSON.stringify(result,null,2));return 0;}
      const job=result.transfers.find((/** @type {{id:string}} */ t)=>t.id===value);
      if(!job)throw new Error('Transfer not found for this account.');
      if(!['running','queued'].includes(job.state)){console.log(JSON.stringify(job,null,2));return job.state==='completed'?0:1;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  } catch(error){console.error(error instanceof Error?error.message:'Cloud operation failed.');return 1;}
}
