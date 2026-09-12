# Make a local log-only node easy to deploy and run

This ExecPlan follows `PLANS.md`. **Status: proposed for review; no implementation is authorized by this plan-writing request.** After approval, implement one milestone at a time, report the diff and validation, and wait for agreement before proceeding. This preserves the user's requested small review increments.

## Purpose / Big Picture

An operator should be able to prepare a checkout, configure an Ethereum connection, deploy or reuse Logger, and run a log-only Oya node on their own computer through a small set of commands. A separate local agent can then send signed messages to `http://127.0.0.1:8787/v1/messages`. The node publishes the signed envelope to IPFS, submits its CID to Logger on the configured Ethereum chain, and returns `200` with the verified result.

“Local deployment” describes where the Oya process runs. Its Ethereum RPC endpoint may be local Anvil or an external Ethereum network. IPFS may likewise be a local Kubo service or a supplied compatible API. Running the Oya node locally must not silently select Anvil, start an Ethereum node, replace an IPFS repository, change chain ID, or generate a new signing account.

The proposed first version runs in the foreground: logs appear in the terminal, Ctrl-C stops admission and drains active work, and another terminal can query status or run an agent. This is the simpler option presented for user preference during planning and is the draft assumption pending review. Background process management can be scoped separately if preferred; this plan does not create a supervisor, PID registry, automatic restart loop, cloud deployment, container setup, or boot-time service.

Verification, Safe/Governor proposals, agent strategy implementation, and new kernel signing support are outside this plan. The current single-operation HTTP behavior and ethers signing adapter remain unchanged. Operational configuration and deployment receipts are retained; message progress is not journaled.

## Progress

- [x] 2026-09-11 00:07Z: Read root `AGENTS.md`, `PLANS.md`, relevant package/contract guidance, current runtime, smoke, client, and Logger deployment interfaces at commit `5817192`.
- [x] 2026-09-11 00:08Z: Inspected installed Node and Foundry CLI support without making network requests or deploying contracts. Confirmed Node's built-in environment parser is available and Foundry configuration accepts RPC URL/header overrides through `FOUNDRY_ETH_RPC_URL` and `FOUNDRY_ETH_RPC_HEADERS`.
- [x] 2026-09-11: Drafted the local operations workflow and three reviewable milestones. Dates in this plan are UTC; the user's local date is September 10.
- [ ] User reviews the plan, including the foreground workflow assumption.
- [ ] Milestone 1: Setup, configuration checks, foreground running, and status.
- [ ] Milestone 2: Explicit Logger deployment and reuse.
- [ ] Milestone 3: Local agent-to-node integration evidence and operator instructions.

## Surprises & Discoveries

- `node/production/src/main.mjs` already supports a supplied config file, chain and Logger bytecode checks, and SIGINT/SIGTERM draining. These are reusable runtime capabilities; a second server or shutdown implementation is unnecessary.
- `node/production/package.json` uses local `file:../../packages/...` dependencies. Setup must build the kernel packages and install the production package in the repository layout; copying only `node/production/` is insufficient.
- `scripts/smoke-local.mjs --keep-running` starts a complete disposable Anvil/Kubo/node demonstration. It generates accounts, deploys a fresh Logger, and uses temporary artifacts. It is a test fixture rather than the operating configuration for a durable node identity.
- The existing runtime deliberately has no publication journal, deduplication, or automatic restart recovery. A health result of `transaction_outcome_unknown` must not trigger a management-script restart that clears that flag.
- A local agent already has a usable wire protocol and example client in `node/production/scripts/send-message.mjs`. Receiving messages does not require an agent-specific package or reimbursement logic.
- Foundry's script path is relative to the invoking working directory even when using `--root contracts`. Invoke `contracts/script/DeployLogger.s.sol:DeployLogger` from the repository root, as the working smoke does.
- A read-only configuration probe with non-secret loopback values confirmed `FOUNDRY_ETH_RPC_URL` and a JSON array in `FOUNDRY_ETH_RPC_HEADERS` populate Foundry's `eth_rpc_url` and `eth_rpc_headers`. The same probe did not populate `eth_rpc_url` through `ETH_RPC_URL`. Validate actual script behavior in the local integration test rather than assuming Cast and Forge use identical environment names.

