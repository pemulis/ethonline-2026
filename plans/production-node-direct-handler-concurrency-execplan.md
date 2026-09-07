# Simplify the production node and support concurrent message logging

This ExecPlan follows `PLANS.md`. **Status: proposed for user review; implementation is not authorized yet.** The current request authorizes writing this plan only. After plan approval, implement one milestone at a time, show its diff and validation, and wait for agreement before the next milestone. This explicit user workflow takes precedence over the repository's general instruction to execute plans continuously.

## Purpose / Big Picture

The production node should authenticate an HTTP message, call the existing kernel's `publishAndLogSignedMessage` operation, and return the final success or failure. It should accept concurrent work through a bounded in-memory queue. Multiple Logger transactions should be able to remain pending simultaneously. The host should not maintain a publication journal or recover intermediate progress after restart.

Keep the current ethers-based local signer in `node/production/`. Signing support inside the hardened packages is a separate future design discussion. Preserve message validation, signer authorization, request-size limits, configured chain checks, and kernel receipt verification.

The main additional decision proposed here is a small optional nonce override in the kernel transaction preparer. A nonce is the sequential number Ethereum assigns to transactions from an account. The existing preparer cannot safely allocate distinct nonces for concurrent calls by itself. This proposal needs review alongside the host simplification.

## Progress

- [x] 2026-09-07 20:50Z: Read repository planning instructions and inspected the current runtime and kernel interfaces at commit `594a6e2` on branch `09072026`.
- [x] 2026-09-07 20:50Z: Drafted the proposed direct-handler flow, concurrency design, failure semantics, migration, and validation below.
- [ ] User reviews the plan and proposed policy choices.
- [ ] Milestone 1: Add and validate the optional kernel nonce override.
- [ ] Milestone 2: Add and validate the bounded in-memory request queue.
- [ ] Milestone 3: Add and validate the runtime nonce coordinator.
- [ ] Milestone 4: Wire the direct kernel handler and remove journal-based orchestration.
- [ ] Milestone 5: Update end-to-end validation and operator documentation.

No application code, dependencies, contracts, or live services have been changed for this plan.

## Surprises & Discoveries

- `packages/messages/src/handlers/publish-and-log.ts` already combines publication, Logger submission, and receipt verification. Its `PublishAndLogSignedMessageError` includes the published artifact and any known transaction hash. The host does not need to recreate those stages.
- `packages/messages/src/ingress.ts` calls `onAcceptedMessage` only after schema validation, signature verification, and allowlist authorization. This is the appropriate boundary for queue admission.
- `packages/ethereum/src/transaction-preparer.ts` currently calls `eth_getTransactionCount(address, "pending")` separately for each preparation. It has no nonce reservation mechanism or caller-supplied nonce option. Two concurrent preparations can therefore select the same nonce. Merely adding HTTP workers would not resolve this.
- The combined handler waits for receipt verification. Putting that entire call behind a queue with concurrency one would still serialize transactions through mining and would not meet the requested concurrency behavior.
- No host persistence means no restart recovery or durable duplicate detection. IPFS publication and blockchain submission also cannot be rolled back by returning an HTTP failure.

## Decision Log

- Decision: Call `publishAndLogSignedMessage` from the HTTP adapter's accepted-message callback. Rationale: reuse the existing complete kernel operation. Date/Author: 2026-09-07 / user requirement, recorded by Codex.
- Decision: Remove the host publication journal, stored signed transactions, startup replay, and signer/text deduplication. Rationale: the host should return the operation's final result without persisting intermediate progress. Removing deduplication is a proposed consequence for review. Date/Author: 2026-09-07 / user requirement and Codex proposal.
- Decision: Keep ethers for host signing and add no dependencies. Rationale: explicitly accepted for now; moving signing into the kernels is deferred. Date/Author: 2026-09-07 / user requirement.
- Proposed decision: Use a bounded FIFO queue with multiple active operations and a short serialized preparation lane per signing account. Rationale: allow uploads, submissions, and receipt waits to overlap while assigning unique transaction nonces. Date/Author: 2026-09-07 / Codex, pending review.
- Proposed decision: Add optional `nonce` to `CreateTransactionPreparerOptions`; preserve existing behavior when omitted. Rationale: the host can coordinate nonces while the kernel continues to own field validation, fee selection, gas estimation, signing invocation, and transaction-hash checking. Date/Author: 2026-09-07 / Codex, pending review.
- Proposed decision: Pause new signing when a signed transaction has an uncertain outcome. Rationale: blindly recycling or advancing past an unresolved nonce can produce replacements or leave later transactions blocked behind a gap. This is an in-memory error condition, not a persistent recovery system. Date/Author: 2026-09-07 / Codex, pending review.

