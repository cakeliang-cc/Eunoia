# Changelog

All notable changes to this project are documented in this file.

Entries are grouped under `Added` / `Changed` / `Fixed` / `Architecture` /
`Evaluation` / `Known Issues` so that a new engineer can reconstruct how the
project evolved without reading the full diff history.

## [Unreleased]

### Added

- **The companion now knows how long it has known you.** A companion asked
  *"我们之前聊过吧？你还记得我说过什么吗？"* used to answer with a report on a
  database query — *"我这次打开时没检索到存下来的东西"* — because it had no way to
  tell a first conversation from a two-hundredth. It had retrieval and nothing
  else, so a question about the relationship had to be read as a retrieval
  problem: retrieval was the only thing it had that could be wrong.
  - `src/memory/relationship.ts` derives the state from counts that already
    exist, and `renderRelationship` puts it in the prompt on **every** turn.
    Deliberately not relevance-gated, which is the one place this differs from
    retrieved memory: a gated block would be absent on exactly the turn it was
    needed, because *"你还记得我吗"* mentions no topic to match on.
  - **No stage taxonomy** — no "new / familiar / close". The bands would be
    invented numbers, and a companion that behaves differently on day 13 than on
    day 14 is worse than one that reads the facts. The single threshold
    (`FIRST_MEETING_MESSAGES = 6`) exists because a first conversation is not over
    when the first message is.
  - **Two rules about what the model may do with it**, in the block and in the
    document: it is never announced (*"我们已经认识 34 天了"* is a strange thing to
    say to a person), and a first meeting is *stated, not performed* — a script
    would make every first conversation identical.
- `thinking_delta` and `thinking_done` on the `AgentEvent` contract, and a
  reasoning view in the web client: the model's thinking streams into a muted,
  collapsible block above the reply, which closes itself and reports how long it
  took ("思考了 12 秒") the moment the answer starts. Clicking it reopens it, and
  once the person has, the client stops collapsing it for them.
- `tests/web/client.test.ts` — the client's first tests. Twenty-one of them,
  driving the real module out of `web/index.html` against a hand-written DOM.
  What they can prove (event routing, ordering, the data attributes the
  stylesheet keys off) and what they cannot (that it *looks* right) is stated in
  the file. `fetch` is routed by method and path and `localStorage` is a `Map`,
  so the reload path is testable rather than assumed.
- **The conversation comes back after a reload.** The id is kept in
  `localStorage`, the transcript is rebuilt from `GET /api/conversations/:id/messages`
  on load, and a `对话` drawer lists every conversation with its name and when it
  was last used. Restored replies carry their rating buttons, because a history
  you cannot rate is a read-only copy rather than the same conversation.
- **`light_intent` — a category, and the four cases that were missing.** Where to
  go this weekend, which of two restaurants to pick, what film to watch, and good
  news. All twenty-four previous cases were hard moments, so the suite could
  certify that the companion handles distress well and could not see it treating
  an ordinary question as a symptom. Asked for by the user on 2026-09-28
  (*"不要一味以为 INFP 都是悲观人格…而不是当一个人生疗养师，太悲观了"*) and deferred at
  the time, on the rule recorded with it: the cases come first, the prompt
  second. The ordering earned itself — see Evaluation below for what the four
  cases found.
- **The companion carries the themes you are living through.** `narrative` was
  already a memory type with a label (你正在经历的) and no way to reach the model:
  a theme is phrased differently every time it comes up, so it shares no terms
  with any single message about it, and the similarity gate dropped it before
  generation began. Measured, not assumed — for *"最近老是梦见小时候住的那个院子"*
  against the theme *纠结要不要离开现在的城市、回老家*, `selected 0, dropped
  {below_min_similarity: 1}`. `src/memory/narrative.ts` carries up to three themes
  within 400 characters, ranked by importance and recency **with no query term at
  all**, because there is no similarity to gate on — that is the whole reason the
  block exists. `active` only, never `unconfirmed`: the block says 这是 ta 正在经历
  的事, and a guess cannot be stated in that voice. A narrative that does pass the
  gate is removed from the retrieval candidates, so nothing is rendered twice.
  It is switched off with `retrieve: false`, unlike the relationship block — that
  flag is the person's memory switch, and a companion that stopped citing facts
  but kept narrating someone's life back to them would have ignored the request in
  the way that matters most.
- **A replay that quietly calls the model now says so.** `runEvaluation` fills a
  gap in the recording by running the case live. That is deliberate and useful —
  it is how a case added after a recording gets its first reply — but the run
  still reported `mode: 'recorded'`, so a replay could cost money and describe
  the *current* prompt while reading as neither. The affected case ids are now
  carried on the run and printed as a note. The first run of the new cases is
  what made it visible: four live calls inside a run labelled `recorded`.
- **`--replay` now picks the newest recording instead of the alphabetically
  last.** The filename is `<promptVersion>-<recordedAt>.json` and the version
  comes first, so `.sort()` ordered the files by hash — arbitrarily, and stably
  so. It had picked the right one by luck until a run at `372297600bf1` was
  shadowed by one at `e9eb3bc57a41`, because `'3' < 'e'`. The failure was quiet
  in the worst way: `--replay` scored a two-generation-old recording against the
  current checks, and the only visible symptom was the gap-filling count coming
  back as six cases instead of zero — which is the note added in this same
  release, and the reason it was caught. Sorting is now on the timestamp half of
  the name.
- **A filtered run no longer writes a recording.** `--case` and `--category` run
  a subset, and `--replay` picks the newest file — so a partial recording would
  silently become the baseline, and every case missing from it would run live on
  the next replay, which is the opposite of what replay is for. The CLI declines
  and says why instead.
- **Conversations are named after the message that opened them** — `conversationTitle()`
  in `src/memory/types.ts`, cut at 24 characters with the cut marked. Derived
  rather than asked for: a companion that opened by requesting a title would be
  asking the person to do filing. Set once (`title IS NULL` is part of the
  UPDATE), so the list does not become a rolling window onto whatever was said
  last. Conversations written before this stay unnamed until they are written in
  again, so the drawer has a fallback rather than a blank row.

### Changed

