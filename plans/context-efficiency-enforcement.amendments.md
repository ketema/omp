# Amendment ledger: context-efficiency-enforcement

| Date | Clause | Requirement IDs | Kind | Rationale | Decided By |
|------|--------|-----------------|------|-----------|------------|
| 2026-11-05 | SEQ-CTX27-5 | REQ-CTX27-08, REQ-CTX27-09 | Removed (not thin) | Replaced by FORBIDDEN-CTX27-2: the extension is unmounted in every session (Z10, REQ-CTX27-17). In session 01a1aba2 the mounted extension hid 22 tool results and skill files. | User (Ketema): "Unmount the context efficiency extension" |
| 2026-11-05 | POST-CTX27-7 | REQ-CTX27-08, REQ-CTX27-09 | Removed (not thin) | It guaranteed catalog cards in the live prompt through the mounted extension, which is now unmounted (Z10). Item 4 of the fix list replaces it. | User (Ketema), same decision |
| 2026-11-05 | SEQ-CTX27-6, POST-CTX27-8, POST-CTX27-9, ERRORS-CTX27-3, FORBIDDEN-CTX27-2 | REQ-CTX27-16, REQ-CTX27-17, REQ-CTX27-18 | Added | Item 1a: helpers load at kernel start with one notice; extension unmounted. | User (Ketema): "Plan approved. Go." |
| 2026-11-05 | POST-CTX27-9, ERRORS-CTX27-3 | REQ-CTX27-16, REQ-CTX27-18, REQ-CTX27-19 | Amended (not thin) | Ketema changed REQ-CTX27-18: the workbench load is announced by one developer-role message through omp's message bus, delivered with the next user message, instead of a line in the first ipython result. The message ends with the context efficiency rules (Z11, draft wording in the contract). | User (Ketema): "modify the requirement then proceed" |
| 2026-11-05 | POST-CTX27-10, POST-CTX27-11 | REQ-CTX27-20, REQ-CTX27-21, REQ-CTX27-22 | Added | No repeat and no tool-result notice; the kernel starts at launch in top-level sessions, so the message exists before the first user message. | User (Ketema), same decision |
