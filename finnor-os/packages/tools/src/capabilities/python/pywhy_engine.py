"""Assumption-conditional causal analysis of one immutable, numeric snapshot."""
import base64
import contextlib
import hashlib
import importlib.metadata
import io
import json
import math
from pathlib import Path
import sys


def run(payload):
    import numpy as np
    import pandas as pd
    from dowhy import CausalModel
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.linear_model import LogisticRegression, LinearRegression
    from sklearn.model_selection import cross_val_predict, StratifiedKFold, KFold

    data = base64.b64decode(payload.get("bytesBase64", ""), validate=True)
    if len(data) > 10485760 or hashlib.sha256(data).hexdigest() != payload.get("sha256"):
        raise ValueError("PYWHY_SOURCE_INVALID")
    fmt = payload.get("format")
    if fmt == "csv":
        frame = pd.read_csv(io.BytesIO(data), nrows=10001)
    elif fmt == "json":
        records = json.loads(data)
        if not isinstance(records, list) or len(records) > 10000:
            raise ValueError("PYWHY_ROW_LIMIT")
        frame = pd.DataFrame(records)
    elif fmt == "parquet":
        import duckdb
        connection = duckdb.connect(":memory:", config={"threads": "1", "memory_limit": "128MB"})
        try:
            import tempfile
            with tempfile.TemporaryDirectory(prefix="finnor-pywhy-") as directory:
                path = Path(directory) / "source.parquet"
                path.write_bytes(data)
                frame = connection.execute("SELECT * FROM read_parquet(?) LIMIT 10001", [str(path)]).fetchdf()
        finally:
            connection.close()
    else:
        raise ValueError("PYWHY_FORMAT_UNSUPPORTED")
    if not 40 <= len(frame) <= 10000 or not frame.columns.is_unique:
        raise ValueError("PYWHY_SAMPLE_OR_COLUMNS_INVALID")
    treatment, outcome = payload["treatment"], payload["outcome"]
    causes, modifiers = payload["commonCauses"], payload.get("effectModifiers", [])
    if treatment == outcome or treatment in causes + modifiers or outcome in causes + modifiers or len(set(causes)) != len(causes) or len(set(modifiers)) != len(modifiers):
        raise ValueError("PYWHY_VARIABLE_ROLES_INVALID")
    columns = list(dict.fromkeys([treatment, outcome] + causes + modifiers))
    if any(column not in frame.columns for column in columns):
        raise ValueError("PYWHY_COLUMN_MISSING")
    numeric = frame[columns].apply(pd.to_numeric, errors="raise")
    if not np.isfinite(numeric.to_numpy(dtype=float)).all():
        raise ValueError("PYWHY_NONFINITE_OR_MISSING_VALUES")
    if any(float(numeric[column].std()) <= 1e-12 for column in columns):
        raise ValueError("PYWHY_CONSTANT_VARIABLE")
    seed = int(payload.get("seed", 0))
    np.random.seed(seed)
    controls = list(dict.fromkeys(causes + modifiers))
    t, y, w = numeric[treatment].to_numpy(), numeric[outcome].to_numpy(), numeric[controls].to_numpy()
    scaled = (w - w.mean(axis=0)) / w.std(axis=0)
    condition = float(np.linalg.cond(np.column_stack([np.ones(len(w)), scaled])))
    if condition > 1e8:
        raise ValueError("PYWHY_DESIGN_SINGULAR")
    binary = set(np.unique(t)) == {0, 1}
    support = {"kind": "binary" if binary else "continuous", "designConditionNumber": condition}
    if binary:
        counts = np.bincount(t.astype(int), minlength=2)
        if int(counts.min()) < 10:
            raise ValueError("PYWHY_TREATMENT_SUPPORT_INSUFFICIENT")
        propensity = cross_val_predict(LogisticRegression(max_iter=500, random_state=seed), scaled, t,
            cv=StratifiedKFold(3, shuffle=True, random_state=seed), method="predict_proba", n_jobs=1)[:, 1]
        extreme = float(np.mean((propensity < 0.05) | (propensity > 0.95)))
        support.update({"groupCounts": counts.tolist(), "crossFittedPropensityRange": [float(propensity.min()), float(propensity.max())], "extremePropensityFraction": extreme})
        if extreme > 0.2:
            raise ValueError("PYWHY_OVERLAP_UNSUPPORTED")
    else:
        predicted = cross_val_predict(LinearRegression(), scaled, t, cv=KFold(3, shuffle=True, random_state=seed), n_jobs=1)
        ratio = float(np.std(t - predicted) / np.std(t))
        support["crossFittedTreatmentResidualRatio"] = ratio
        if ratio < 0.1:
            raise ValueError("PYWHY_TREATMENT_SUPPORT_INSUFFICIENT")

    # The supplied confounders define an assumed graph, not a discovered graph.
    model = CausalModel(data=numeric, treatment=treatment, outcome=outcome, common_causes=controls,
        effect_modifiers=modifiers, proceed_when_unidentifiable=False)
    estimand = model.identify_effect(proceed_when_unidentifiable=False)
    if not estimand.estimands.get("backdoor"):
        raise ValueError("PYWHY_EFFECT_NOT_IDENTIFIED_UNDER_SUPPLIED_GRAPH")
    reference = model.estimate_effect(estimand, method_name="backdoor.linear_regression", confidence_intervals=True)
    refutations = []
    for method, extras in [("random_common_cause", {}), ("placebo_treatment_refuter", {"placebo_type": "permute"}), ("data_subset_refuter", {"subset_fraction": 0.8})]:
        refuted = model.refute_estimate(estimand, reference, method_name=method, num_simulations=8, random_state=seed, n_jobs=1, **extras)
        refutations.append({"method": method, "targetEstimator": "dowhy.backdoor.linear_regression", "originalEffect": float(refuted.estimated_effect),
            "newEffect": float(refuted.new_effect), "test": refuted.refutation_result})
    estimator = payload["estimator"]
    intervals = np.asarray(reference.get_confidence_intervals()).reshape(-1).tolist()
    effect, conditional = float(reference.value), []
    if estimator != "linear":
        from econml.dml import LinearDML, CausalForestDML
        from sklearn.ensemble import RandomForestClassifier
        x = numeric[modifiers].to_numpy() if modifiers else None
        remaining = [column for column in controls if column not in modifiers]
        adjustment = numeric[remaining].to_numpy() if remaining else None
        common = {"model_y": RandomForestRegressor(n_estimators=64, max_depth=5, min_samples_leaf=5, n_jobs=1, random_state=seed),
            "model_t": (RandomForestClassifier if binary else RandomForestRegressor)(n_estimators=64, max_depth=5, min_samples_leaf=5, n_jobs=1, random_state=seed),
            "discrete_treatment": binary, "cv": 3, "random_state": seed}
        if estimator == "double_ml":
            fitted = LinearDML(**common)
        elif estimator == "causal_forest" and x is not None and len(frame) >= 200:
            fitted = CausalForestDML(**common, n_estimators=100, subforest_size=4, max_depth=5, min_samples_leaf=10, n_jobs=1)
        else:
            raise ValueError("PYWHY_FOREST_REQUIRES_MODIFIERS_AND_200_ROWS")
        fitted.fit(y, t, X=x, W=adjustment, inference="auto")
        effect = float(fitted.ate(X=x, T0=0, T1=1))
        intervals = [float(np.asarray(bound).reshape(-1)[0]) for bound in fitted.ate_interval(X=x, T0=0, T1=1, alpha=0.05)]
        if x is not None:
            conditional = [{"rowPosition": index, "effect": float(value)} for index, value in enumerate(fitted.effect(X=x[:200], T0=0, T1=1))]

    if not math.isfinite(effect) or not all(math.isfinite(bound) for bound in intervals):
        raise ValueError("PYWHY_PRIMARY_ESTIMATE_NONFINITE")
    diagnostics = []
    def serial(value, path="result"):
        if isinstance(value, dict): return {str(key): serial(nested, path + "." + str(key)) for key, nested in value.items()}
        if isinstance(value, (list, tuple)): return [serial(nested, path + "." + str(index)) for index, nested in enumerate(value)]
        if isinstance(value, np.ndarray): return serial(value.tolist(), path)
        if isinstance(value, np.generic): return serial(value.item(), path)
        if isinstance(value, float) and not math.isfinite(value):
            diagnostics.append({"code": "NONFINITE_DIAGNOSTIC_NOT_EVIDENCE_OF_SUCCESS", "path": path})
            return None
        return value

    return serial({"schema": "finnor.pywhy-assessment.v1", "source": payload["source"], "rows": len(frame), "seed": seed,
        "variables": {"treatment": treatment, "outcome": outcome, "commonCauses": causes, "effectModifiers": modifiers},
        "assumptions": payload["assumptions"], "identification": {"estimand": str(estimand), "graphOrigin": "CALLER_SUPPLIED_CAUSAL_ASSUMPTIONS", "unmeasuredConfoundingExcludedByAssumption": True},
        "estimation": {"estimator": estimator, "effectContrast": [0, 1], "averageEffect": effect, "confidenceInterval95": intervals,
            "conditionalEffects": conditional, "conditionalEffectsTruncated": len(frame) > 200 and bool(modifiers)},
        "supportDiagnostics": support, "linearReferenceEffect": float(reference.value), "refutations": refutations,
        "refutationScope": "LINEAR_REFERENCE_ONLY; EIGHT_SIMULATIONS_ARE_DIAGNOSTIC_NOT_PROOF", "causalClaimEstablished": False,
        "backend": {name: importlib.metadata.version(name) for name in ["dowhy", "econml", "numpy", "pandas", "scikit-learn"]},
        "qualification": "ASSUMPTION_CONDITIONAL_ANALYSIS_REQUIRES_INDEPENDENT_REVIEW", "admission": {"status": "BLOCKED_EXTERNAL", "receipt": None}, "executionAuthorityGranted": False, "diagnosticWarnings": diagnostics})


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(16777217))
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "PYWHY_DEPENDENCY_UNAVAILABLE"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("PYWHY_") else "PYWHY_ASSESSMENT_FAILED"
        print(json.dumps({"ok": False, "code": code}))
