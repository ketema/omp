# REQ-2026-OMP-SSH-ASKPASS-RESTORATION: Restore Native FIDO Notification

**Status**: Draft
**Scope**: Restore OMP's dropped askpass resolver and configure the macOS LaunchAgent to select the existing Yubi Askpass helper.

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

## Actors

| Actor | Identifier |
|---|---|
| OMP Bash Environment Builder | `buildNonInteractiveEnv` |
| OMP Git Environment Builder | `buildGitEnv` |
| macOS LaunchAgent | `local.ssh-askpass-env` |
| OpenSSH | `/opt/homebrew/bin/ssh` |
| Yubi Askpass | `$HOME/bin/yubi-askpass` |
| Git | Git SSH transport |
| Operator | YubiKey holder |

## 1. Intent Traceability

- **Source Prose**:
  > "restore to omp source but re-order the beep. make it before the gui pop and/or notification"
  > "Set launchd to Yubi helper"
  > "it should only prompt for a touch when the hardware key is requested. period for any host. if a different key is used i should not be prompted to touch the yubikey"

- **Our Understanding**: Commit `c430acd792` resolved OMP's non-interactive `/usr/bin/false` askpass override. Upstream merge `312b41bf54` removed that resolver. Restore the general parent-environment resolver in OMP source, configure the machine's LaunchAgent to export Yubi Askpass, and preserve OpenSSH's native identity-aware `SSH_ASKPASS_PROMPT=none` notification boundary.

- **Ambiguity Score**: 0

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| OMP Bash Environment Builder | Constructs non-interactive child environment | OMP Bash Environment Builder SHALL NOT force `SSH_ASKPASS=/usr/bin/false` when a valid parent helper exists. |
| OMP Git Environment Builder | Constructs internal Git and GitHub-client environment | OMP Git Environment Builder SHALL NOT replace a resolved valid askpass helper with `/usr/bin/false`. |
| macOS LaunchAgent | Sets GUI-domain askpass environment before OMP starts | macOS LaunchAgent SHALL NOT export a helper other than Yubi Askpass for this workstation. |
| OpenSSH | Selects normal-order identities and starts native notification mode | OpenSSH SHALL NOT invoke native notification mode for a non-FIDO identity. |
| Yubi Askpass | Starts cue or PIN UI based on `SSH_ASKPASS_PROMPT` | Yubi Askpass SHALL NOT display secret material, hostname, or key fingerprint in native notification mode. |
| Git | Starts SSH transport | Git SHALL NOT receive a wrapper or `core.sshCommand` override. |
| Operator | Touches YubiKey after the cue | Operator SHALL NOT provide a secret to the environment builders. |

## 3. The State Transition

- **Initial State ($S_0$)**: OMP Bash and internal Git builders pin `SSH_ASKPASS=/usr/bin/false`. A valid GUI-domain helper cannot reach OpenSSH.
- **Transformation**: macOS LaunchAgent exports `$HOME/bin/yubi-askpass`, `SSH_ASKPASS_REQUIRE=force`, and `DISPLAY=ssh-askpass`. OMP source resolves an executable parent helper before known generic helpers and retains the resolved value in Bash and internal Git environments.
- **Terminal State ($S_1$)**: OMP child processes receive Yubi Askpass. When OpenSSH selects a FIDO security-key identity requiring user presence, OpenSSH asynchronously starts Yubi Askpass in native notification mode before the hardware assertion. Yubi Askpass starts the audible cue before its generic visual notification or later PIN UI.

## 3.5 Integration Specification

### Dependency Graph

OMP Bash Environment Builder DEPENDS ON the macOS LaunchAgent environment for Yubi Askpass selection.

OMP Git Environment Builder DEPENDS ON the shared askpass resolver for the same selected helper.