## Outcomes & Retrospective

This is a design proposal only. The current implementation still uses the journal and its publication coordinator. No proposed validation has run. The earlier `plans/kernel-node-logger-execplan.md` records that implementation's history; after approval and implementation, update it to point to this plan for current behavior.

The intended result removes the publication state machine and filesystem persistence. The remaining host orchestration is limited to bounded scheduling, nonce assignment, lifecycle management, and HTTP result formatting. The proposed kernel change is additive and does not introduce a signing implementation or a dependency.

## Context and Orientation

The runtime is an independent package at `node/production/`. `src/main.mjs` loads configuration and the ethers signer, checks the chain and Logger bytecode, opens the state directory, runs recovery, and starts the HTTP server. `src/server.mjs` owns stream bounds and calls the kernel ingress function. `src/publication.mjs` currently splits publication from logging, persists each stage, deduplicates messages, and permits one operation at a time. `src/store.mjs` owns JSON records and the filesystem lock. `src/signer.mjs` signs locally and does not broadcast.

The kernel entrypoints are package roots: `@oyaprotocol/messages`, `@oyaprotocol/ipfs`, `@oyaprotocol/ethereum`, and `@oyaprotocol/utils`. `publishAndLogSignedMessage` receives separate IPFS and Logger options plus one optional cancellation signal. Its result contains publication metadata and a checked Logger receipt. The node must still authenticate through `handleSignedMessage`; calling the combined helper alone does not enforce the node's allowlist.

Ethereum permits multiple pending transactions from one account, but their nonces impose execution order. Concurrent requests do not imply arbitrary onchain ordering. FIFO admission also does not guarantee message logging order: different IPFS upload durations can change the order in which jobs reach signing.

### Proposed request flow

The server bounds and reads the request, then calls `handleSignedMessage`. Its `onAcceptedMessage` callback admits the authenticated message to the queue. When a worker slot becomes available, that callback calls `publishAndLogSignedMessage` exactly once. It supplies the normal IPFS/RPC settings and a request-specific transaction preparer backed by the shared nonce coordinator. The HTTP request remains open until completion or a defined failure.

Use the existing success status `202` for compatibility, with documentation that it follows checked mined execution. Keep the existing small `publication` response summary: `status: "logged"`, CID, IPFS URI, transaction hash, decimal block number, node address, and Logger address. Remove the stored-message `messageId`. A freshly generated `requestId` may correlate responses and final diagnostic logs; it is not an idempotency key. Do not expose raw provider responses or serialize receipt `bigint` values directly.

### Proposed queue and limits

Add `src/request-queue.mjs` using native JavaScript promises. Proposed reviewable defaults are `maxConcurrentMessages: 4`, `maxQueuedMessages: 32`, `queueWaitTimeoutMs: 30000`, and `operationTimeoutMs: 180000`. Validate positive integer values and require concurrency plus queue capacity not to exceed the server's existing 64-connection bound. These are initial host policies, not kernel defaults.

Queue only authenticated requests. Waiting jobs perform no IPFS or RPC side effects. A full queue returns `503 queue_full` with `started: false` and a short `Retry-After`; a queue wait deadline returns `504 queue_wait_timeout` with `started: false`. Completed or failed jobs free a slot, and rejected promises must not stall the queue. Bound execution separately from queue waiting by supplying an operation deadline signal to the combined helper. Retain the existing upload/body timeout and kernel transport and receipt timeouts.

### Proposed nonce coordination

Add `src/nonce-coordinator.mjs`, with one coordinator per node signing account. It supplies a request-specific `TransactionPreparer` callback and tracks only active preparation/submission metadata in memory.