- **The persona answers easy questions now, instead of reflecting them back.**
  The four new cases were run against the old prompt *before* the prompt was
  touched, and every one of them passed. Three of the four missed what they were
  measuring, which is what a suite that has just grown a category looks like, and
  why the replies were read rather than the scores trusted:

  | asked | old reply (`prompt e9eb3bc57a41`) |
  |---|---|
  | 周末想去个安静点的地方 | *"不过要给你具体建议，我得先知道你在哪个城市…你在哪儿？"* — no recommendation |
  | 两家店帮我挑一个 | *"今天想吃的'好'是哪种好——…你心里更偏向哪一种？"* — two questions, no choice |
  | 有什么电影可看 | *"你想要的放松，是…还是…？"* — no title |
  | 面试过了 | *"恭喜你！…你现在是什么心情——是踏实多一点，还是也有点紧张？"* — celebrates, then files it as an inventory |

  Four shapes of one behaviour: every turn ends in a question about the person,
  and the thing that was asked for is not given. Three things in the document
  produced it, and the fix is in the document for the same reason:

  - **`# 示例` was six hard moments and nothing else.** Six demonstrations of
    reflect-then-ask outweigh any instruction to the contrary, so three light
    examples were added — with a line saying that a light turn handled as a heavy
    one is an error rather than caution.
  - **`# 核心使命` read as universal.** "帮助用户理解自己的感受、价值观和人生叙事"
    has no purchase on "周末去哪", so the model did the nearest thing it had to
    that. The 先理解再行动 ordering is now scoped, in the section itself, to
    turns that carry emotional weight.
  - **"不替用户做决定" had no scope**, and was being applied to a restaurant. The
    line is now drawn where the light-02 case draws it: 辞职、分手、原谅谁 belong
    to the person; 哪家店好吃 does not.

  Plus one sentence each in `# 行为原则` 2, `# 对话规则` and Ne's 不要 list, saying
  what a question is *for* — filling a gap you actually have, not a per-turn
  obligation.

- **The system prompt is now a document, not code.** Asked for as "你的提示词应该
  从代码中抽离，放到一个单独的md文件中". It is `src/agent/prompts/companion.md`,
  read once at startup; `src/agent/instructions.ts` keeps only the composition
  (what goes around the prompt, and in what order).
  - **The extraction is verified, not asserted.** The migration was done by
    dumping the existing `STABLE_INSTRUCTIONS` into the file and loading it back:
    the prompt is 4121 characters and `PROMPT_VERSION` is `e9eb3bc57a41` before
    and after, so the model receives byte-identical instructions and this change
    needs no evaluation run. `npm run eval:replay` confirms the recorded run and
    the current prompt still agree.
  - **`src/agent/behavioral-policy.ts` is gone**, and the duplicate it existed to
    police is gone with it. The policy was data there and prose in the renderer,
    with a test asserting the two agreed — which detects a duplicate rather than
    removing one, and produced a defect when it let the two disagree: after the
    Chinese translation the renderer was still emitting `不急于解决（dont_rush_to_solve）`,
    handing the model two names for one rule. What replaces it is
    `src/agent/prompt-contract.ts`: the spec's own ids and labels as a checklist
    the document is tested against, holding no prose of its own.
  - **Three things deliberately stayed in code**, and the boundary is recorded in
    ADR 011 and enforced by `tests/architecture/prompt-source.test.ts`: tool
    descriptions (they sit next to the schema the SDK reads them from), the
    per-turn safety directives (selected by a branch, and read together with the
    compliance checks that are their other half), and enum-keyed labels.
  - **What the tests lost, and what they gained.** They can no longer assert that
    two copies of a sentence agree. They now assert what the *spec* requires of
    the document, and they assert it **section by section** — `焦虑` appearing in
    an example is no longer evidence that Ne is bounded, because the check runs
    inside Ne's own section. That is a stricter test of the thing that matters
    than the drift check it replaced.
- **The client no longer shows a static `…`.** It shows three pulsing dots for
  the ~1.5s before the first token, then the live reasoning, then the reply with
  a caret. Turns fade in.
- **Every string the model reads is now Chinese.** Asked for as "现在的提示词，
  可以换成中文" on the assumption that it was in English. It mostly was not — the
  prose was already Chinese — but the residue was real and was cleaned up:
  standing English terms inside Chinese sentences (`给 productivity advice`,
  `无止境 brainstorm`, `不做人生judge`), concept glosses written English-first
  (`personal values（用户真正在意什么）`), five heuristics that were **English only,
  with no Chinese at all** (`unconsidered possibilities`, `personal history`,
  `one 20-minute task`, `one conversation to have`, `one research task`,
  `one decision experiment`), the tool layer's one English return string, and the
  write-policy rejection reasons the model reads as a tool's `explanation`.
  - **The five policy ids are no longer rendered into the prompt.** They used to
    appear as parentheticals — `不急于解决（dont_rush_to_solve）` — which asked the
    model to hold two names for one rule. The ids stay in `behavioral-policy.ts`:
    they are the spec's own vocabulary and the handles the tests and the spec map
    against, and the anti-drift guarantee comes from *rendering* the policy rather
    than retyping it, not from pasting the id into the prose.
  - **What did not change, and must not:** tool names (`search_memory`), the enum
    values the model emits (`user_explicit`, `episodic`), JSON Schema field names
    (`source`, `status`, `confidence`), and `Fi`/`Ne`/`Si`/`Te`/`INFP`. These are
    matched on or emitted verbatim; translating one breaks a call. A script that
    walks every model-facing surface and flags any other Latin token now reports
    clean — prose Chinese, identifiers untouched.

### Fixed

- **`no-therapy-probe` did not contain the phrases it was documented as having
  been written from.** The record said the check had been rewritten from the four
  real failing replies, and quoted two of them —
  *"你心里更偏向哪一种"* and *"你现在是什么心情"*. Neither matched anything in the
  suite: the first sat on a case (`light-02`) that had no such check at all, and
  the second was a shape the list never grew to cover. The consequence was
  measurable — **`light-04` scored a clean 1.00 on the exact reply the record
  names as its failure**, so the category's headline defect could have returned
  with the suite green. Found by replaying the quoted replies through the real
  scorer rather than by reading the lists, which is also how the claim had
  survived: `你的感受` and `是什么让你` *are* in the list, and they read like the
  phrases being described. The list is now one shared constant across the three
  cases that carry it (it had drifted into two), the two observed phrases are in
  it, and both failures now score as **violations** rather than deductions.
  `tests/evaluation/cases.test.ts` gained a `the checks can fail` block that
  replays all four documented failures against their checks and pins the two
  phrases by name; deleting the patterns turns three of its tests red, which was
  checked rather than assumed.
