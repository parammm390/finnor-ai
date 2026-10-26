"""Build-time provisioning; document requests are always offline."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
from docling.utils.model_downloader import download_models

target = Path(sys.argv[1]).resolve()
download_models(output_dir=target, with_layout=True, with_tableformer=True, with_code_formula=False, with_picture_classifier=False,
    with_rapidocr=True, with_easyocr=False, progress=False)
files = []
for path in sorted(target.rglob("*")):
    if not path.is_file() or ".cache" in path.parts or path.name == "finnor-model-manifest.json":
        continue
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1048576):
            digest.update(chunk)
    files.append({"path": str(path.relative_to(target)), "bytes": path.stat().st_size, "sha256": digest.hexdigest()})
manifest = {"schema": "finnor.docling-models.v1", "docling": importlib.metadata.version("docling"), "files": files}
expected_path = Path(__file__).with_name("docling-models.manifest.json")
if expected_path.exists() and manifest != json.loads(expected_path.read_text()):
    raise SystemExit("DOCLING_MODEL_BYTES_DIFFER_FROM_REVIEWED_MANIFEST")
(target / "finnor-model-manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
print(json.dumps({"models": len(files), "bytes": sum(file["bytes"] for file in files), "manifest": str(target / "finnor-model-manifest.json")}))