Serialize preparation, not the entire publish/log operation. When the first job reaches signing, read the account's pending nonce through the kernel RPC helper and parse it without numeric rounding. Reject values outside the preparer's safe-integer range. Under the preparation lock, select the next nonce and call `createTransactionPreparer` with that explicit nonce. Advance the local counter only after preparation successfully returns signed bytes and a verified transaction hash. A failed preparation before returning signed bytes does not consume a reservation. Guard increment overflow.

Release the preparation lock once signed bytes have been returned. The combined helper then broadcasts and observes receipts independently of later jobs. Keep each allocated nonce associated with its transaction hash until its call finishes. Never decrease the counter because an RPC endpoint reports an older pending count, and never let the ethers signer silently override the kernel's selected nonce. Do not use a signer-only nonce manager as a substitute for coordinated transaction preparation.

The HTTP callback reports each combined call's result or error to the coordinator. A successful result, or a kernel-validated mined receipt for that transaction even if execution reverted or the expected event is absent, establishes that its nonce was consumed. A failure after signed bytes were returned with no validated mined receipt marks nonce state uncertain. Stop issuing further nonces, reject waiting jobs before they start, and make health report unavailable. Already-started jobs that have not signed must fail when they reach preparation; their IPFS publication may already have happened. Already-signed jobs continue to obtain their own results. Do not automatically cancel, replay, replace, or recycle those transactions.

Keep the nonce-uncertain condition latched for this initial design; operator reconciliation and deliberate restart are required before resuming. Do not recreate a background recovery loop. If review favors continuing to issue nonces after uncertain failures instead, explicitly accept and test the resulting gap-handling policy before implementation.

### Important behavior requiring review

1. **An HTTP failure is not proof that nothing happened.** A transaction can be pending or mined after a timeout. Return the known CID/hash from `PublishAndLogSignedMessageError`, identify logging outcome as unknown when appropriate, and avoid suggesting automatic full-request retries after work has started. No rollback or exactly-once promise is possible here.
2. **Repeated messages are independent submissions.** Removing the journal also removes signer/text deduplication. Identical envelopes can have the same IPFS CID while producing separate Logger events and gas costs. This matches the combined kernel operation's current behavior; confirm it is the desired node policy.
3. **A queue needs capacity, wait deadlines, and shutdown semantics.** These cannot be inferred from “concurrent.” The proposed defaults above should be reviewed.
4. **One process must exclusively use a node signing account.** Removing the filesystem lock does not provide coordination across multiple hosts, containers, wallets, or replacement processes. Deploy separate accounts for separate instances. A distributed nonce allocator is out of scope.
5. **Restart loses all in-memory work.** There is no durable accepted-job promise. A replacement process reads current pending nonce state; it cannot recover unknown signed bytes or discover every prior ambiguous submission. Restarting is not itself reconciliation. Operators must account for outstanding transactions and stop the previous process before reuse of its key.
6. **Client disconnects differ from cancellation.** Remove disconnected jobs while they are waiting. Once a job has started, continue it to completion or its operation deadline even if the socket closes. Emit only a final sanitized result containing request ID and known CID/hash so the operator has diagnostic evidence; do not persist intermediate checkpoints.
7. **Provider behavior matters.** The real Anvil test must demonstrate gas estimation and submission with several sequential nonces pending. Some provider-specific pending-state behavior may need further investigation. If validation exposes a need for additional submission coordination, stop for a design review rather than quietly restoring one-at-a-time receipt waiting or adding transport interception.
8. **Mined receipt checks are not finality checks.** Keep the existing confirmation policy: the first successful checked receipt from the configured RPC. Additional confirmations and reorganization handling remain separate work.

## Plan of Work

### Milestone 1: Optional nonce in the kernel preparer

After approval, change only `packages/ethereum/src/transaction-preparer.ts`, its focused tests and type tests, relevant README text, and generated build output. Add `nonce?: number` to `CreateTransactionPreparerOptions`. Validate it as a non-negative safe integer at construction; when supplied, use it instead of reading `eth_getTransactionCount`. The default path must remain unchanged. Keep chain checking and every existing gas, fee, call-field, signature-output, and hash check. Document that a preparer constructed with an explicit nonce uses that fixed nonce on every invocation; this node constructs and invokes one such preparer per reservation.

