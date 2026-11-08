/** Synthetic A/B experiment; no application server, tools, or user transcripts. */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fromRoot = name => import(pathToFileURL(`${root}${name}`).href);
const { STABLE_INSTRUCTIONS, PROMPT_VERSION } = await fromRoot('src/agent/instructions.ts');
const { buildRunInput } = await fromRoot('src/agent/infp-agent.ts');
const { buildRuntimeContext } = await fromRoot('src/agent/runtime-context.ts');
const { renderSituation } = await fromRoot('src/agent/situation.ts');
const { estimateTokens } = await fromRoot('src/session/tokens.ts');
const { ToolRegistry } = await fromRoot('src/tools/registry.ts');
const { codingTools } = await fromRoot('src/tools/coding/index.ts');
const { createMemoryTools } = await fromRoot('src/tools/memory.ts');
const { resolveApiKey, DEEPSEEK_BASE_URL } = await fromRoot('src/config.ts');

const live = process.argv.includes('--live');
const longRun = process.argv.includes('--long');
const turnCount = longRun ? 20 : 6;
const cohortCount = longRun ? 1 : 2;
const model = 'deepseek-flash';
const runId = randomUUID();
const resultFile = new URL(longRun ? './prefix-cache-long-results.json' : './prefix-cache-comparison-results.json', import.meta.url);
const MAX_CALLS = longRun ? 40 : 24;
const MAX_INPUT_TOKENS = 200_000;
const MAX_OUTPUT_TOKENS = 96;
const tools = new ToolRegistry([
  ...createMemoryTools({ store: {}, userId: 'synthetic-cache-experiment' }),
  ...codingTools,
]).schemas().map(t => ({ type: 'function', ...t, strict: false }));

const stateCycle = [
  ['/project/frontend', false], ['/project/frontend', false],
  ['/project/backend', true], ['/project/backend', true],
  ['/project/backend', false], ['/project/frontend', false],
];
const states = Array.from({length:turnCount},(_,i)=>stateCycle[i%stateCycle.length]);
const memory = Array.from({length: 8}, (_, i) =>
  `合成项目约定${i + 1}：模块边界清楚，错误需要明确返回；接口说明与测试同步维护，先读取现有实现再修改。` +
  '这是固定测试资料，不是任何真实用户的信息。'
).join('\n');
const fixtures = states.map(([cwd, commands], i) => ({
  expected: { cwd, commands },
  user: `第${i + 1}轮：根据当前工作区和权限，仅输出 JSON 对象，字段 cwd 是当前工作目录，commands 是当前是否允许执行命令的布尔值。不要调用工具。`,
  context: buildRuntimeContext({
    situationBlock: renderSituation({ now: new Date(Date.UTC(2026, 10, 8, 2, i)), timeZone: 'Asia/Shanghai' }),
    workspaceBlock: `# 工作目录\n当前工作目录：${cwd}\n当前是否允许执行命令：${commands ? '是' : '否'}。`,
    relationshipBlock: '# 对话状态\n这是合成的缓存实验。',
    memoryBlock: '# 固定测试资料\n' + memory,
  }),
  // Fixed history keeps both strategies' user/assistant payloads identical.
  assistant: '已记录，请继续。',
}));

function makeInput(strategy, n) {
  const history = fixtures.slice(0,n).flatMap(f => [
    { role: 'user', content: f.user }, { role: 'assistant', content: f.assistant },
  ]);
  if (strategy === 'current') return buildRunInput(fixtures[n].user, history, fixtures[n].context);
  return [...fixtures.slice(0,n).flatMap(f => [
    { type: 'message', role: 'user', content: f.user },
    { type: 'message', role: 'system', content: f.context },
    { type: 'message', role: 'assistant', content: f.assistant },
  ]),
  { type: 'message', role: 'user', content: fixtures[n].user },
  { type: 'message', role: 'system', content: fixtures[n].context }];
}
function wire(items) {
  return items.map(i => i.role === 'assistant'
    ? {type:'message', role:'assistant', status:'completed', content:[{type:'output_text',text:i.content}]}
    : {type:'message', role:i.role, content:[{type:'input_text',text:i.content}]});
}
function common(a,b) { let n=0; while(n<a.length&&n<b.length&&a[n]===b[n]) n++; return n; }
const local = ['current','retain-all'].map(strategy => {
  let previous='';
  const turns=fixtures.map((f,i)=>{
    const items=makeInput(strategy,i);
    const flattened=JSON.stringify({instructions:STABLE_INSTRUCTIONS,tools,input:wire(items)});
    const commonChars=previous ? common(previous,flattened) : 0;
    previous=flattened;
    return {turn:i+1,inputChars:flattened.length,estimatedTokens:estimateTokens(flattened),
      commonPrefixChars:commonChars,estimatedCommonPrefixTokens:estimateTokens(flattened.slice(0,commonChars)),
      contextCopies:strategy==='current'?1:i+1,
      staleStateCopies:strategy==='current'?0:fixtures.slice(0,i).filter(p=>JSON.stringify(p.expected)!==JSON.stringify(f.expected)).length};
  });
  return {strategy,turns,totalEstimatedTokens:turns.reduce((s,t)=>s+t.estimatedTokens,0)};
});
const result={runId,createdAt:new Date().toISOString(),model,promptVersion:PROMPT_VERSION,
  fixture:{turns:turnCount,cohorts:cohortCount,contextChars:fixtures[0].context.length,toolCount:tools.length},
  limits:{maxCalls:MAX_CALLS,maxInputTokens:MAX_INPUT_TOKENS,maxOutputTokensPerCall:MAX_OUTPUT_TOKENS},
  methodology:longRun ? 'One twenty-turn cohort; retain-all then current, opposite the original first cohort. Synthetic fixed assistant history. One-step state query, no tools executed. No forced cache purge. 1.5-second spacing. Local prefix statistics use JSON characters/heuristic, not provider token identity.' : 'Two six-turn cohorts; cohort 0 current then retain-all, cohort 1 reverse. Synthetic fixed assistant history. One-step state query, no tools executed. No forced cache purge. 1.5-second spacing. Local prefix statistics use JSON characters/heuristic, not provider token identity.',
  sourceHashes:{},local,live:[],errors:[]};
