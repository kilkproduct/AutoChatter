#!/usr/bin/env python3
"""Create the official JS-only Valenced plugin ZIP layout without Gradle/Java.

The archive contains manifest.json, the built dist.script at the archive root, and
assets/ when present, matching the template's Zip task. The official CLI still performs
bundling; this script only replaces the unavailable Gradle packaging step.
"""
from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / 'plugins' / 'auto-chatter'
MANIFEST_PATH = PLUGIN_DIR / 'manifest.json'
BUNDLE_PATH = PLUGIN_DIR / 'build' / 'js' / 'index.js'


def main() -> int:
    if not MANIFEST_PATH.is_file():
        print(f'Missing manifest: {MANIFEST_PATH}', file=sys.stderr)
        return 1
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        print(f'Invalid plugin manifest: {error}', file=sys.stderr)
        return 1

    plugin_id = manifest.get('id')
    version = manifest.get('version')
    script_name = manifest.get('dist', {}).get('script')
    if not all(isinstance(value, str) and value for value in (plugin_id, version, script_name)):
        print('Manifest must define string id, version, and dist.script values.', file=sys.stderr)
        return 1
    if not BUNDLE_PATH.is_file():
        print('Built bundle is missing. Run `npm run build` first.', file=sys.stderr)
        return 1

    output = ROOT / 'build' / 'dist' / f'{plugin_id}@{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.write(MANIFEST_PATH, 'manifest.json')
        archive.write(BUNDLE_PATH, script_name)
        assets = PLUGIN_DIR / 'assets'
        if assets.is_dir():
            for path in sorted(assets.rglob('*')):
                if path.is_file():
                    archive.write(path, (Path('assets') / path.relative_to(assets)).as_posix())

    artifact_dir = ROOT / 'artifacts'
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_bundle = artifact_dir / f'AutoChatter-{version}.js'
    artifact_zip = artifact_dir / f'AutoChatter-{version}.zip'
    shutil.copy2(BUNDLE_PATH, artifact_bundle)
    shutil.copy2(output, artifact_zip)

    print(f'Packaged {plugin_id} -> {output.relative_to(ROOT)}')
    print(f'Persisted deliverables -> {artifact_bundle.relative_to(ROOT)}, {artifact_zip.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