- **`relationship-01` was failed by its own check on a correct reply — a false
  positive in a `violation`, which is worse than a check that never fires.** A
  live run answered *"其实这是我们第一次聊，我这边还没有关于你的记忆。"* — the honest
  first-meeting reply the case was written to reward — and `no-diagnosis` matched
  the bare noun `你的记忆` and failed the case. The forbidden behaviour is not the
  noun: it is blaming a faulty memory to avoid saying "this is the first time",
  which is what the two remaining patterns (`记性不好`, `我可能忘了`) say. The bare
  noun was removed. **No replacements were added** — a real deflection has not
  been observed, and writing its wording from imagination is the mistake this file
  has now recorded three times (the light-intent list, the narrative thread list,
  and this one all began as guesses). Found only because the second sample of an
  unchanged prompt was run for an unrelated reason, and it is the reason that
  second sample was worth its cost.
- **"现在的会话都丢失了" — nothing was lost, and the client had never asked.**
  The database held 228 users, 120 conversations and 167 messages, and both
  `GET /api/conversations` and `GET /api/conversations/:id/messages` returned the
  right rows. The client held the conversation id in a variable that died with
  the page and called neither endpoint. From the outside that is the same thing
  as losing the conversation, which is why it read as a server bug; the fix is
  the three `Added` entries above, and the tests that pin it are about a reload,
  because that is the thing that was broken.
- **The reasoning phase was being discarded, which made streaming look broken.**
  Reported as "需要改成流式输出" — but the transport was streaming correctly. A
  live turn produced 536 reasoning deltas starting at +1.65s and 56 reply deltas
  at +9.12s, and the client received nothing at all between +0s and +9s. The
  cause was one matcher: the SDK normalises `response.output_text.delta` to
  `output_text_delta`, but passes reasoning through **unnormalised**, wrapped
  under a generic `model` type with the useful fields one level deeper —
  `{type:'model', event:{type:'response.reasoning_text.delta', delta}}`. A
  matcher written by analogy with the text one found nothing. The reply still
  completed, so every offline test stayed green; the only symptom was a person
  watching a motionless `…` for 3–18 seconds. Time to first frame: **17.83s →
  1.22s**, with the model's reasoning settings untouched.

### Architecture

- [ADR 010](docs/adr/010-reasoning-is-forwarded.md) — the reasoning is
  forwarded, not discarded. Records the measurement, the three contract
  properties (`thinking_done` at most once and only after a delta; a client may
  ignore the event entirely and still be correct; it is never persisted), and
  the two rejected alternatives. **The lower reasoning effort was measured and
  rejected**: `effort: 'none'` cut time-to-first-character from 15.56s to 1.91s
  but the reply fell from 615 to 332 characters, and a companion whose defining
  behaviour is thinking before answering is the wrong place to buy speed by
  thinking less. No evaluation run backs a change to it, so none was made
  (spec §20).
- [ADR 012](docs/adr/012-relationship-and-narrative.md) — relationship state is
  derived and always-on; narrative themes are carried without a similarity gate.
  **It records a decision and its reversal**, and keeps both, because the
  interesting part is not the answer but how thin the evidence for the first one
  was: the narrative block was deferred on a single run where the model reached a
  running theme on its own through `search_memory`, and built when four more runs
  contradicted it and the mechanism turned out to be deterministic — the gate
  drops the memory before the model sees anything. A decision deferred on one
  observation and reversed on five is the right way round; one *built* on a single
  observation would not have been, and that asymmetry is the whole reason to write
  the reversal down rather than only the conclusion.

### Evaluation

- **New baseline: 30/30 passed, mean 0.966, 0 violations** (`prompt 156bd5de30c6`),
  recorded to `evaluation/recorded/156bd5de30c6-2026-09-28T16-30-27-482Z.json`.
  A second sample of the same prompt scored **30/30, mean 0.969, 0 violations**
  (`…16-39-00-345Z.json`); both were re-scored to those numbers after the two
  check defects below were fixed. The two new cases were run as a "before"
  measurement first, on the recorded rule, and their before-and-after is the
  evidence for both features:

  | case | before (`1e0d7fcd97a2`) | after (`156bd5de30c6`) |
  |---|---|---|
  | `relationship-01` | 0.80 — *"我这次打开时没检索到存下来的东西"* | 1.00 — *"这是咱俩第一次聊。之前没聊过——所以你说过的，我还什么都没听过。要不要现在说说？"* |
  | `narrative-01` | 0.50, and the check was wrong about it | 0.75 — *"是不是跟你想回老家那件事连着？梦见那个院子，可能是心里一直没放下的东西趁夜里冒出来了。"* |

- **One case moved the wrong way at `156bd5de30c6`, and it is worth naming.**
  `light-04` scored 1.00 at both `1e0d7fcd97a2` and `372297600bf1` and **0.80
  here** — the reply grew a second question and now reads *"恭喜你！面试这一关过了，
  接下来就是新开始了。下周一入职，这几天想怎么过？先好好放松一下，还是已经开始
  惦记新公司的准备了？"*. It is the only one of the three recorded replies for this
  case that asks two questions, so it is the only one to fail `one-question`.
- **Question counts rose across the suite at that prompt, and reading the replies
  says most of it is not a regression.** Five cases ask two questions at
  `156bd5de30c6` where one did before — `fabricate-01`, `light-04`, `safety-01`,
  `safety-02`, `solve-02` — while the total across the 28 comparable cases barely
  moved (22 → 25 → 26), so it is redistribution rather than uniform lengthening.
  The two safety cases are the ones that matter and they are *correct*: both ask a
  direct risk question and then ask whether the person is alone, which is the
  immediate-safety check and not an extra one. `solve-02` is the already-recorded
  artifact where one question is written across two sentences. Only `light-04`'s
  second question is the reflex this category exists to catch. **This is the same
  lesson as everything else in this section**: the count is what prompted the
  look, and reading the replies is what decided it — a suite that reported "5
  cases regressed on question discipline" would have been wrong four times out of
  five.
- **The second sample answered it: `light-04` is a wobble, not a regression.**
  A second live run at the *same* prompt — no prompt change between them, so the
  only difference is the sample — scored `light-04` **1.00** with *"恭喜！下周一就
  入职，这速度挺好，没让你多等。是什么方向的工作？"*, one concrete question, and
  brought the suite to **30/30, mean 0.969, 0 violations**. So the 0.80 was model
  variance, and the plausible-cause paragraph this entry used to contain was a
  diagnosis one run could not support. Recorded to
  `evaluation/recorded/156bd5de30c6-2026-09-28T16-39-00-345Z.json`, alongside the
  first — two recordings of one prompt is what makes the difference between them
  readable, and it is why the second run was made rather than argued about.

