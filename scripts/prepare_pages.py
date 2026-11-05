#!/usr/bin/env python3
"""Validate the packaged plugin and stage a current download for GitHub Pages."""
from __future__ import annotations

import json
import re
import shutil
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
MANIFEST_PATH = ROOT / 'plugins' / 'auto-chatter' / 'manifest.json'
ARTIFACTS = ROOT / 'artifacts'
DOWNLOADS = SITE / 'downloads'


class LocalLinkChecker(HTMLParser):
    def __init__(self, page: Path) -> None:
        super().__init__(convert_charrefs=True)
        self.page = page
        self.page_ids: set[str] = set()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        element_id = attributes.get('id')
        if element_id:
            self.page_ids.add(element_id)
        for attribute in ('href', 'src'):
            value = attributes.get(attribute)
            if value:
                self.links.append(value)


def fail(message: str) -> int:
    print(f'Pages preparation failed: {message}', file=sys.stderr)
    return 1


def validate_site_links() -> list[str]:
    errors: list[str] = []
    for page in (SITE / 'index.html', SITE / '404.html'):
        if not page.is_file():
            errors.append(f'Missing page: {page.relative_to(ROOT)}')
            continue
        parser = LocalLinkChecker(page)
        parser.feed(page.read_text(encoding='utf-8'))
        for link in parser.links:
            parsed = urlsplit(link)
            if parsed.scheme or parsed.netloc:
                continue
            if parsed.path == '' and parsed.fragment:
                if parsed.fragment not in parser.page_ids:
                    errors.append(
                        f'{page.relative_to(ROOT)} has a missing #{parsed.fragment} target.'
                    )
                continue
            relative = unquote(parsed.path)
            target = (page.parent / relative).resolve()
            try:
                target.relative_to(SITE.resolve())
            except ValueError:
                errors.append(f'{page.relative_to(ROOT)} escapes the site directory: {link}')
                continue
            if target.is_dir():
                target /= 'index.html'
            if not target.exists():
                errors.append(f'{page.relative_to(ROOT)} links to missing file: {link}')
    return errors


def main() -> int:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        return fail(f'Cannot read plugin manifest: {error}')

    plugin_id = manifest.get('id')
    version = manifest.get('version')
    script_name = manifest.get('dist', {}).get('script')
    if not isinstance(plugin_id, str) or not plugin_id:
        return fail('Manifest is missing the plugin id.')
    if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9.-]+', version):
        return fail('Manifest version is missing or unsafe for a file name.')
    if not isinstance(script_name, str) or not script_name or Path(script_name).name != script_name:
        return fail('Manifest dist.script must be a file name at the ZIP root.')

    zip_path = ARTIFACTS / f'AutoChatter-{version}.zip'
    bundle_path = ARTIFACTS / f'AutoChatter-{version}.js'
    if not zip_path.is_file() or not bundle_path.is_file():
        return fail(f'Missing versioned release artifacts for {version}.')
    try:
        with zipfile.ZipFile(zip_path) as archive:
            corrupt_entry = archive.testzip()
            if corrupt_entry:
                return fail(f'ZIP integrity check failed at {corrupt_entry}.')
            names = set(archive.namelist())
            required = {'manifest.json', script_name, 'assets/icon.svg'}
            if not required.issubset(names):
                return fail(f'ZIP is missing required entries: {sorted(required - names)}.')
            packed_manifest = json.loads(archive.read('manifest.json'))
            if packed_manifest.get('id') != plugin_id or packed_manifest.get('version') != version:
                return fail('ZIP manifest does not match the source manifest.')
            if archive.read(script_name) != bundle_path.read_bytes():
                return fail('The ZIP bundle and versioned JavaScript artifact differ.')
    except (OSError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        return fail(f'Cannot inspect plugin ZIP: {error}')

    errors = validate_site_links()
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    required_site_files = [
        SITE / 'styles.css',
        SITE / 'release.js',
        SITE / 'assets' / 'icon.svg',
        SITE / '.nojekyll',
    ]
    missing = [path.relative_to(ROOT) for path in required_site_files if not path.is_file()]
    if missing:
        return fail(f'Missing site assets: {missing}.')

    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for old_download in DOWNLOADS.glob('AutoChatter-*.zip'):
        old_download.unlink()
    shutil.copy2(zip_path, DOWNLOADS / 'AutoChatter-latest.zip')
    shutil.copy2(zip_path, DOWNLOADS / f'AutoChatter-{version}.zip')
    release_metadata = {
        'name': 'AutoChatter',
        'id': plugin_id,
        'version': version,
        'download': 'downloads/AutoChatter-latest.zip',
        'versionedDownload': f'downloads/AutoChatter-{version}.zip',
    }
    (SITE / 'release.json').write_text(
        json.dumps(release_metadata, indent=2) + '\n', encoding='utf-8'
    )
    print(
        f'Validated site and staged AutoChatter {version}: '
        f'{(DOWNLOADS / "AutoChatter-latest.zip").relative_to(ROOT)}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
