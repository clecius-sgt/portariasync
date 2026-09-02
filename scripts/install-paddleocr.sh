#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 não encontrado."
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "Instalando suporte a ambiente virtual do Python..."
  apt-get update
  apt-get install -y python3-venv python3-pip libgl1 libglib2.0-0
fi

if [ ! -d .venv-paddleocr ]; then
  python3 -m venv .venv-paddleocr
fi

PY="$(pwd)/.venv-paddleocr/bin/python"

"$PY" -m pip install --upgrade pip setuptools wheel
"$PY" -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
"$PY" -m pip install "paddleocr==3.3.1"

echo "Verificando PaddlePaddle..."
"$PY" -c "import paddle; print('PaddlePaddle', paddle.__version__)"

echo "Carregando o PaddleOCR e baixando os modelos na primeira instalação..."
PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True "$PY" -u scripts/paddleocr_worker.py --check

echo
printf '%s\n' "PaddleOCR instalado e modelos preparados com sucesso."
