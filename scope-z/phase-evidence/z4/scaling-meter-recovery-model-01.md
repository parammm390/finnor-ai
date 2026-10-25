# Bounded failed-scaling diagnosis, before the observation-capture repair

The ten historical T=64/256 failures remain failures. Their catch handler
retained only `Z4_PROCESS_FAILED`, losing the available NativeFailure meters.
Do not infer OOM, timeout or mathematical infeasibility from that string.

Retain per-operation receipts and failure meters/physical status for future
diagnostics. Perform at most one affected T=64, observation=0 diagnostic with
the same frozen programme, input formula, original 900-second local deadline,
600-second prover CPU ceiling, 2 GiB native address-space limit and two native
threads. Node uses at most 1 GiB. Serialize it under the existing heavy lock.
This is diagnostic reuse, not eligible demand, a fresh campaign, a threshold
change or a replacement of any historical coordinate.

Report exact observed exits and meters. If failure cause remains unobserved,
leave it UNKNOWN. No DB/Auth, native owner, protected input, listener, grant,
business reservation or financial effect is authorized.