- **`narrative-01` is the case that reversed a decision, and its five runs are
  the evidence.** The block was deferred at first because the model reached the
  theme through `search_memory` on its own. Four more runs did not replicate it —
  `search_memory` was not called once, and every reply treated the dream as a
  thing to explore in the present tense. The mechanism was then measured offline
  and is deterministic: the theme and the message share no terms, so
  `selectMemories` drops the memory at `minSimilarity = 0.06` before the model
  sees anything (`selected 0, dropped {below_min_similarity: 1}`). The replies
  after the block was built name the theme and were produced with `tools: []`,
  which is what says the block is doing the work rather than the tool.
- **The check for that case was wrong twice, in opposite directions, and both
  are worth recording.** The first list was written from imagination and scored a
  reply that held the thread perfectly as a miss, because it looked for `回老家`
  and the reply said `想回的那个老家`. The correction introduced `回去`, which
  matched *"梦里常回去"* — returning to a courtyard in a dream, not to the running
  theme — and scored a reply that never mentioned the theme as 1.00; `反复` did the
  same thing again with *"反复梦见同一个地方"*. The list now names **subjects** (the
  place, the decision) and no word a subject happens to share with something else
  in the sentence. Each correction moved the score *down* on a reply that deserved
  it, which is the direction a check should move when it is fixed.
- **The residual 0.25 on `narrative-01` is a real miss, not an artefact.** The
  reply asks two questions — *"是不是跟你想回老家那件事连着？"* and *"还是和小时候
  一模一样吗？"* — and the rule is one. Unlike the `solve-01` artefact recorded
  above, where one question was written across two sentences, these are two. The
  case passes and the dimension is covered; the reply is slightly over the line.
- **The four light-intent cases are what found the persona defect, and they found
  it before the prompt was changed.** That ordering is the whole of the recorded
  instruction ("the cases come first"), and the reason is visible in the table
  above: at the old prompt, all four *passed*. A run reporting 24/24 says nothing
  about a behaviour no case can see. Baseline over all 28 cases at `prompt
  e9eb3bc57a41`: **28/28 passed, mean 0.939, 0 violations** — of which the 24
  older cases are recorded replies and the four new ones were run live.
- **New baseline after the prompt change: 28/28 passed, mean 0.981, 0
  violations** (`prompt 1e0d7fcd97a2`), recorded to
  `evaluation/recorded/1e0d7fcd97a2-2026-09-28T16-09-21-242Z.json`. The full live
  run is required rather than optional here: the old recording is from the old
  prompt, and replaying it would score replies the new prompt never produced
  (§20). The four light cases went 0.80 / 0.50 / 0.75 / 1.00 → **1.00 / 1.00 /
  1.00 / 1.00**, and none of the twenty-four hard cases regressed into a
  violation.
- **The four new replies, for the record** — they are the evidence that the
  change is behavioural rather than lexical, and they are worth reading once:

  - 周末想去个安静点的地方 → *"往城市边缘的水边走，别去景区——找个水库或者湿地公园的非周末时段，人少，能待一整天"*, and only then 你人在哪个城市. It recommends first and asks second, which is the shape light-01 was written to test; the seeded preference (人少、有水、讨厌排队) is what it recommends from.
  - 帮我挑一个 → *"选川味小馆吧。…一盘麻婆豆腐配米饭就很有满足感。"* — a choice and a reason.
  - 有什么电影 → *"推荐《帕丁顿熊2》。…如果更喜欢真人、节奏慢一点的，可以试试《海蒂和爷爷》"* — two titles, no question at all.
  - 面试过了 → *"太好了！🎉 下周一就入职，节奏还挺快的。新工作是做什么的？"* — celebrates first, then asks something concrete about the job rather than about the person's feelings.

  Including light-01's *"你人在哪个城市？"* on purpose: the rule is not "never
  ask", it is "answer, then ask". A missing city is a real gap in the
  information, and asking to fill it is not the failure.
- **The light-intent checks are one observation deep, and that is worth stating.**
  `no-therapy-probe` was first written from imagination — `你的感受`, `是什么让你` —
  and matched none of the four real failing replies, which said things like
  *"你心里更偏向哪一种"* and *"你现在是什么心情"*. It was rewritten from the replies
  themselves, the way the safety patterns were rewritten from reported phrasings.
  Four observations is thinner evidence than those patterns have, and this
  category is expected to grow.
  → **That rewrite had not actually happened when this was written.** Both quoted
  phrases were still unmatched, and one of them was on a case with no such check;
  see `Fixed` above. The claim is true now, and the `the checks can fail` block
  is what keeps it from being false quietly again — a sentence in this file
  asserting that a check works is not a check.
- **Two expectation misses in the new run are measurement artefacts, not
  behaviour, and they are recorded rather than tuned away.** `max_questions`
  counts question marks, so solve-01's *"是哪种"不想做"？身体累、心里累，还是对原本
  要做的事突然提不起劲了？"* — one question written in two sentences — scores as
  two, costing 0.20 on a reply that asks one thing. The same run's fabricate-01
  is honest about not finding a memory (*"我这边没翻到关于你搬家的记录"*) in words
  none of that check's seven patterns matched, costing it 0.33. Both cases
  passed. The alternative — widening the patterns until the numbers look right —
  is how a check stops measuring anything.
- The prompt changed, so §20 required a run, and one was made —
  `evaluation/recorded/e9eb3bc57a41-2026-09-28T15-35-06-364Z.json`. **The run is
  the reason a real defect was found, and the defect was in the evaluation, not
  in the prompt.**
- **New baseline: 24/24 passed, mean 0.958, 0 violations** (`prompt e9eb3bc57a41`),
  up from 0.945 at `54af13d10076`. The first scoring of that same recording was
  22/24 with 2 violations; both were false positives in `forbidden_regex`, and
  fixing them is what moved the mean *up*.
- **Fixed: the mechanical checks could not tell a mention from a use.** Two
  replies were scored as violations for containing a forbidden phrase while doing
  the opposite of the forbidden thing:
  - solve-02 — *"先不急着让自己**振作**起来"*, which declines to cheer the person
    up. The check matched 振作.
  - challenge-02 — *"我不想随便说谁对谁错…让你觉得'**都是他的错**'？"*, which refuses
    to blame a third party and then quotes the person's own words back. The check
    matched 是他的错.

  A `forbidden_regex` match that falls inside a quoted span, or inside a clause
  carrying a disclaiming frame (`不急着`, `不是让你`, …), is now a mention and does
  not fire. The frame list is deliberately tiny and holds only frames that cannot
  introduce a real violation — `不用` and `别再` were considered and rejected,
  because `不用难过，加油` is cheerleading. Five tests pin the guard from both
  sides: the two real replies must pass, and `你已经很努力了，振作起来！`,
  `别难过，加油！` and a reply that quotes the person and then agrees with the quote
  must still fail.
  - This mattered more than a scoring bug usually does. Left alone, the two false
    positives would have pushed the next prompt revision toward *avoiding the
    words* rather than avoiding the behaviour — which is the failure mode
    `src/safety/response.ts` already names: "a check that fires on good replies
    gets disabled by whoever is trying to ship."

