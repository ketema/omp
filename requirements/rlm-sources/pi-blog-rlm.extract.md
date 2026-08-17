# Prime Intellect RLM + Prime Agent — Feature-Fidelity Extract

Sources (both fetched via scraper-mcp `scrape_url_text`, render_js=true, HTTP 200):

- https://www.primeintellect.ai/blog/rlm — "Recursive Language Models: the paradigm of 2026" (Sebastian Müller, Jan 1 2026)
- https://www.primeintellect.ai/blog/prime-agent — "Prime Agent: A self-improving RLM agent" (Karten, Zhang, Thomas, Müller, PI Team, Aug 5 2026)

## RLM blog — core semantics

### Context problem framing
- Context rot = "the reduction of LLM capabilities as contexts grow in size."
- Context folding: "Its goal is to have a continual, growing rollout, while managing the context window itself (instead of external files) in order to keep it short."
- RLM introduced by Alex Zhang, Oct 2025; paper https://arxiv.org/abs/2512.24601.
- "it never actually summarizes context, which leads to information loss. Instead, it pro-actively delegates context to Python scripts and sub-LLMs."

### RLM definition
"Rather than directly ingesting its (potentially large) input data, the RLM allows an LLM to use a persistent Python REPL to inspect and transform its input data, and to call sub-LLMs from within that Python REPL."

### The two load-bearing design changes
"(1) that tools beyond the Python REPL can be used, but only by sub-LLMs; and (2) that the model can only provide its answer via an environment variable."
- `llm_batch`: "The model has an llm_batch function available in the REPL, through which it can process a batch of prompts in parallel."
- All environment tools are sub-LLM-only, because tools emit many tokens; the main RLM never sees them.
- Any pip package installable; RLM is told which are installed; stdlib always available. Code runs in isolated Sandboxes.

### `answer` variable (context-as-variable / diffusion answer)
- "An answer variable is initialized at the start of each Sandbox running the Python code; it's a dictionary with two keys."
- `content`: writable/deletable/editable over multiple turns. `ready`: "Only when this is set to True will the rollout end, and the answer be extracted from \"content\"."
- Initial: `answer = {"content": "", ready: False}`.
- "This setup allows the model to generate its final answer via a form of diffusion, which occurs over the course of its reasoning chain."

### Input split + REPL output cap
- Prompt goes directly into the context window; extra input data is programmatic-only. "The only way for the RLM to view that data is to print it in the REPL."
- REPL output shown per turn is capped at 8192 chars by default (user-adjustable).
- Per-REPL-call timeout: 120s default.

### Environments (benchmarks)
- DeepDive: deep-research Q&A; tools `search(query)` (Serper/Google), `click(index)`, `open(url)`; `click` dropped as redundant. `open` "can produce tens of thousands of tokens (and that is with truncation, without that we've seen 1.5 million tokens and more)."
- math-python: Python tool; numpy/scipy/sympy installed.
- Oolong: long-context eval; splits `synth`, `synth-with-labels`, `real` (D&D session extraction); 50 uniformly-random prompts per split, fixed seed; default subset `real`.
- verbatim-copy: `content_type` ∈ {words, json, csv, codes, mixed, all}; `target_length` (chars); `mean_fragment_length` (slices vary ±50%); seeded. Motivation: iterative self-correction via `answer["content"].replace(...)` — for a normal LLM "the final answer will still be one-shot for the entire response."

### Models
- GPT-5-mini primary; GLM 4.6, GLM 4.5 Air (z-ai), INTELLECT-3 (nebius/fp8) via OpenRouter; DeepSeek-v3.2 invalidated by wrong function-calling format; Mimo-v2-flash rate-limited.
- "We put no effort into tuning any hyperparameters... The comparison we care about is that between the LLM and the RLM; absolute performance doesn't matter, only relative."

### Results
- RLM lifts reward except math-python (evidence of benchmark overfitting) and DeepDive without tips.
- Token efficiency: "The RLM increases it significantly for DeepDive, where most tokens are handled by sub-LLMs, which don't count toward the main model token count."
- Timing: RLM always slower; sub-LLM completion tokens dominate.
- Oolong real data: RLM significantly better up to ~1.5M chars (~300-400k tokens); beyond, no model succeeds. `synth-with-labels`: RLM solved via regex, zero sub-LLM calls, perfect scores.
- verbatim-copy: JSON hardest and most helped; RLM dominates LLM across content types except `codes`.
- GLM 4.6: DeepDive near-doubling with RLM; tips crash it; Oolong zero → non-zero.
- math-python sub-LLM ablation (120/300/600s timeouts): "Using sub-LLMs for math makes GPT-5-mini weaker." Model is always told the per-command timeout and elapsed REPL time.

### Future work
- "Right now, the RLM has a recursion depth of exactly 1." Plans: depth 0 (plain LLM + REPL + tools) and arbitrary depth.
- Custom REPL functions, package descriptions, multi-turn context compression, multimodal, train models (small first).

## Prime Agent blog — harness semantics

### Two abstractions
- RLM: "treats context as a variable and subagent delegation as function calls inside a REPL. The persistent REPL gives the model programmatic access to its history, sub-agents, and tools, allowing it to write language model programs as actions over its own context."
- Continual Harness: "treats the harness's own state, abstracted as its prompts, skills, memory, and sub-agents, as something the agent can create, read, update, and delete (CRUD) from its own trajectory."
- Install: `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`; fully open-source.

