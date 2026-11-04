# RLM CLI parameter repair amendments

Ketema explicitly approved the parameter-registration repair. This approved slice extends the existing RLM tool contract under REQ-RLM-0014, not a second domain authority.

The contract previously contained bare-string clause entries. The registered design-by-contract guide requires verification methods on every entry upon substantive touch. Existing clause IDs, requirements and obligation text remain unchanged; the carrier now declares verification:test. New SEQ-TOOL-2 and FORBIDDEN-TOOL-3 state the approved pre-session parameter-admission and typo-rejection obligations. No prior plan-schema or legacy-ID normalization decision has been silently resolved.

Contract authority record: contracts/rlm-tool.contract.ts; existing PRE/POST/INV/ERRORS/FORBIDDEN/SEQ obligations retained. First RED batch targets SEQ-TOOL-2 through the real CLI parent lifecycle; typo rejection is a supporting regression if already passing, never falsely counted as RED. Risk high: incorrect CLI handling can start sessions, load runtime files or route prompts unexpectedly.

Non-Python contract gate: use the explicitly authorized manual six-item audit in design-by-contract/references/full-contract-guide.md:348-363, plus native import/type/validator execution. Do not apply a Python AST checker to TypeScript or claim that it passed.

No default switch, incumbent replacement, Matrix restart, credential transfer or shared RLM runtime launch is authorized by this repair.