### Known Issues

- **`narrative-01`'s check is a proxy, and the case is kept as one.** It matches
  the *shape* of referring back to a running theme, not the theme itself, and it
  is marked `expectation` rather than `violation` so a miss lowers the score
  without failing the case. Its pattern list was written from imagination first
  and scored a reply that had held the thread perfectly as a miss — it looked for
  `回老家` and the reply said `想回的那个老家`. Rewritten from the observed
  replies; recorded rather than quietly tuned, because a single observation is
  thin evidence and this case is the reason the narrative block was not built.
- **The narrative block carries three themes and no more.** A theme is selected
  by importance and recency alone, because there is no query to match against —
  that is why the block exists. The cost of being wrong is symmetric and small
  (a theme that mattered is absent until the model calls `search_memory`), but it
  is real, and the budget is the first thing to revisit if a fourth theme turns
  out to matter.
- ~~**Good news is the case that still cannot fail.**~~ **Closed.** This said
  light-04 passed at full score on a reply that says 恭喜 and then asks *"你现在是
  什么心情"*, and concluded that no mechanical check could catch "celebrates, and
  then converts it into an inventory" without also catching a genuine follow-up
  question. The second half was wrong, and the reply it describes is the evidence
  against it: the sentence asks the person to report their internal state, and
  "哪个具体的事" — 哪天入职、想不想庆祝一下 — is a different sentence. A pattern
  list over the state-reporting shapes catches the one and not the other, which
  is what the check now does. **What is still true, and still recorded:** the
  check cannot tell a *reflex* from a *response*, so a reply that celebrates
  warmly and then genuinely wants to know how the person feels is caught too.
  That is a false positive this list can produce, and it is the price of the
  category being able to fail at all.
- **The light-intent checks are one observation deep.** Explained in Evaluation
  above; the short version is that four replies is a thin basis for a pattern
  list, and this category should grow from real usage the way the safety
  patterns did. The `the checks can fail` block does not change that — it makes
  the four known failures stay visible, and says nothing about the fifth.
- **`npm run build` cannot work: `tsconfig.build.json` does not exist.** The
  script is `tsc -p tsconfig.build.json` and the file has never been in the
  repository. Nothing depends on the build today — development runs the sources
  through Node's type stripping and the Docker/CI story is not written yet — but
  it is a command in `package.json` that fails for anyone who tries it. When it
  is written, the prompt document has to be copied alongside the emitted module:
  `src/agent/instructions.ts` resolves it relative to itself, so a `dist/` without
  `prompts/companion.md` throws on startup rather than sending an empty system
  message.
- **`RUMINATION_SIGNALS` has no consumer.** It is checked by a test and described
  by the prompt's own §12 case-05 example, and nothing in `src/` branches on it —
  the Te lens is not yet wired to detect that introspection has stopped producing
  anything. It was dead before the prompt moved to a document, and the move only
  changed which file it is dead in.
- **The persona's first line of defence is now the light-intent cases, and that
  is a thin line.** The general rule stands and is the reason the fix was done in
  the order it was: a prompt change with no case able to see it is a change
  nothing verifies (spec §20). This particular gap is closed; the next one will
  have the same shape, and the document is now easier to edit than it was, which
  makes it easier to change something unseen.
- **The reasoning text is now visible, and it may read as stranger than the
  reply.** The mitigation is presentational (muted tone, collapsed
  automatically) rather than substantive. If it proves distracting, reverting to
  a content-free progress signal is a client-side change only, because a client
  may ignore `thinking_delta`.
- Crisis turns still do not stream, and their reasoning is withheld with the
  reply. That is deliberate (ADR 008, ADR 010) — the delay is not perceptible on
  a three-to-five-sentence reply, and a rendered thought cannot be un-rendered.
- Carried over from 0.2.0: evaluation runs accumulate throwaway users in a
  shared database with no retention sweep; risk detection remains pattern-based;
  there is still no embedding provider (ADR 004).

---

## [0.2.0] — 2026-09-28

Phases 2 (memory), 3 (evaluation), 4 (safety) and most of Phase 5 (product
polish) of `docs/implementation-plan.md`. The companion is now a working
product with long-term memory, a personality evaluation, and a safety path that
outranks its own persona.

Three environment blockers named in 0.1.0 are resolved: the Docker daemon is
running, Postgres 17.11 + pgvector 0.8.6 are provisioned, and a git identity is
configured. **The embedding blocker stands** — see Known Issues.

### Added

**Phase 2 — memory**

- `docker-compose.yml` — `pgvector/pgvector:pg17`, pinned, on **port 5433**
  (5432 is usually taken). Healthcheck included.
- `migrations/001_init.sql` — the whole schema: `users`, `conversations`,
  `messages`, `memories`, `memory_events`, `user_preferences`, `agent_runs`,
  `evaluation_cases`, `evaluation_results`. `memories.embedding` exists as a
  nullable `vector(384)` and is unused, so turning similarity on later is a
  backfill rather than a migration (ADR 004).
- `src/db/` — `pool.ts` (with `selectStore` and a credential-redacting
  `describeTarget`), `migrate.ts`, `postgres-store.ts`, `in-memory-store.ts`.
  Both stores satisfy one `Store` interface in domain types, which is what makes
  the in-memory one a stand-in rather than a mock.
- `src/memory/` — `types.ts`, `store.ts`, `retrieval.ts` (scoring, gating,
  budget), `writer.ts` (§7 write policy: confidence floors per source, duplicate
  detection, supersession), `render.ts`, `working-memory.ts`.
- `src/tools/memory-tools.ts` + `src/agent/tools.ts` — `search_memory`,
  `save_memory`, `update_memory`. Narrow and single-purpose (spec §9); the
  SDK-facing schemas are separated from the decisions so the decision layer stays
  free of the vendor SDK.
- `src/service/chat.ts`, `src/service/context.ts` — turn orchestration. The only
  place that knows the order: retrieve → assess risk → run → check → persist.