Prove default compatibility, explicit zero and nonzero nonce use, malformed override rejection before RPC/signing, and preservation of the supplied nonce in estimation and signer input. Review the small package change before proceeding.

### Milestone 2: Bounded request queue

Add `node/production/src/request-queue.mjs` and focused behavioral tests without yet wiring it into the running server. Expose queue execution, closing/draining, and status operations. Test simultaneous execution up to the configured limit, FIFO waiting order, capacity rejection, timeout removal, waiting-client cancellation, failure isolation, and shutdown. Do not add a dependency. Review before proceeding.

### Milestone 3: In-memory nonce coordinator

Add `node/production/src/nonce-coordinator.mjs` and tests using injected RPC and signing dependencies. Preserve `src/signer.mjs` and ethers. Test initialization from pending state, unique sequential reservations, preparation failure without a gap, stale RPC values, overflow, successful nonce consumption, uncertainty latching, and independent completion of already-signed jobs. Ensure no files are written and no journal records are retained after completion. Review before wiring it into HTTP.

### Milestone 4: Direct HTTP composition and removal of host persistence

Update `src/server.mjs` so its `onAcceptedMessage` callback schedules and directly calls `publishAndLogSignedMessage`. Retain kernel authorization and stream limits. The callback may supply scheduling/signing dependencies and map results, but must not split publication and logging, verify Logger events itself, or add an outer full-operation retry loop.

Update `src/main.mjs` to construct the queue and nonce coordinator, remove `openStore` and startup replay, and drain active operations on shutdown. Remove `src/publication.mjs` and `src/store.mjs` once their consumers are gone. Update `src/config.mjs`, `config.example.json`, and affected HTTP tests. Replace old `node_busy`/`recovery_required` and stored-message response expectations with the new contract. Remove the old persistence tests rather than retaining unsupported recovery behavior.

Configuration no longer needs `stateDir`. For migration, accept an optional legacy `stateDir` string but ignore it and emit a safe deprecation notice. Do not read, delete, or migrate its contents. Update configuration examples to omit it. Retain the existing ignore rules for old local config/state so historical files cannot accidentally enter a commit.

Queue saturation/shutdown failures before execution can return retry guidance. For attempted publication/logging, map upstream failures to sanitized `502` responses and operation/receipt deadlines to `504`, retaining safe partial-result fields. Unexpected programming faults remain `500`. Preserve kernel validation/authentication statuses. An unknown outcome must not be formatted as a definitively rejected onchain transaction.

SIGINT/SIGTERM stops admission, rejects queued work, and drains started jobs within their operation deadlines before exit. Health reports ready/busy queue counts or the nonce-uncertain condition, and does not claim to continuously probe providers. Review the integrated change before the end-to-end milestone.

### Milestone 5: End-to-end evidence and documentation

Update `scripts/smoke-local.mjs` to remove store imports, manual journal edits, duplicate-suppression assertions, and crash-recovery assertions. Keep real Anvil, Kubo, signed HTTP intake, retrieved JSON, receipt/event, signature rejection, and startup checks. Submit at least three distinct valid messages with automining disabled. Assert that all three transactions are pending with distinct sequential nonces before mining; then mine and check all responses. This demonstrates actual transaction concurrency. Also resubmit an identical message and verify a new Logger event.

Update the runtime README, any affected node/contract setup references, and the earlier ExecPlan's current-behavior pointers. Explain the queue settings, failure/partial-result contract, lack of deduplication and restart recovery, dedicated-account requirement, and continued use of ethers for host signing. Keep the kernel's dependency policy unchanged. No contract ABI or deployment-script changes and no public deployment are planned.

## Concrete Steps

All commands below are planned validation after implementation approval. Use the repository root except for the package import explicitly called out below. Do not run them merely to complete this document.

After milestone 1:

    npm --prefix packages run build
    node --test packages/ethereum/test/transaction-preparer.test.js
    packages/node_modules/.bin/tsc -p packages/ethereum/tsconfig.type-test.json

Then, with `packages/` as the working directory, verify the public package import:

    node --input-type=module -e "import('@oyaprotocol/ethereum').then(m => { if (typeof m.createTransactionPreparer !== 'function') throw Error('Missing export'); })"