## Decision Log

- Decision: Keep node location separate from Ethereum/IPFS location. Rationale: a local node must still interact with the selected Ethereum network and supplied services. Date/Author: 2026-09-11 / user requirement, recorded by Codex.
- Proposed decision: Use a foreground local command with terminal logs, status, and Ctrl-C shutdown. Rationale: reuses the existing lifecycle and avoids introducing a background service manager for the first local release. Date/Author: 2026-09-11 / Codex; draft assumption for review.
- Decision: Keep Logger deployment an explicit action; running or restarting the node only uses an existing address. Rationale: service lifecycle operations should not unexpectedly deploy contracts or spend deployment gas. Date/Author: 2026-09-11 / Codex.
- Decision: Reuse the existing Foundry deployment script and signed-message client. Rationale: the missing work is operating-tool orchestration, not another contract deployer or agent implementation. Date/Author: 2026-09-11 / Codex.
- Decision: Keep dependencies, kernel interfaces, contract ABI, and runtime message semantics unchanged. Rationale: the scripts can use Node built-ins, the existing host dependencies, and Foundry. Add no compatibility options or migration layer. Date/Author: 2026-09-11 / Codex, following the user's constraints.

## Outcomes & Retrospective

Only this ExecPlan has been created. No scripts, runtime code, package metadata, contracts, or other documentation have been changed. No installation, service startup, test suite, or blockchain transaction has been run for this task.

The intended outcome is a usable local node with a stable operator-selected identity and Logger address, exercised by a separate local client process. It does not claim unattended recovery after a crash or persistent availability after the terminal closes. Record each milestone's actual validation and remaining work here when implemented.

## Context and Orientation

The standalone runtime is `node/production/`. `src/config.mjs` validates configuration and constructs authorized RPC/IPFS transports. `src/signer.mjs` loads `OYA_NODE_PRIVATE_KEY` and signs transactions with ethers. `src/main.mjs` starts the server after checking the chain and Logger. `src/server.mjs` owns `/healthz`, `/v1/messages`, authentication, the single-operation guard, deadlines, and final responses. Preserve these responsibilities.

`packages/` supplies the hardened libraries; application setup, environment loading, CLI commands, and Foundry orchestration belong in the host tooling. `contracts/script/DeployLogger.s.sol` already deploys Logger and enforces `LOGGER_CHAIN_ID`. It consumes `LOGGER_DEPLOYER_PK`, which is a deployment credential separate from the running node's key.

`node/production/config.example.json` and `.env.example` are templates. The existing default local files, `config.local.json` and `.env`, are ignored by Git. `scripts/send-message.mjs` signs a nonempty ASCII file using `OYA_AGENT_PRIVATE_KEY` and submits the existing JSON envelope. The prior completed runtime plan is `plans/production-node-direct-handler-execplan.md`; its 20 host tests and real local smoke are the regression baseline.

### Proposed operator interface

Add one package command, `npm --prefix node/production run local -- <action>`, backed by `node/production/scripts/local-node.mjs`. Support `--config <path>` and `--env-file <path>` for commands that consume settings. Their defaults are `node/production/config.local.json` and `node/production/.env`, resolved from the package location. Resolve supplied relative paths against the caller's original working directory (`INIT_CWD` under npm, otherwise `process.cwd()`), and show absolute paths in examples with overrides. Running from another directory must not break repository-relative build or deployment commands.

| Action | Behavior |
| --- | --- |
| `setup` | Install/build the existing kernel and production packages, then create missing config/environment files from the templates. Never overwrite existing files or generate real-network keys. |
| `check` | Validate settings, derive the node's public address, check Ethereum chain ID, Logger bytecode, node gas balance, and IPFS API reachability. Read-only and bounded by timeouts. |
| `run` | Check the configured environment and launch the existing node CLI in the foreground. Print its local URL and public identity; preserve terminal logs and graceful signal handling. |
| `status` | Query the configured local `/healthz`, check the returned identity against configuration, and report ready, busy, unavailable, unreachable, or identity mismatch. Never start or restart anything. |
| `deploy-logger` | Simulate the existing Logger deployment script, or report that a configured deployment is already usable. Broadcast only with explicit `--broadcast`; record and apply a newly verified address. |