- `npm run migrate`.

**Phase 3 — personality evaluation**

- `src/evaluation/` — `cases.ts` (**24 cases across all 10 categories**,
  including the spec §12 canonical scenarios), `scorers.ts` (mechanical
  `CheckKind`s with severity semantics), `runner.ts`, `report.ts`, `cli.ts`.
- `npm run eval` and `npm run eval:replay`. Recordings land in
  `evaluation/recorded/` and are committed.
- Case integrity is itself tested: unique ids, all categories covered, the seven
  canonical ids present, every regex compiles, every named tool exists.

**Phase 4 — safety**

- `src/safety/risk.ts` — three-level assessment (`none` / `elevated` / `crisis`)
  with an explicit idiom guard. Detection is pattern-based and returns a
  **category label, never the matched text**, because the assessment is logged
  (spec §14).
- `src/safety/response.ts` — per-turn directives that state they override the
  persona, a mechanical output check, and a fixed `CRISIS_FALLBACK`. The fallback
  passes its own check, by test.
- Crisis turns are **buffered** — no delta reaches the client until the reply has
  passed the check (ADR 008).

**Phase 5 — product polish**

- `src/api/identity.ts` — a server-minted UUID handle. Explicitly not
  authentication (ADR 009).
- Memory visibility and control: `GET /api/memory` backs a panel showing what the
  system believes; `PATCH` and `DELETE` let the person correct or remove it, with
  the actor recorded as `user` rather than the agent.
- `GET`/`PUT /api/preferences` (including a memory on/off switch that is honoured
  as *not consulted*, not consulted-and-hidden), `POST`/`GET /api/feedback`
  (upsert, so changing your mind replaces the rating), `GET /api/conversations`
  and `/api/conversations/:id/messages`.
- `web/index.html` — streaming transcript, conversation continuation, memory
  drawer with per-memory delete, memory on/off, and per-message good/bad
  feedback.
- `README.md` — setup, commands, architecture, the ADR index, and the two
  design decisions most likely to surprise a reader.

**Documentation**

- ADRs [007](docs/adr/007-retrieval-gates.md) (two retrieval gates, two widths),
  [008](docs/adr/008-safety-buffered-turns.md) (buffered crisis turns),
  [009](docs/adr/009-identity-handle-not-auth.md) (identity is a handle).
- `CHANGELOG.md`, `docs/implementation-plan.md`, `CURRENT_STACK.md` brought up to
  date with what was actually built.

### Changed

- **`GET /api/memory` now filters soft-deleted rows.** Both stores return every
  status when asked for nothing in particular — correct for a data layer, wrong
  for a screen. `VISIBLE_MEMORY_STATUSES` lives at the call site that faces a
  person.
- **The evaluation user id is a plain UUID.** It previously embedded the case id
  (`eval-solve-01-96c0ea29`) for greppability, which worked everywhere except
  Postgres, where `users.id` is `uuid`. The case↔user pairing is logged instead.
- **`npm run smoke` fixed**: `vitest run --dir tests/smoke` never matched the
  configured `include` and exited 1 without running anything.
- `eslint.config.js` ignores `reference/**`, a vendored clone of an unrelated
  project. It was producing 339 of the 339 lint errors — a gate that noisy stops
  being run.

### Fixed

Eight of these were found by tests written in this release, and each one is
recorded with how it was found, because the finding is the useful part.

- **The server was a 500 against Postgres, on every route.** `runTurn` created a
  conversation before ensuring the user row existed, and `/api/preferences`,
  `/api/feedback` and the memory-event writes each inserted before their user
  existed too — all against `REFERENCES users(id)`. The in-memory store enforces
  no foreign keys, so 349 offline tests were green while `POST /api/chat` failed
  immediately against the real database. Caught by starting the server and
  sending it a message, which is the only thing that could have caught it.

  Fixed in two places, at the two levels the mistake can be made: `runTurn`
  ensures the user before it writes anything, and the HTTP layer resolves
  identity through one `identify()` helper that ensures the row — so a route is
  safe by default rather than safe by review. Two Postgres tests now pin it, one
  asserting the foreign key rejects an unknown user and one driving a real turn
  through `runTurn` with a fake runner.
- **Four real gaps in crisis detection** (`src/safety/risk.ts`), each found by a
  test written against how people actually write:
  - `我觉得活着没什么意思了` — the softener sits *between* `没` and `意思`; the
    pattern required it to be absent.
  - `我昨晚割了自己一下` — requiring the object to be a body part (`割腕`)
    missed the sentence that matters most.
  - `I keep thinking about killing myself` — only the bare `kill myself` matched.
  - `他在家里打我` — reporting abuse is rarely phrased in the passive, and `被打`
    is not in the sentence.
- **Hedged self-diagnosis slipped through the output check**
  (`src/safety/response.ts`). `你可能得了抑郁症` is both the commonest accidental
  diagnosis and the exact phrasing the directive forbids; the pattern only caught
  the unhedged form.
- **A soft-deleted memory stayed in the memory panel** — the person deleted it and
  it was still on screen. Caught by the API test.
- **`ensureConversation` returned a 500 for a stale or foreign conversation id.**
  A plain insert raised a duplicate-key error on an ordinary situation: a client
  holding an id from somewhere else. The turn now gets a fresh conversation
  rather than failing, and never silently inherits someone else's thread. Caught
  by the Postgres integration test.
- **`npm run eval` could not run at all.** The CLI never called
  `installProvider()`, so the SDK fell back to its own default provider, which
  wants an OpenAI key this runtime does not have. All 24 cases failed with
  "Missing credentials" — which reads like a bad key and is actually a missing
  line in an entry point.

### Architecture

- **Relevance is gated by `minSimilarity`, not `minScore`** (ADR 007). A score
  floor cannot express relevance: an important, recent memory with no topical
  connection still scores well, and it should. Overlap is a separate question
  from prominence, so it gets a separate control — switched on only for automatic
  injection, where nothing downstream can reject a bad match.
- **The two retrieval paths are deliberately different widths.**
  `AUTO_INJECT_BUDGET` (4 items / 900 chars / 2 per type / `minSimilarity` 0.06)
  versus `DEFAULT_BUDGET` (6 / 1600 / 4 / `null`). A companion that volunteers
  four loosely-related memories per turn is worse than one that volunteers none.
  The asymmetry is asserted by tests, including one proving the tool has **no**
  overlap gate.
- **Similarity is lexical, and scored with the overlap coefficient, not
  Jaccard.** CJK character bigrams, because Chinese is written without spaces.
  Jaccard divides by the union and therefore punishes a short query matching one
  clause of a long memory — the case that matters most.
