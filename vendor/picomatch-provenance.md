# Local Picomatch security patches

The checked-in packages use the MIT-licensed npm distributions of Picomatch 2.3.2 and 4.0.7. Their upstream archive SHA-256 digests are `4c843ba015bec815ac52116162559ab7b4b4efbd3b86f7fcf38f3d770decace6` and `697b463be3cdbd9ffc8f4194fd5019a69ddf95875fb703d78b2b115cc9e740a8`, respectively.

Both parsers refuse repeated extglobs before emitting regular expressions to address CVE-2026-112366. Each upstream major remains pinned separately so its callers use the matching API. The locked archives can be regenerated with `npm pack --ignore-scripts --pack-destination vendor ./vendor/picomatch-2.3.2 ./vendor/picomatch-4.0.7`.