for(const name of ['src/agent/infp-agent.ts','src/agent/runtime-context.ts','src/agent/instructions.ts']) {
  const {readFile}=await import('node:fs/promises');
  result.sourceHashes[name]=createHash('sha256').update(await readFile(root+name)).digest('hex');
}
const save=()=>writeFile(resultFile,JSON.stringify(result,null,2)+'\n');
await save();
console.log(JSON.stringify({phase:'local',local,fixture:result.fixture}));
if(!live) process.exit(0);

const key=resolveApiKey(); // Never persisted or printed.
let calls=0,totalInput=0;
try {
  for(let cohort=0;cohort<cohortCount;cohort++) {
    for(const strategy of (longRun || cohort===1 ? ['retain-all','current'] : ['current','retain-all'])) {
      for(let n=0;n<fixtures.length;n++) {
        const input=wire(makeInput(strategy,n));
        const instructions=`合成实验隔离标记 ${runId} ${cohort} ${strategy}\n${STABLE_INSTRUCTIONS}`;
        const predicted=estimateTokens(JSON.stringify({instructions,input,tools}));
        if(calls>=MAX_CALLS||totalInput+predicted>MAX_INPUT_TOKENS) throw new Error('benchmark budget reached');
        calls++;
        const started=performance.now();let firstTextMs=null;let terminal=null;let text='';
        const response=await fetch(`${DEEPSEEK_BASE_URL}/responses`,{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
          body:JSON.stringify({model,instructions,input,tools,tool_choice:'none',stream:true,
            reasoning:{effort:'none'},max_output_tokens:MAX_OUTPUT_TOKENS,
            text:{format:{type:'json_object'}}}),
          signal:AbortSignal.timeout(45_000),
        });
        if(!response.ok) throw new Error(`provider HTTP ${response.status}`);
        let buffer='';const decoder=new TextDecoder();
        for await(const bytes of response.body) {
          buffer+=decoder.decode(bytes,{stream:true});
          const lines=buffer.split('\n');buffer=lines.pop();
          for(const line of lines) {
            if(!line.startsWith('data:'))continue;
            const payload=line.slice(5).trim();if(!payload||payload==='[DONE]')continue;
            let e;try{e=JSON.parse(payload);}catch{continue;}
            if(e.type==='response.output_text.delta') {
              if(firstTextMs===null)firstTextMs=performance.now()-started;
              text+=e.delta??'';
            }
            if(['response.completed','response.incomplete','response.failed'].includes(e.type))terminal=e.response;
          }
        }
        if(!terminal?.usage)throw new Error('provider returned no terminal usage');
        const u=terminal.usage;
        const cached=u.input_tokens_details?.cached_tokens;
        let parsed=null;try{parsed=JSON.parse(text);}catch{}
        const row={cohort,strategy,turn:n+1,actualModel:terminal.model,status:terminal.status,
          inputTokens:u.input_tokens,cachedTokens:typeof cached==='number'?cached:null,
          outputTokens:u.output_tokens,reasoningTokens:u.output_tokens_details?.reasoning_tokens??null,
          firstTextMs:firstTextMs===null?null:Math.round(firstTextMs),totalMs:Math.round(performance.now()-started),
          expected:fixtures[n].expected,answer:parsed,rawAnswer:text,
          correct:parsed?.cwd===fixtures[n].expected.cwd&&parsed?.commands===fixtures[n].expected.commands};
        totalInput+=u.input_tokens;
        result.live.push(row);await save();console.log(JSON.stringify({phase:'live',...row}));
        await new Promise(r=>setTimeout(r,1500));
      }
    }
  }
} catch(error) {
  result.errors.push({message:error instanceof Error?error.message:'benchmark failed',calls});
  await save();console.log(JSON.stringify({phase:'stopped',...result.errors.at(-1)}));
  process.exitCode=1;
}
console.log(JSON.stringify({phase:'finished',calls,totalInput,resultFile:fileURLToPath(resultFile)}));