OpenSSH DEPENDS ON Yubi Askpass only after selecting a FIDO identity requiring user presence.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-AR-1 | macOS LaunchAgent | Yubi Askpass environment export | Before OMP process launch | OMP resolver selects a generic or failing helper. |
| SEQ-AR-2 | OMP Bash Environment Builder | shared askpass resolver | Before Bash child launch | Bash child retains `/usr/bin/false`. |
| SEQ-AR-3 | OMP Git Environment Builder | shared askpass resolver | Before internal Git child launch | Internal Git retains `/usr/bin/false`. |
| SEQ-AR-4 | OpenSSH | Yubi Askpass native notification mode | After selected FIDO identity and before hardware assertion | Operator receives no pre-touch cue. |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-AR-1 | macOS LaunchAgent | OMP process | `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `DISPLAY` | SEQ-AR-1 |
| IP-AR-2 | OMP Bash Environment Builder | Bash child | Resolved askpass environment | SEQ-AR-2 |
| IP-AR-3 | OMP Git Environment Builder | Git child | Resolved askpass environment | SEQ-AR-3 |
| IP-AR-4 | OpenSSH | Yubi Askpass | `SSH_ASKPASS_PROMPT=none` and native notification prompt | SEQ-AR-4 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| macOS LaunchAgent environment | launchd starts `local.ssh-askpass-env` | launchd owns lifecycle |
| OMP resolver | OMP starts Bash or internal Git command | Child environment expires with command |
| Native notification process | OpenSSH selects FIDO user-presence key | OpenSSH ends notification after signature completion |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| REQ-AR-001 | Resolver | OMP Bash Environment Builder SHALL prefer an executable parent `SSH_ASKPASS` over generic helper fallbacks. |
| REQ-AR-002 | Resolver | OMP Git Environment Builder SHALL retain the resolved executable `SSH_ASKPASS` value. |
| REQ-AR-003 | LaunchAgent | macOS LaunchAgent SHALL export `$HOME/bin/yubi-askpass` as `SSH_ASKPASS`. |
| REQ-AR-004 | Environment | macOS LaunchAgent SHALL export `SSH_ASKPASS_REQUIRE=force` and `DISPLAY=ssh-askpass`. |
| REQ-AR-005 | FIDO lifecycle | OpenSSH SHALL preserve normal identity order. |
| REQ-AR-010 | FIDO lifecycle | OpenSSH SHALL select whether a FIDO notification applies. |
| REQ-AR-006 | Notification | Yubi Askpass SHALL start the audible cue before a generic visual notification or PIN UI. |
| REQ-AR-007 | Non-FIDO suppression | OpenSSH SHALL NOT invoke native notification mode for a non-FIDO identity. |
| REQ-AR-008 | Security | Yubi Askpass SHALL NOT emit a hostname, key fingerprint, private-key material, PIN, passphrase, or secret in native notification mode. |
| REQ-AR-009 | Architecture | OMP source SHALL NOT add an SSH wrapper, Git hook, `core.sshCommand` override, key-cycling logic, or custom security-key provider. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Remediation boundary | Where does the dropped resolver return? | Restore it in OMP source. | User |
| Askpass authority | Which helper does the machine provide to OMP? | macOS LaunchAgent exports Yubi Askpass. | User |
| Cue ordering | What occurs before visual user feedback? | The audible cue starts before generic visual notification or PIN UI. | User |
| Identity selection | How are identities evaluated? | OpenSSH uses normal identity order. | User |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|----------|----------------------|--------------|------------|
| OMP source restoration | External OMP Bash hook | It duplicates an OMP behavior that existed before the upgrade. | User |
| LaunchAgent Yubi Askpass | Personal path priority embedded in OMP source | Machine-specific helper selection belongs in machine configuration. | User |
| Native OpenSSH notification | Custom Git SSH wrapper | OpenSSH provides the correct identity-aware lifecycle. | User |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|----------------|
| macOS LaunchAgent | Supplies GUI-domain askpass environment | YES | launchd | User GUI session starts |
| OMP askpass resolver | Chooses valid helper for child environments | NO | OMP environment builders | Bash or internal Git starts |
| OpenSSH `notify_start` | Starts native askpass notification mode | NO | OpenSSH | Selected FIDO key needs user presence |
| Yubi Askpass | Starts generic cue or PIN UI | NO | OpenSSH | Native notification mode or PIN request |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|--------------|
| REQ-AR-003 | Yubi Askpass is missing or not executable | macOS LaunchAgent SHALL exit nonzero without publishing a false helper path. | macOS LaunchAgent SHALL identify the helper path in stderr. |
| REQ-AR-001 | Parent helper is `/usr/bin/false` or not executable | OMP resolver SHALL continue to a known executable fallback. | OMP resolver SHALL not claim Yubi Askpass selection. |
| REQ-AR-006 | Audible cue cannot start | Yubi Askpass SHALL exit nonzero before visual UI. | Yubi Askpass SHALL emit an actionable local error without secret material. |

## 8. Completion Promise (Ralph Loop Exit)

A real OMP Git SSH transport preserves normal OpenSSH key order, starts the generic audible YubiKey cue before user-visible UI when OpenSSH selects a FIDO key, and completes a non-FIDO key path without a YubiKey cue.

## 9. Contract Authority

Authoritative Source: `requirements/contracts/omp_ssh_askpass_restoration.contract.ts`

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-08-25 | K. Harris | Restored source-level askpass requirements from c430acd792 provenance and current user decisions. |