Use `--help` to describe these actions and their exit behavior. No action other than `deploy-logger --broadcast` submits a transaction by itself. In particular, neither `check` nor `status` sends a test message. Normal HTTP messages received during `run` retain their existing blockchain effects.

### Configuration and secrets

Keep the existing runtime schema. Required settings remain chain ID, Logger address, signer allowlist, and RPC/IPFS URLs. The local runner accepts only loopback binding addresses, initially `127.0.0.1` and `::1`; its default remains `127.0.0.1:8787`. Do not bind to all interfaces or assume an external agent needs inbound public access. A local agent uses the printed node URL and must sign with an address in `allowedSigners`.

Use Node's built-in `.env` support instead of a new dotenv dependency. Define precedence explicitly: values in the selected environment file override corresponding inherited values; missing values may be supplied by the operator's environment. Do not silently load additional files. For the node child, forward the selected node key and provider authorization values, and remove agent/deployer keys. For deployment, pass only the deployment credential and selected RPC configuration among the Oya/Logger settings. Tests must demonstrate that an unrelated inherited key cannot override an explicitly selected file.

Create new private config/environment files with mode `0600`; never overwrite or loosen existing permissions. RPC URLs can contain credentials, so output only public chain/address information and local paths, not complete config objects, URLs for providers, private keys, headers, raw child-process exceptions, or unsanitized provider failures. Installation, startup, and deployment failure messages should name the failed step and give a safe next action.

Use one new ignored `node/production/deployment.local.json` for successful Logger deployment metadata: chain ID, contract address, deployment transaction hash, block number, and deployer address. For a custom config path, use a sibling filename derived from that config's basename so separate configurations do not overwrite each other's metadata. This record contains no signing material or message progress. Do not add `stateDir`, transaction replay, process locks, or runtime persistence.

### Prerequisites and service boundaries

The local node requires Node 22 or newer, npm, configured Ethereum RPC access, a funded node account, and a Kubo-compatible IPFS API with publication access. Foundry and the `lib/forge-std` submodule are required only when deploying Logger or running the full local integration fixture. Anvil and Kubo executables are required only for the all-local test path.

`setup` runs `npm --prefix packages ci`, `npm --prefix packages run build`, and `npm --prefix node/production ci` from the repository root. Use lazy imports so the setup action can run before production dependencies are installed. Do not install global tools, upgrade packages, rewrite lockfiles, or reinstall packages during `run`. A failed setup exits nonzero with the failed step identified; repeating it is permitted.

The `check` action uses configured authorization headers. Check chain ID and Logger code through the existing Ethereum RPC API, inspect the node's native balance, and query the IPFS API's version endpoint without uploading. A zero gas balance is a readiness failure; a positive balance is not a guarantee that every later transaction fits the budget. Reachability does not prove IPFS write permission or long-term content availability; the explicit integration test proves publication. These checks must not depend on Anvil-specific RPC methods.

The operator owns the supplied Ethereum and IPFS processes. This CLI must not stop them, reset them, fund accounts through development RPC methods, or overwrite their data. For a disposable demonstration, retain the existing `smoke:local -- --keep-running` workflow and label it clearly. A persistent IPFS service retains the uploaded data independently of this node's process lifetime.

## Plan of Work

### Milestone 1: Prepare and run a configured local node

Implement the `setup`, `check`, `run`, `status`, and help actions in `node/production/scripts/local-node.mjs`, plus the `local` package command. Extract a small `scripts/local-config.mjs` helper only for shared path resolution and environment/config loading if needed. Keep the new tooling out of `packages/` and avoid changing the HTTP runtime.

`setup` copies templates only when missing and clearly identifies fields the operator must fill. The template Logger address is not a deployment; bytecode readiness checks must still reject it unless it actually identifies code on the selected chain. `run` delegates to `src/main.mjs` through `process.execPath`, forwards SIGINT/SIGTERM, waits for the child to finish draining, and preserves its exit outcome. Do not use Node watch mode, an automatic restart policy, or a short force-kill timeout. Startup failure or an occupied port must not leave another process running.

