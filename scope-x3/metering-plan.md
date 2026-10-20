# Development process-meter acceptance

Before implementing the meter, freeze its limited claim: observe one actual
task-owned Linux command and its discoverable descendants through `/proc`.
Do not call a single-process high-water mark an aggregate peak, or treat
sampling as an attested unsampled maximum.

Retain command, cwd, source commit/tree/dirty hashes, start/end, exit/signal,
sample interval, process identities, sampled aggregate RSS/swap, observed CPU
ticks and observer overhead. Keep command output separate. Never read process
environments, bearer tokens, browser storage, or another process's command line.
The ancestry census may read process parent/start identifiers, but only owned
descendant measurements belong in the receipt.

Bound an engineering command to 15 minutes and 6 GiB sampled descendant RSS on
this four-CPU, 7.77-GiB host unless an explicit smaller bound is supplied.
Bound the command log to 16 MiB; retain a bound-exhausted attempt as a failure.
Terminate only observed, still-identical descendants on exhaustion. These
engineering bounds do not renew any application's original allocation or
deadline. Do not change protected or financial protocol limits.

Credible failures: PID reuse; counting an unrelated process; double-counting
child CPU through parent `cutime`; disappearing processes; hidden short-lived
descendants; mistaking RSS for private physical memory; losing a failed exit;
overwriting an earlier attempt; unbounded logs; timeout leaving owned children;
and treating unavailable money/human/provider meters as zero.

Missing observations stay unknown. CPU samples are lower bounds; sampled RSS
can overcount shared pages and miss short peaks. This is reproducible development
instrumentation, not protected accounting or provider billing.

A browser daemon may finish asynchronously after its CLI's successful exit.
Keep the original strict `PARTIAL_COMMAND_CLEANUP` receipt unchanged. A separate
followup may read only its listed PID/start-time identities and record whether
each original process is still live. Bind the original receipt hash and actual
followup time. Never treat eventual cleanup as zero-latency cleanup, fill the
unobserved intervening CPU/peak gap, or terminate a reused/unrelated PID.
