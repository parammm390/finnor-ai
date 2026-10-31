#!/bin/bash
set -e
V=/home/factory-user/repos/fzv-int-s3-python
python3 -m venv $V
$V/bin/pip install --disable-pip-version-check -r /home/factory-user/repos/fzv-int-01/finnor-os/packages/epistemic-runtime/src/intervention-requirements.txt
$V/bin/python -c "import numpy,scipy,statsmodels,arch,pandas;print('S3_NUMERICS_OK',numpy.__version__,scipy.__version__,statsmodels.__version__,arch.__version__,pandas.__version__)"