`status` is a bounded health query. Treat ready and busy as a running service, and distinguish them in output. Return nonzero for unavailable, unreachable, malformed health data, or a mismatched chain/Logger/node identity. It must remain useful when the node deliberately reports `transaction_outcome_unknown`; that result is not an instruction to restart. Terminal output is the log interface. Stop with Ctrl-C in the owning terminal; restart by an explicit subsequent `run` after appropriate reconciliation.

Add focused process/config tests under `test/local-operations.test.mjs`, automatically included by the existing `npm test` glob. Cover preservation of existing config files, environment precedence and secret redaction, wrong-chain/Logger/IPFS readiness failures, occupied ports, unavailable health without restart, and signal forwarding that waits for the child. Use local fixtures and generated credentials. Do not add tests that merely duplicate every CLI branch or existing kernel validation.

This milestone is independently usable with an already deployed Logger and supplied RPC/IPFS endpoints. Show its diff and `npm --prefix node/production test` results, then pause for review.

### Milestone 2: Deploy Logger explicitly and retain its identity

Add the `deploy-logger` action as orchestration of `contracts/script/DeployLogger.s.sol`. No Solidity changes are expected. First initialize the existing `lib/forge-std` submodule if needed and build the contracts. Validate the selected chain and deployment key before invoking Forge. This action can operate before the running node is funded or has usable Logger bytecode; do not call the full node-readiness check as its prerequisite.

If the configured Logger already has code, report that the existing address is in use and do not deploy another contract. Otherwise, `deploy-logger` without `--broadcast` runs the Foundry simulation only. With `--broadcast`, repeat simulation as part of the normal Foundry script execution and broadcast explicitly. Use the configured chain ID for `LOGGER_CHAIN_ID`, the separately supplied `LOGGER_DEPLOYER_PK`, and the configured RPC endpoint and authorization. An external network is allowed by configuration, but implementation validation broadcasts only on isolated Anvil; approval of this plan is not permission to use unspecified live credentials or funds.

Invoke Forge from the repository root with argument arrays, not shell-interpolated commands. Supply `FOUNDRY_ETH_RPC_URL` and `FOUNDRY_ETH_RPC_HEADERS` through its child environment so credential-bearing RPC URLs and headers do not appear in process arguments. Validate the installed Foundry behavior in the local tests, including authorized RPC access. Do not log the child environment. Contract deployment remains implemented by the existing Solidity script; host code only orchestrates it and reads the result.

After a broadcast, verify the successful receipt, expected chain, and deployed code using the existing Ethereum kernel primitives. Read the current invocation's Foundry artifact, not an unrelated stale `run-latest.json`; isolate broadcast output or check invocation freshness and identity before selecting its transaction. Only then write public deployment metadata and update `loggerContract` in the selected config. Preserve all other settings and file permissions, and replace config atomically. Simulation, failure, or uncertain receipt observation must leave the configured address unchanged.

Do not automatically retry, redeploy, or invoke `forge --resume` after an ambiguous broadcast. Retain the available Foundry artifact and report any known hash through sanitized output for operator inspection. If onchain deployment succeeded but recording configuration failed, report the verified address so it can be adopted without another deployment. There is no replacement-deployment flag in this first version; a separate intentional configuration can be used for a different deployment.

Add a blank, documented `LOGGER_DEPLOYER_PK` entry to `.env.example`; existing local environment files remain untouched. Extend CLI tests for simulation without broadcast, chain mismatch before effects, preservation of configuration on failure, verified address recording, and reuse without redeployment.

Introduce `node/production/scripts/test-local-operations.mjs` and a `test:local` package command in this milestone. Initially this fixture owns a fresh Anvil process, temporary config/environment files, and a generated funded deployment account. Exercise the actual CLI to simulate, broadcast, verify the recorded address, and repeat deployment as a reuse operation with no additional transaction. Always stop the owned process. Run the host tests, contract build, and `test:local` before reviewing this milestone; milestone 3 will extend this same fixture to publication and node lifecycle checks.

### Milestone 3: Prove operation with a separate local sender

