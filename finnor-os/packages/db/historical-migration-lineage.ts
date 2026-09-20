/** Historical production-only migrations from the pre-PE source lineage. These
 * SQL bodies are fetched by immutable Git commit and SHA-256 verified in the
 * disposable upgrade rehearsal. They are not replayed into fresh installations. */
export const HISTORICAL_PRODUCTION_MIGRATIONS = [
  { name: "0102_product_truth_objective_realtime.sql", commit: "6d51c803a6ca8bd234ade7f8e8c463eadf2e03f9", sha256: "dee1412334977cd3b006f1de74f66096cbebd0144ede46f21cb1f43e6e3575c2" },
  { name: "0104_product_truth_objective_realtime.sql", commit: "f40526617c7e22258c12a2b669975ddaaf33e7fc", sha256: "dee1412334977cd3b006f1de74f66096cbebd0144ede46f21cb1f43e6e3575c2" },
  { name: "0105_human_operating_compiler.sql", commit: "f40526617c7e22258c12a2b669975ddaaf33e7fc", sha256: "894e3e5f07df61cc7b9b1b7157621e85c958ad021393d9963e3801c759bac553" },
  { name: "0106_interactive_runtime_closure.sql", commit: "f40526617c7e22258c12a2b669975ddaaf33e7fc", sha256: "7075fe94a83585f3d9fb89c0364dc44bae0986f411e933f4bf46dc79fbb36111" },
  { name: "0107_business_truth_registry.sql", commit: "f40526617c7e22258c12a2b669975ddaaf33e7fc", sha256: "8e30f81c5a7c320a9ba93ffb622ea1765717e85ddd97e96d13ce53002fb41421" },
  { name: "0108_operating_product_closure.sql", commit: "f40526617c7e22258c12a2b669975ddaaf33e7fc", sha256: "487d01f4c7cdec1779416bcf1cb499fd9aa29ae4c174ef1a1934fff85c63256b" },
  { name: "0131_private_equity_release_baseline.sql", commit: "2b25ac3c251c10b162e2f8c03184397577f0ebdb", sha256: "2e879ec149696ef97afe2fd782f5cff7633ee77eacfdd8c012b0e67a93987cc3" },
] as const;