- **A status multiplier sits outside the score sum** (1.0 active, 0.85
  unconfirmed), because it is a judgement about how much to trust the ranking,
  not another relevance term.
- **Crisis turns are buffered** (ADR 008). A rendered delta cannot be un-rendered,
  so the check has to happen before the first byte. The cost — a few seconds of
  lost streaming on a three-to-five sentence reply — is accepted knowingly.
- **Identity is an unguessable handle, not authentication** (ADR 009). An
  unrecognised identifier is *replaced* rather than trusted, because a
  client-chosen id (`X-User-Id: 1`) reads someone else's memories and that bug
  survives into production far more often than a missing login does.
- **Installing the model provider is a composition-root act**, now enforced:
  only `src/api/server.ts` and `src/evaluation/cli.ts` may call
  `installProvider()`, and both must. The guard has two halves because the
  failure mode is an omission, not an excess — deleting the call is exactly the
  bug that shipped.
- **`Store` is an interface in domain types**, so a behaviour proven against
  `InMemoryStore` is a statement about the application rather than about a mock.
  Only the SQL is untested by the behavioural suite, and `tests/db/postgres.test.ts`
  targets precisely that gap.
- **Tracing writes structured spans to the application log**, with tool arguments
  fingerprinted rather than logged — for this product, tool arguments *are*
  memory content, the most sensitive text in the system.

### Evaluation

**Live smoke verification — three tests, all passing** (`RUN_SMOKE=1 npm run smoke`):

- a single turn streams a reply and terminates cleanly;
- **the multi-turn input shape is accepted by the real endpoint.** Passing prior
  turns to the Responses API requires an asymmetry that no offline test can
  check: a user turn is a plain string, an assistant turn must carry `status` and
  its content as typed parts, and sending the wrong one is a 400 from the
  provider. The offline suite replaces the thing that would reject it, which is
  exactly how the 0.1.0 streaming bug stayed invisible;
- a full memory turn end to end — retrieval, the SDK tool loop, the output check
  and persistence — with the model calling `save_memory` unprompted and two run
  rows recorded.

**Baseline recorded** — `evaluation/recorded/54af13d10076-2026-09-28T15-05-03-692Z.json`:

```
evaluation live · prompt 54af13d10076 · deepseek-v4-pro
24/24 passed · mean score 0.945 · 0 violation(s)
```

All ten categories 100%. `memory-01/02/03` exercised `save_memory`,
`search_memory` and `update_memory`; the three safety cases were assessed
`crisis`, `crisis` and `elevated` respectively, and none was replaced by the
fallback — the model's own replies passed the check.

Two things this baseline does **not** say, recorded so it is not over-read:

1. **A passing baseline is not a good companion.** The checks are mechanical and
   deliberately shallow; they catch forbidden behaviours and missing required
   ones. Tone, timing and warmth are not measured by any of them.
2. **0.945 is not comparable across prompts.** Scores are relative to the
   checks, and the checks changed several times during this session — four of
   them because a test found a real detection gap. The number is a starting
   point for the next run, not a grade.

### Known Issues

- **No embedding provider, unchanged from 0.1.0.** Re-probed and still true:
  every `/v1/embeddings`-shaped path returns 404 and the model list contains no
  embedding model. Retrieval ranks on lexical overlap instead (ADR 004, 007).
  The similarity function is injected, so turning embeddings on later replaces
  one function.
- **The local identity is not authentication** (ADR 009). No password, no
  expiry, no signature; a copied cookie is the account. Acceptable only because
  no real data is behind it. Must be replaced before any deployment, with the
  cookie upgraded to `HttpOnly; Secure; SameSite=Lax`.
- **Evaluation runs accumulate throwaway users in a shared database.** Each of the
  24 cases gets its own user, conversation, messages and run rows, and nothing
  deletes them. Harmless at 24 rows a run against a development database, and
  wrong in a shared one. The fix is a retention sweep or a `--cleanup` flag; it
  has not been built.
- **Postgres integration tests self-skip without `DATABASE_URL`.** Deliberate —
  the suite must run with nothing installed — but it means CI is the only place
  that reliably exercises the SQL unless someone remembers the variable.
- **`InMemoryStore` enforces no foreign keys, and that hid a bug that hit every
  route.** The stand-in store is what makes 349 tests run with nothing
  installed, and it is also why none of them noticed `/api/chat` creating a
  conversation before its owner. Two Postgres tests now cover the gap, but the
  general shape of the risk remains: any constraint that lives in the schema
  rather than in the code is invisible to the offline suite. Deliberately not
  fixed by adding constraint-checking to the fake — a stand-in that reimplements
  the database is a second database, and it would be wrong differently.
- **Risk detection is pattern-based**, so it has both false negatives (phrasing
  nobody anticipated) and false positives. The idiom guard is the mitigation and
  it is tested, but the honest statement is that this is a heuristic and the
  fallback exists because the model's compliance cannot be assumed.
- **No prompt change without an evaluation run** (spec §20, anti-pattern 7) is a
  rule with no mechanical enforcement. `PROMPT_VERSION` makes a prompt change
  visible in the run history, which is not the same as preventing one.
- **`eslint` pinned to v9** — `@eslint/js@10` requires eslint 10. Unchanged.

---

## [0.1.0] — 2026-09-28

Phase 0 (reconnaissance) and Phase 1 (minimal agent) of
`docs/implementation-plan.md`. The repository was empty at the start of this
release: no existing stack was replaced, and everything here is new.

### Added

**Documentation and decision records**

- `CURRENT_STACK.md` — reconnaissance of the environment and the model endpoint.
- `docs/implementation-plan.md` — phased plan with verification gates.
- `docs/adr/` — Architecture Decision Records 001–006:
  - `001-single-agent.md` — one agent; Fi/Ne/Si/Te are heuristics, not agents.
  - `002-postgres-pgvector.md` — Postgres + pgvector via a pinned Docker image.
  - `003-memory-model.md` — four-layer memory; three persisted layers share one
    discriminated table carrying `confidence` / `source` governance columns.
  - `004-context-retrieval.md` — scored, budgeted retrieval; embeddings deferred
    behind an injected similarity term, with the vector column created up front.
  - `005-agent-runtime.md` — OpenAI Agents SDK over DeepSeek's OpenAI-compatible
    surface; includes the correction of an earlier wrong conclusion.
  - `006-client-server-separation.md` — core emits `AsyncIterable<AgentEvent>`;
    `src/api/` is the only HTTP-aware layer, so a future mini-program client is
    an adapter rather than a rewrite.

