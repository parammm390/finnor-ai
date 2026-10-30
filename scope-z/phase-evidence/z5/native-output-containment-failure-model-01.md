# Common E2E output containment model

This model precedes the common E2E helper edit. The public runner already
has a physical output-containment guard, but `e2e-tools.mjs` still checks only
an absolute textual `scope-z/phase-evidence/z5/` prefix before `mkdir`.
Native/process/recovery/diagnostic entry points use that helper. A `..`
segment or a parent symlink can therefore name an output outside the owned
prefix despite passing the textual check. The native driver calls it before
its authority refusal. This is source diagnosis, not an observed escape.

Require a normalized absolute output, a physically resolved existing parent,
and a nonempty relative path physically below the actual owned evidence
directory before any creation. Refuse physical escapes and the evidence
directory itself. Keep fresh-directory-only creation and its existing mode.
Do not broaden process, DB/Auth, filesystem or native authority.

Bounded actual CLI verification after the edit:

1. Invoke the native entry with a noncanonical path whose normalized target
   remains INSIDE the owned Z5 prefix. It must exit 1 at the output guard,
   leave the normalized target absent, and never reach authority imports.
   No potentially out-of-scope write is needed for this negative.
2. Its canonical fresh output must still reach the existing credential-free
   authority refusal, exit 2, empty actions/interruption arrays and all nine
   mutation/listener counters zero.
3. Run the existing bounded process E2E on a fresh canonical owned output to
   exercise the same helper's allowed path. Preserve every original expected
   value and failure. This is affected process integration, not a unit suite
   or a new public/protected semantic population.

Check helper/native MJS syntax. No symlink fixture, outside directory,
listener, DB, credential, signer or archive is created. Native positive,
physical-path race resistance against a hostile filesystem, and native
concurrent cancellation remain NOT_RUN. This path guard is not an OS sandbox.
