# Fork rules (ketema/omp)

This repo is a fork of can1357/oh-my-pi. `requirements/FORK_CUSTOMIZATIONS.md` lists every customization that must survive an upstream merge and be in the deployed build.

- A PR that adds or changes fork behavior MUST add or update its row in that file in the same PR, or say `Registry: none, <reason>` in its description.
- Before any build that will be deployed, compare the PRs merged since the last reconcile with the registry and add missing rows first. Then follow `skill://omp-fork-build-deploy`.
- NEVER say customizations are preserved or deployed without the output of `sh scripts/verify-fork-customizations.sh --binary <the binary>` for that build.
- A row the script does not check is not covered by a passing run. Say so, and run that row's "verify by" by hand.