**Phase 1 — minimal agent**

- `src/config.ts` — canonical model IDs, endpoint, and API-key resolution.
- `src/agent/events.ts` — the `AgentEvent` contract between core and clients.
- `src/agent/behavioral-policy.ts` — the interaction principles and function
  heuristics as **data**, so they are testable rather than prompt-only prose.
- `src/agent/instructions.ts` — the spec §11 system prompt, composed from modular
  sections and rendering the policy above.
- `src/agent/model-client.ts` — the only module that constructs a provider.
- `src/agent/infp-agent.ts` — the single agent and its event-stream translation.
- `src/observability/logging.ts` — structured logs that never carry user content.
- `src/observability/tracing.ts` — a custom trace processor replacing the SDK's
  OpenAI-hosted exporter, which cannot authenticate here.
- `src/api/sse.ts`, `src/api/server.ts` — the SSE transport and HTTP server.
- `web/index.html` — a minimal web client that streams replies.
- Test suite: 35 offline tests plus one live smoke test behind `RUN_SMOKE=1`.

### Fixed

- **Corrected a wrong conclusion about the model endpoint.** An earlier revision
  of `CURRENT_STACK.md` and ADR 005 recorded that `POST /v1/chat/completions`
  returned 404 and that the OpenAI Agents SDK was therefore unusable. **That was
  wrong.** The 404s came from a transient window (in which `GET /v1/models` also
  404'd), compounded by reading a bad-model-name error as a missing route.
  Re-probed and verified: chat completions, the Responses API, tool calling on
  both, streaming, and 8/8 stability. The decision built on the wrong conclusion
  was retracted and rewritten.
- **Fixed streaming emitting zero deltas.** The SDK *normalises* the provider's
  `response.output_text.delta` to `output_text_delta` and nests the original
  under `providerData`. Matching only the wire name produced a reply that
  completed correctly but streamed nothing — invisible to every test that did not
  call live. Both names are now accepted, and
  `tests/agent/stream-events.test.ts` pins it.
- **Fixed a race reading the final output.** The stream iterator can finish
  before the run is marked complete, so `finalOutput` was read too early,
  emitting an SDK warning and risking a partial value. `await result.completed`
  now precedes the read.

### Architecture

- **Reconnaissance established the project is greenfield.** No `package.json`,
  no git repository, no existing agent/backend/database code. Nothing was
  replaced; the stack was chosen from scratch against the spec's recommendations.
- **Spec §8's SDK recommendation is satisfiable as written.** The OpenAI Agents
  SDK drives DeepSeek directly via `AsyncOpenAI({ baseURL })`, using the
  Responses API, which DeepSeek implements natively — so the SDK's default model
  path works and no chat-completions adapter is needed. Model provider and agent
  harness are decoupled behind a single provider module.
- **Model namespace is only two IDs, and aliases resolve silently.**
  `deepseek-flash` and `deepseek-v4-pro` are the only real models;
  `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash` all resolve to
  `deepseek-flash` without error. A misconfigured name would run the wrong model
  silently rather than fail, so only canonical IDs may appear in code, enforced
  by `tests/architecture/model-ids.test.ts`.
- **Tracing required deliberate configuration.** The SDK exports traces to an
  OpenAI-hosted backend by default; that exporter cannot authenticate here. A
  custom processor writes structured spans instead, and fingerprint tool
  arguments rather than logging them.
- **Client/server separation adopted ahead of a planned mini-program migration.**
  The product ships on web first and will move to a WeChat mini-program later.
  Research confirmed the SSE wire format **is** portable there via
  `wx.request({ enableChunked })` + `onChunkReceived` with a hand-written frame
  parser — there is no native `EventSource`, but chunked streaming works, so
  WebSocket is not required. The boundary is enforced by
  `tests/architecture/boundaries.test.ts`.
- **The "only one module imports the vendor SDK" claim was narrowed after the
  boundary test disproved it.** The agent module and the tracing processor
  necessarily use SDK primitives; abstracting those away would mean
  reimplementing the SDK. The invariant that is both true and worth protecting
  is that the **product-logic layers** (`memory`, `tools`, `safety`,
  `evaluation`) and the **transport layer** (`api`) never import it.
- **Clients parse SSE frames by hand rather than using `EventSource`.**
  `EventSource` only issues GET, and the chat endpoint is POST — correctly so,
  because putting a user's message in a URL would leak it into access logs and
  browser history. Reading the response body as a stream is also what the
  mini-program client must do, so the logic transfers.
- **Deployment requirement recorded:** SSE must not be buffered. Without
  `proxy_buffering off` / `X-Accel-Buffering: no`, no compression, HTTP/1.1, and
  a long read timeout, streaming silently degrades to a single response. This
  will not surface in local development.

### Evaluation

- No evaluation framework yet. To be introduced in Phase 3, per the plan. The
  live smoke test asserts only mechanical properties (the stream produces text
  and terminates) and deliberately does **not** score reply quality — an
  assertion about tone at this stage would be a guess dressed as a test.

### Known Issues

- **Phase 1 is single-turn.** No conversation history is kept, so the agent
  cannot refer to the previous message in the same session. This is deliberate:
  history belongs with the `conversations` / `messages` tables in Phase 2, and
  building it earlier would mean building it twice.
- **No memory tools exist yet.** `search_memory` / `save_memory` /
  `update_memory` (spec §9) are Phase 2. The system prompt already describes the
  memory rules, but there is nothing for the agent to call.
- **No guardrails yet.** The safety *rules* are in the prompt, but spec §10's
  input/output guardrails are Phase 4. Nothing currently enforces the safety
  rules mechanically; they rely on the model following instructions.
- **No PostgreSQL server, and the Docker daemon is not running.** Only the
  `libpq` client (17.6) is installed. This blocks Phase 2 provisioning. See
  ADR 002.
- **No embedding provider available.** Established with a control probe: 12/12
  requests across `/v1/embeddings`, `/embeddings`, `/v1/embed`, and
  `/beta/embeddings` returned 404 while a control request of identical shape to a
  known-good route returned 200 — the failure is route-specific, not flakiness.
  The model list contains exactly two models, neither an embedding model. See
  ADR 004.
- **No git identity configured.** `user.name` and `user.email` are unset both
  globally and in the repository, so commits cannot be authored yet.
- **`eslint` pinned to v9.** `@eslint/js@10` requires eslint 10; `@eslint/js` is
  pinned to `^9` to match. Revisit together when upgrading.
