# Build with the reviewed project environment. Output is an onedir runtime.
import importlib.metadata
import hashlib
import json
import platform
import ssl
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata

root = Path(SPECPATH).parents[2]
datas = []
# Some vendor Python distributions retain a local rejected-CA list in ssl.py.
# Preserve that data without modifying or weakening the vendor's trust policy.
rejected_cas = Path(ssl.__file__).with_name("codex-rejected-cas.pem")
if rejected_cas.is_file():
    datas.append((str(rejected_cas), "."))
binaries = []
hiddenimports = ["heyuna.cli", "heyuna.app", "heyuna.training",
                 "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                 "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on"]
for distribution in ["heyuna", "fastapi", "uvicorn", "httpx", "safetensors", "huggingface-hub", "transformers",
                     "tokenizers", "numpy", "pydantic", "psutil", "packaging", "regex", "tqdm", "filelock",
                     "sentencepiece", "pyyaml"]:
    try:
        datas += copy_metadata(distribution)
    except Exception:
        if distribution in {"heyuna", "sentencepiece"}:
            continue
        raise
hiddenimports += collect_submodules("transformers")
datas += collect_data_files("transformers", include_py_files=True)
if platform.system() == "Darwin":
    for distribution in ["mlx", "mlx-metal", "mlx-lm"]:
        try:
            datas += copy_metadata(distribution)
        except Exception:
            if distribution != "mlx-metal":
                raise
    hiddenimports += collect_submodules("mlx_lm")
    hiddenimports += collect_submodules("mlx")
    datas += collect_data_files("mlx", includes=["**/*.metallib", "**/*.json"])
    datas += collect_data_files("mlx_lm", include_py_files=True)
    binaries += collect_dynamic_libs("mlx")
    excludes = ["torch", "tensorflow", "jax", "pytest", "IPython", "matplotlib", "pandas", "scipy", "sklearn"]
else:
    hiddenimports += collect_submodules("peft")
    hiddenimports += ["torch", "accelerate"]
    excludes = ["mlx", "mlx_lm", "tensorflow", "jax", "pytest", "IPython", "matplotlib"]

a = Analysis([str(root / "apps/desktop/sidecar/entry.py")], pathex=[str(root / "backend")],
             binaries=binaries, datas=datas, hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[],
             excludes=excludes + ["heyuna.coordinator", "sqlalchemy", "psycopg", "psycopg_binary"],
             noarchive=False)

# Preserve license texts for the distributions that actually supply collected
# modules, including native extensions and dependency notices within wheels.
module_owners = importlib.metadata.packages_distributions()
modules = {name.split(".")[0] for name, *_ in a.pure}
modules |= {name.replace("\\", "/").split("/")[0].split(".")[0] for name, *_ in a.binaries}
packages = {name for module in modules for name in module_owners.get(module, [])}
packages |= {"pyinstaller", "pyinstaller-hooks-contrib"}
if platform.system() == "Darwin":
    packages |= {"mlx-metal"}
license_index = []
fallback_directory = root / "apps/desktop/sidecar/licenses"
fallbacks = json.loads((fallback_directory / "sources.json").read_text(encoding="utf-8"))
for package in sorted(packages):
    distribution = importlib.metadata.distribution(package)
    files = []
    for relative in distribution.files or []:
        if not Path(relative).name.lower().startswith(("license", "licence", "copying", "notice", "authors")):
            continue
        source = Path(distribution.locate_file(relative))
        if source.is_file() and ".." not in Path(relative).parts:
            target = f"licenses/python/{package}/{relative.as_posix()}"
            a.datas.append((target, str(source), "DATA"))
            files.append(target)
    if package == "heyuna":
        for name in ["LICENSE", "NOTICE"]:
            target = f"licenses/python/heyuna/{name}"
            a.datas.append((target, str(root / name), "DATA"))
            files.append(target)
    if not files and package in fallbacks:
        fallback = fallbacks[package]
        source = fallback_directory / fallback["file"]
        if distribution.version != fallback["version"] or hashlib.sha256(source.read_bytes()).hexdigest() != fallback["sha256"]:
            raise RuntimeError(f"Review the pinned upstream license for {package} {distribution.version}")
        target = f"licenses/python/{package}/{fallback['file']}"
        a.datas.append((target, str(source), "DATA"))
        files.append(target)
    if not files:
        raise RuntimeError(f"No retained license text for collected distribution {package}; review its upstream package")
    license_index.append({"name": distribution.metadata["Name"], "version": distribution.version,
                          "license_expression": distribution.metadata.get("License-Expression"),
                          "license_files": files})
python_license = Path(sys.base_prefix) / f"lib/python{sys.version_info.major}.{sys.version_info.minor}/LICENSE.txt"
if not python_license.is_file():
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    raise RuntimeError("The embedded CPython license must be present before packaging")
a.datas.append(("licenses/CPython-LICENSE.txt", str(python_license), "DATA"))
license_manifest = Path(a.tocfilename).parent / "python-license-index.json"
license_manifest.write_text(json.dumps(license_index, indent=2) + "\n", encoding="utf-8")
a.datas.append(("licenses/python-license-index.json", str(license_manifest), "DATA"))
a.datas.append(("licenses/pinned-upstream-sources.json", str(fallback_directory / "sources.json"), "DATA"))

pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="heyuna-service", debug=False,
          strip=False, upx=False, console=True, disable_windowed_traceback=False, argv_emulation=False,
          target_arch=None, codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="heyuna-service")
