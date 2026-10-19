"""Independent standard-library numerical reproduction of the frozen oracle.

Reads retained installed evidence, not a candidate trainer or supplied grades.
This is a development reference, not independent institutional custody.
"""
import hashlib
import json
import math
import pathlib
import sys

directory = pathlib.Path(sys.argv[1]).resolve()
raw = (directory / "learning-release.json").read_bytes()
release = json.loads(raw)["release"]["body"]
samples = release["experience"]["samples"]
training = release["training"]
config = training["configuration"]
assert config["epochs"] == 600 and config["learningRate"] == 0.4
assert config["l2"] == 0.0001 and config["seed"] == "ZERO_INITIALIZATION_NO_RANDOMNESS"
classes = ["WAIT", "RECONCILE", "REQUEST_INDEPENDENT_CHECK", "STOP_ACCEPTED"]
original = release["originalCheckpoint"]["weights"]
assert len(original) == 32 and all(v == 0 for v in original)
assert len(samples) == training["sampleCount"] and 8 <= len(samples) <= 4096
weights = list(original)


def probabilities(coefficients, features):
    scores = [sum(a * b for a, b in zip(coefficients[c*8:c*8+8], features))
              for c in range(4)]
    terms = [math.exp(v - max(scores)) for v in scores]
    result = [v / sum(terms) for v in terms]
    assert all(math.isfinite(v) for v in result)
    assert abs(sum(result) - 1) <= 1e-10
    return result


first_update = None
for epoch in range(600):
    gradients = [[0.0] * 8 for _ in range(4)]
    for sample in samples:
        features = sample["features"]
        assert len(features) == 8 and all(v in (0, 1) for v in features)
        label = classes.index(sample["label"])
        output = probabilities(weights, features)
        for c, row in enumerate(gradients):
            residual = output[c] - (1 if c == label else 0)
            for j, feature in enumerate(features):
                row[j] += residual * feature / len(samples)
    weights = [value - 0.4 * (gradients[i // 8][i % 8] + 0.0001 * value)
               for i, value in enumerate(weights)]
    if epoch == 0:
        first_update = list(weights)

actual = release["checkpoint"]["weights"]
errors = [abs(a - b) for a, b in zip(weights, actual)]
assert all(abs(a-b) <= 1e-10 + 1e-8 * abs(b) for a, b in zip(weights, actual))
assert any(a != b for a, b in zip(actual, original))
inferences = []
for sample in samples:
    p = probabilities(actual, sample["features"])
    inferences.append({"features": sample["features"], "probabilities": p,
                       "decision": classes[p.index(max(p))]})
report = {
    "schema": "finnor.x5.independent-numeric-reference.v1",
    "evidenceFileSha256": hashlib.sha256(raw).hexdigest(),
    "referenceSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    "sampleCount": len(samples), "epochsReproduced": 600,
    "firstUpdate": first_update, "reproducedWeights": weights,
    "maximumAbsoluteParameterError": max(errors),
    "originalCheckpointDigest": release["originalCheckpoint"]["digest"],
    "trainedCheckpointDigest": release["checkpoint"]["digest"],
    "inferences": inferences, "numericTolerancePass": True,
    "qualification": "SEPARATE_PYTHON_IMPLEMENTATION_PUBLIC_DEVELOPMENT_NOT_PROTECTED",
}
(directory / "independent-numeric-reference.json").write_text(
    json.dumps(report, indent=2) + "\n")
print(json.dumps({k: report[k] for k in (
    "sampleCount", "epochsReproduced", "maximumAbsoluteParameterError",
    "numericTolerancePass")}))
