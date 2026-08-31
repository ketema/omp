/** Independent behavioral specification for OMP native SSH askpass restoration. */

export const DISABLED_ASKPASS_PATH = "/usr/bin/false" as const;
export const YUBI_ASKPASS_PATH = "$HOME/bin/yubi-askpass" as const;
export const SSH_ASKPASS_REQUIRE_VALUE = "force" as const;
export const SSH_ASKPASS_DISPLAY_VALUE = "ssh-askpass" as const;

export type VerificationMethod = "test" | "execution" | "tool";
export type AskpassSource = "parent" | "fallback" | "disabled";

export interface Clause {
	readonly verification: VerificationMethod;
	readonly text: string;
}

export interface AskpassCandidate {
	readonly path: string;
	readonly executable: boolean;
}

export interface AskpassResolutionInput {
	readonly parent: AskpassCandidate | undefined;
	readonly fallbacks: readonly AskpassCandidate[];
}

export interface AskpassResolution {
	readonly path: string;
	readonly source: AskpassSource;
}

export interface NativeAskpassEnvironment {
	readonly SSH_ASKPASS: string;
	readonly SSH_ASKPASS_REQUIRE: typeof SSH_ASKPASS_REQUIRE_VALUE;
	readonly DISPLAY: typeof SSH_ASKPASS_DISPLAY_VALUE;
}

export class OmpAskpassRestorationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OmpAskpassRestorationError";
	}
}

export class InvalidAskpassCandidateError extends OmpAskpassRestorationError {
	constructor(message: string) {
		super(`PRE-AR-1 violation: ${message}`);
		this.name = "InvalidAskpassCandidateError";
	}
}

export class MissingYubiAskpassError extends OmpAskpassRestorationError {
	constructor() {
		super(
			"ERRORS-AR-1 violation: $HOME/bin/yubi-askpass is absent or not executable.",
		);
		this.name = "MissingYubiAskpassError";
	}
}

export const NATIVE_ASKPASS_ENVIRONMENT = (path: string): NativeAskpassEnvironment =>
	Object.freeze({
		SSH_ASKPASS: path,
		SSH_ASKPASS_REQUIRE: SSH_ASKPASS_REQUIRE_VALUE,
		DISPLAY: SSH_ASKPASS_DISPLAY_VALUE,
	});

function isUsableCandidate(candidate: AskpassCandidate | undefined): candidate is AskpassCandidate {
	return (
		candidate !== undefined &&
		candidate.path.trim().length > 0 &&
		candidate.path !== DISABLED_ASKPASS_PATH &&
		candidate.path !== "false" &&
		candidate.path !== "true" &&
		candidate.executable
	);
}

export function validateAskpassResolution(input: AskpassResolutionInput): AskpassResolution {
	if (
		input.parent !== undefined &&
		(input.parent.path.trim().length === 0 || typeof input.parent.executable !== "boolean")
	) {
		throw new InvalidAskpassCandidateError("parent candidate must have a non-empty path and executable flag.");
	}
	for (const fallback of input.fallbacks) {
		if (fallback.path.trim().length === 0 || typeof fallback.executable !== "boolean") {
			throw new InvalidAskpassCandidateError("fallback candidate must have a non-empty path and executable flag.");
		}
	}
	if (isUsableCandidate(input.parent)) {
		return Object.freeze({ path: input.parent.path, source: "parent" });
	}
	const fallback = input.fallbacks.find(isUsableCandidate);
	if (fallback !== undefined) {
		return Object.freeze({ path: fallback.path, source: "fallback" });
	}
	return Object.freeze({ path: DISABLED_ASKPASS_PATH, source: "disabled" });
}

export const CONTRACT_OMP_SSH_ASKPASS_RESTORATION: Readonly<Record<string, Clause>> =
	Object.freeze({
		"PRE-AR-1": {
			verification: "test",
			text: "Resolver candidates carry a non-empty path and boolean executable status.",
		},
		"POST-AR-1": {
			verification: "test",
			text: "Resolver chooses an executable parent SSH_ASKPASS before generic executable fallbacks.",
		},
		"POST-AR-2": {
			verification: "test",
			text: "OMP Bash environment retains the resolved askpass path and sets SSH_ASKPASS_REQUIRE=force plus DISPLAY=ssh-askpass.",
		},
		"POST-AR-3": {
			verification: "test",
			text: "OMP internal Git environment retains the same resolved askpass path and native askpass environment values.",
		},
		"POST-AR-4": {
			verification: "execution",
			text: "Native OpenSSH starts Yubi Askpass with SSH_ASKPASS_PROMPT=none before a selected FIDO user-presence assertion.",
		},
		"SEQ-AR-1": {
			verification: "execution",
			text: "The macOS LaunchAgent exports Yubi Askpass before OMP starts.",
		},
		"SEQ-AR-2": {
			verification: "test",
			text: "OMP Bash environment construction invokes the shared resolver before spawning a Bash child.",
		},
		"SEQ-AR-3": {
			verification: "test",
			text: "OMP internal Git environment construction invokes the shared resolver before spawning a Git child.",
		},
		"SEQ-AR-4": {
			verification: "execution",
			text: "Yubi Askpass starts its audible cue before its generic visual notification or PIN UI.",
		},
		"ERRORS-AR-1": {
			verification: "test",
			text: "A missing or non-executable configured Yubi Askpass raises MissingYubiAskpassError during LaunchAgent validation.",
		},
		"ERRORS-AR-2": {
			verification: "test",
			text: "An invalid resolver candidate raises InvalidAskpassCandidateError with its PRE-AR-1 clause identifier.",
		},
		"FORBIDDEN-AR-1": {
			verification: "test",
			text: "A valid parent askpass helper is not replaced by /usr/bin/false.",
		},
		"FORBIDDEN-AR-2": {
			verification: "test",
			text: "OMP source does not add an SSH wrapper, Git hook, core.sshCommand override, key-cycling logic, or custom security-key provider.",
		},
		"FORBIDDEN-AR-3": {
			verification: "execution",
			text: "Native notification mode emits only a generic cue and no hostname, key fingerprint, private-key material, PIN, passphrase, or secret.",
		},
	});