Extend `node/production/scripts/test-local-operations.mjs` to run isolated offline Kubo alongside its disposable Anvil, using the existing smoke's approach. Generate separate deployer, node, and agent identities, and fund only the test deployer and node through that owned Anvil. Create private config/environment files in a temporary directory; do not touch the operator's default files or services.

Exercise the actual local CLI to simulate and deploy Logger, run `check`, launch `run`, and query `status`. From a separate child process, use the existing `scripts/send-message.mjs` with an agent-only environment to submit a signed file. Assert the `200` / `logged` response, retrieve the exact signed envelope from Kubo, and independently inspect the expected Logger event on Anvil. A disallowed signer must be rejected before any Logger transaction. No new agent implementation is needed to prove the same interface is usable by a local agent.

Stop the foreground node via SIGINT and confirm its child exits; keep the fixture RPC/IPFS services alive. Restart with the same config and node identity and assert the Logger address is unchanged and no transaction was submitted merely by restarting. Submit another explicit message and verify it succeeds. Exercise `status` after shutdown and inspect output for secret markers. Stop every fixture-owned process in cleanup and leave unrelated processes alone. Record public addresses, hashes, and checks in a temporary evidence file, with no secret values.

Update `node/production/README.md` with the setup/run/status/deploy workflow, explicit foreground stopping, supplied-service ownership, separate agent signing, failure handling, and the distinction between a local node and its Ethereum network. Add concise pointers in `node/README.md` and the completed direct-handler plan where useful. Keep the old smoke as a regression test; do not turn it into the production launcher or refactor it broadly just to share a few fixture lines.

Run the host tests, contract build, new local integration test, existing smoke, and whitespace checks. Review evidence and documentation before declaring the plan complete.

## Concrete Steps

These commands are for future approved implementation and validation, not commands to run while reviewing this plan. Use the repository root unless otherwise specified.

The intended operator workflow is:

    npm --prefix node/production run local -- setup

Edit the created `config.local.json` and `.env` with the intended chain, RPC/IPFS endpoints, allowed agent addresses, and node key. Supply an existing Logger address, or load a deployment key and explicitly use:

    npm --prefix node/production run local -- deploy-logger
    npm --prefix node/production run local -- deploy-logger --broadcast

The first deployment command simulates; the second broadcasts only when a usable Logger is not already configured. Then:

    npm --prefix node/production run local -- check
    npm --prefix node/production run local -- run

In another terminal:

    npm --prefix node/production run local -- status
    node --env-file=/absolute/path/to/agent.env node/production/scripts/send-message.mjs http://127.0.0.1:8787 /absolute/path/to/message.txt

The agent environment contains `OYA_AGENT_PRIVATE_KEY`, and its corresponding address is allowlisted in the node config. The file contains the exact nonempty ASCII text to sign. A successful response contains the CID and verified Logger transaction hash. The node process never needs the agent key. Ctrl-C in the node's terminal drains and stops it.

An alternate config uses explicit paths, for example:

    npm --prefix node/production run local -- run --config /absolute/path/to/node.json --env-file /absolute/path/to/node.env

Underlying build/deployment commands used by the wrapper are:

    npm --prefix packages ci
    npm --prefix packages run build
    npm --prefix node/production ci
    git submodule update --init lib/forge-std
    forge build --root contracts --sizes
    forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --offline
    forge script --root contracts contracts/script/DeployLogger.s.sol:DeployLogger --broadcast --offline

The Forge invocations receive `LOGGER_CHAIN_ID`, `LOGGER_DEPLOYER_PK`, and selected Foundry RPC settings through the child environment. `--offline` prevents compiler downloads; it does not prevent RPC access. Build before deployment. The tooling must make the selected chain and deployer address visible without printing secrets.

Milestone 1 validation:

    npm --prefix node/production test
    git diff --check

Milestone 2 validation (the local fixture at this stage exercises deployment and reuse on isolated Anvil):

    npm --prefix node/production test
    forge build --root contracts --sizes
    npm --prefix node/production run test:local
    git diff --check

Final validation:

    npm --prefix node/production test
    forge build --root contracts --sizes
    npm --prefix node/production run test:local
    npm --prefix node/production run smoke:local
    git diff --check