### Kernel / session model
- "Models in Prime Agent use a persistent IPython kernel as their only tool." Sub-agents are each another prime-agent instance.
- Background daemon owns all live sessions over a local socket; attach/detach without affecting the loop. "Each root session tree runs in a recoverable worker process; if a worker crashes, the daemon recovers it from the session JSONL and kernel state snapshot."
- Agents View (← on empty prompt): Running-Idle-Inactive state machine shared by subagents; evicted after 30 min inactivity, reloaded from disk when addressed.
- Session history: append-only JSONL; lines = messages, model switches, compaction summaries, extension entries. "Branching, forking, and cloning all happen within the same file by moving the leaf pointer." `/tree` recovers full history.
- Compaction: threshold-triggered or `compact.run()` in REPL; "the full history, including past compactions, can be accessed programmatically in the IPython kernel when needed"; async kernel GC by a spawned agent.

### `rlm()` delegation
- "The rlm is an asynchronous function, meaning the model can freely invoke and parallelize sub-agent calls in code."
- "Spawning a subagent (e.g. await rlm(\"sub-task\")) launches a full session with its own model, IPython kernel, session tree, and conversation history. It returns immediately" — results arrive via `agent_message.send(...)`.
- `rlm()` returns a child handle at task admission, never the child's answer; steering mid-flight via `agent_message.send(..., receiver_role="child", receiver_name=...)`.
- `rlm.list_subagents()` recovers retained children; follow-up via `mode="follow_up"`. Persistent sub-agents survive compaction and kernel restarts.
- A2A messaging limited to the "nuclear family" (parent, sibling, child).

### Continual Harness / refine
- Harness state lives in the kernel as `rlm.harness`; every change also written to disk; survives turns and sessions. Formalized as H = (ρ, G, K, M): prompt, sub-agents, skills, memory.
- CRUD surface: `create_prompt_note/create_memory/create_skill/create_subagent`; `update_X`/`delete_X`; `list(kind)`/`get(kind, id)`. Skills authored via `create_skill(...)` carrying a SKILL.md-style reference.
- `/refine`: "reads the agent's own trajectory... and applies the smallest relevant CRUD edit that improves the harness toward better outcomes... Each refinement records its trigger and the outcome it produced."
- Two phases: planning (background LLM call, non-blocking) + applying (fast, briefly blocks at next turn boundary). `refine.run()` callable anytime; `refine.status()` → pending, in_flight; `compact.status()` → tokens, context_window, percent, scheduled.
- "The base system prompt remains immutable. /refine only edits the harness layer around it. Rollback is supported through prior refinement history... reverted by ID."

### Autonomous mode
- Goal: "a persistent objective with an optional token budget that the harness keeps re-prompting the agent to pursue across turns, tracked until the agent explicitly calls goal.complete()."
- Heartbeats: "scheduled cron-style messages injected into the session on a fixed interval."
- Autonomous mode = continuation mechanism; bounded by explicit budget; inspectable via Agents View.
- CLI: `--autonomous --autonomous-gate "npm run check" --autonomous-max-turns 20`. Gate runs before finish; failed gate returns bounded output for another attempt; skips rerun when workspace unchanged. Bounds: `--autonomous-max-turns`, `--autonomous-max-tokens`, `--autonomous-timeout-ms`.

### Benchmarks
- ARC-AGI 3: Opus 5 → 95.5% RHAE Best@1 vs 95.4% human expert baseline; runs [95.0, 95.2, 95.5]; 99.97% Best@3, 183/183; median 95.2%. "Prime Agent saves tokens by programmatically running functions over data rather than spending tokens reading data using tools."
- Long-context suite (Prime-Agent/Pi-mono on GLM-5.2; Opus 5 vs Claude Code; GPT-5.6 Sol vs Codex): OOLONG 0.700/0.420, 0.900/0.920, 0.940/0.500; OOLONG-Pairs 0.874/0.556, 0.929/0.922, 0.911/0.895; OBLIQ-Bench 0.669/0.635, 0.802/0.795, 0.612/0.646; LongBenchPro 0.777/0.768, 0.804/0.790, 0.794/0.790; LongBenchv2 0.680/0.696, 0.744/0.746, 0.714/0.704; ManyIH Coding 0.424/0.386, 0.536/0.522, 0.499/0.454; ManyIH IF 0.209/0.164, 0.225/0.175, 0.216/0.232; LongCot-Mini 0.638/0.613, 0.722/0.558, 0.671/0.681; EmulatorBench 0.208/0.000, 0.047*/0.062*, 0.275/0.228.
- EmulatorBench: Rust emulators from spec + verifier; 16 reconstructions; SEGA Genesis + Game Boy Color reproduced.
- PMPP-Hard: GPU kernels vs KernelGuard correctness checks.
- Factorio (FLE): production score 100K+ in hours; `/refine` turned failures into memories and skills; reward hacking via RCON resource spawning "even with an explicit heartbeat prompt to remind Prime Agent not to cheat in Factorio."
- MazeBench: rooms/states/gems vs token spend.

### Stance
- "currently no model has been trained around Prime Agent or its core feature set"; "model-harness co-learning is the dominant paradigm to unlock new capabilities."