Return to the repository root for the remaining commands.

After each host milestone, run the relevant new focused test file, then at the integrated milestone:

    npm --prefix node/production test

After milestone 5:

    node --test packages/ethereum/test/*.test.js packages/messages/test/*.test.js
    forge build --root contracts --sizes
    npm --prefix node/production run smoke:local
    git diff --check

The smoke deploys only to isolated Anvil chain 31337 through `contracts/script/DeployLogger.s.sol`, with generated disposable accounts. It supplies `LOGGER_CHAIN_ID=31337` and `LOGGER_DEPLOYER_PK` in the child environment, and uses an isolated Kubo repository. No existing user keys or live-chain addresses are needed. Socket/network escalation may be necessary in this workspace. Do not leave an additional test stack running unless requested.

## Validation and Acceptance

Acceptance requires the HTTP adapter to visibly call the combined kernel helper and the removed journal modules to have no remaining runtime imports. Invalid and unauthorized requests never enter the work queue or publish. Queue exhaustion and wait cancellation perform no side effects. At least three independent calls can reach pending Logger transactions before any are mined, with no duplicate nonces. A failed job does not break queue bookkeeping or leak capacity.

Verify an IPFS failure, an IPFS success followed by logging failure, a pending transaction whose receipt wait expires, and a mined reverted transaction. Check that public responses report only what is known and exclude provider credentials. Verify uncertainty prevents new nonce allocations while allowing already-signed calls to settle. Verify normal operation creates no state directory or record files.

Duplicate-message tests must expect separate events. Shutdown tests must cover both waiting and active requests, including a disconnected client. The updated real smoke must prove the complete signed-message/IPFS/Logger path, not just mocked callback overlap. Existing default kernel transaction-preparer tests and package type checks must still pass.

## Idempotence and Recovery

The new endpoint intentionally has no durable idempotency or automatic restart recovery. Repeating a valid POST is another operation and can spend gas again. Transport retries inside the existing kernel remain intact; the host adds no retry around the whole combined call. Queue timeouts before execution are safe to retry because the helper was never invoked. Failures after execution began require the caller to use any returned hash/CID to determine what happened.

Before deploying this change to an existing node, stop intake and drain or reconcile its old journal entries. Keep the old state files for inspection, particularly entries with signed transactions. Do not delete keys, state, or lock files as part of this refactor. Restarting an older code version against a stale journal after running the new version could replay work; rollback requires reconciling account and chain state first. Source changes themselves remain reversible and should be reviewed as separate commits or diffs.

The ephemeral nonce coordinator reduces collisions within one healthy process. It does not establish exactly-once execution, distributed ownership of an account, or safe automatic continuation after every crash. These limits are a consequence of the explicitly simpler host model and must be visible in operator documentation.

## Artifacts and Notes

Review this document before authorizing code changes. The principal review choices are the additive kernel nonce option, queue capacity/deadline defaults, duplicate submissions producing separate events, and pausing new signing after an uncertain transaction outcome. They are recommendations here, not approved implementation decisions.

There is no new test or deployment evidence yet. Record milestone results and any design changes in this document as work is individually approved and completed. The only artifact produced by the present task is this ExecPlan.

## Interfaces and Dependencies

Preserve imports from package roots. The intended kernel API change is only `CreateTransactionPreparerOptions.nonce?: number`. Continue using `createSignedMessageAuthorizer`, `handleSignedMessage`, `publishAndLogSignedMessage`, `PublishAndLogSignedMessageError`, `createTransactionPreparer`, `requestEthereumJsonRpc`, and the existing typed logging errors. `PublishAndLogSignedMessageOptions.signal` carries the host operation deadline.

The request queue owns capacity, FIFO admission, wait deadlines, and draining. The nonce coordinator owns the preparation lock, next nonce, outstanding signed nonce/hash associations, and uncertainty status. Neither owns IPFS publication, Logger broadcasting, receipt verification, or persistent storage. The ethers signer retains its current `{ address, signTransaction }` contract. Host configuration gains queue/concurrency limits; environment variable names for node signing and provider authorization remain unchanged. No new npm dependencies are proposed.
