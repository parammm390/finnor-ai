# Corrected source-asset/static-column audit

Run 17 is retained as FAIL: its SQL-column recognizer excluded digits and
missed the actual `s4_consumed` declaration. This run rechecks the same frozen
assets and migration with the corrected identifier grammar, preserving the
original source, producer compilation and failed report. No native product,
SQL payload, expected digest or authority is changed. This is static evidence,
not DDL execution, RLS proof, installed reconstruction or native Work proof.