No kernel or contract source changes are planned. If implementation actually requires such changes, record the reason and applicable additional checks before expanding scope. Dependency installation may require network access; tests that bind loopback sockets may require workspace escalation. No external-network broadcast is necessary for acceptance.

## Validation and Acceptance

Acceptance is an operator-visible flow from a prepared checkout to a foreground node receiving a separately signed local request and producing an actual Logger event. The RPC endpoint and expected chain come from configuration, independent of the loopback node address. The local integration fixture must exercise the public CLI rather than calling only internal helpers.

Setup must leave existing operator files untouched, use existing lockfiles, and avoid installing the legacy agent runner. Readiness checks and status must submit no transactions and publish no data. Correctly authenticated RPC/IPFS endpoints must work; wrong chain, missing bytecode, zero node balance, unreachable services, and missing secrets must yield useful sanitized failures. An already running listener or mismatched health identity must not be mistaken for a successful launch.

A deployment simulation must not alter the chain or configured Logger address. A successful broadcast must be verified before configuration changes. Reuse and ordinary node restarts must preserve the Logger address and signing identity without creating transactions. Failure or lost deployment receipts must not trigger automatic redeployment.

The local agent client must succeed when authorized and fail when unauthorized. Verify actual IPFS content and Logger event fields. SIGINT/SIGTERM must preserve draining and leave no child node process behind. Status must accurately surface the existing uncertain-transaction state without restarting the node. Do not re-test every kernel invariant in the new CLI tests; retain the existing host suite and smoke for those behaviors.

## Idempotence and Recovery

Repeated setup may reinstall from lockfiles but never overwrites configured identities or endpoints. Checks and status are read-only. Logger reuse does not broadcast. Publishing a signed message remains an explicit operation that can create another event and spend gas if repeated.

Stopping the foreground runner does not stop supplied Ethereum/IPFS services or remove their data. Restart the Oya process explicitly after a clean drain. If a prior transaction or deployment has an unknown outcome, inspect its known hash and account state before restarting or retrying. This tooling neither reconciles transactions automatically nor restores application progress after a hard crash.

Retain the private configuration, environment, and public deployment receipt across ordinary process restarts. They describe how to run the node; they are not a publication journal. Restoring a stopped or reset Anvil chain is the operator/test fixture's responsibility. The same chain ID alone does not guarantee that an earlier Logger still exists, so startup must continue checking its code.

Source changes are reversible through normal review. Do not delete operator config, credentials, IPFS repositories, or blockchain data as part of setup, cleanup, or rollback. Test cleanup is limited to the processes and temporary resources owned by that test.

## Artifacts and Notes

This plan is grounded in the current checkout at `5817192`. The planning probes printed only boolean results for non-secret Foundry RPC configuration and confirmed that the working tree was clean before drafting. No application tests or deployments were run during planning.

During implementation, record the exact commands and outcomes at each milestone. Final evidence should include the local node URL, chain ID, Logger address, deployment and publication hashes, agent/node public addresses, successful stop/restart checks, and confirmation that temporary services were stopped. Never include environment file contents, private keys, provider credentials, or signed raw transaction bytes in the plan.

## Interfaces and Dependencies

Expected changed/new files are `node/production/scripts/local-node.mjs`, an optional small `scripts/local-config.mjs`, `test/local-operations.test.mjs`, `scripts/test-local-operations.mjs`, `node/production/package.json` for command entries only, `.env.example` for the empty deployment-key setting, relevant READMEs, and `.gitignore` for local deployment metadata. Reuse `src/config.mjs`, `src/main.mjs`, `src/signer.mjs`, and `scripts/send-message.mjs`. Existing contracts remain in `contracts/`, and deployment is performed by `contracts/script/DeployLogger.s.sol`.

Use Node built-ins for argument handling, process execution, filesystem operations, and environment parsing; reuse the existing kernel Ethereum calls and signer for read-only checks. Keep child-process invocation structured and environment-scoped. Retain ethers as already accepted; add no npm dependencies and change no lockfiles or kernel interfaces. No agent-specific module, commitment verifier, proposal endpoint, supervisor, compatibility shim, or background process manager is introduced by this draft.
