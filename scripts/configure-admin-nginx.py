#!/usr/bin/env python3
"""Add bounded host and admin photo uploads to the existing GarageShare Nginx site.
Preserves Certbot directives. Backs up and rolls back on nginx validation failure.
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
import sys


def configured_site(contents):
    if not re.search(r'\bserver_name\s+garageshare\.xyz\s*;', contents):
        raise ValueError('Expected the existing garageshare.xyz site. No changes made.')
    required = ['/api/staff/garages/', '/api/host/garages']
    missing = []
    for route in required:
        existing = re.search(r'\blocation\s+' + re.escape(route) + r'\s*\{([^}]*)\}', contents)
        if existing:
            if not re.search(r'\bclient_max_body_size\s+8m\s*;', existing.group(1)):
                raise ValueError(f'Existing {route} upload location needs review (expected 8m). No changes made.')
        else:
            missing.append(route)
    if not missing:
        return contents
    locations = list(re.finditer(r'(?m)^([ \t]*)location\s+/\s*\{', contents))
    if len(locations) != 1:
        raise ValueError('Expected exactly one location / block. Review the site manually; no changes made.')
    found = locations[0]
    indent = found.group(1)
    blocks = []
    for route in missing:
        block = f'''location {route} {{
    client_max_body_size 8m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 30s;
}}
'''
        blocks.append('\n'.join(indent + line if line else line for line in block.split('\n')))
    return contents[:found.start()] + ''.join(blocks) + contents[found.start():]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', nargs='?', default='/etc/nginx/sites-available/garageshare')
    parser.add_argument('--check', action='store_true', help='Print the proposed site without writing or reloading')
    args = parser.parse_args()
    site = Path(args.site).resolve(strict=True)
    original = site.read_text()
    updated = configured_site(original)
    if args.check:
        print(updated)
        return
    if updated == original:
        print('Host and admin upload routes are already configured; no changes needed.')
        return
    subprocess.run(['nginx', '-t'], check=True)
    backup = site.with_name(site.name + '.backup-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f'))
    shutil.copy2(site, backup)
    try:
        site.write_text(updated)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        shutil.copy2(backup, site)
        subprocess.run(['nginx', '-t'], check=False)
        raise
    print(f'Host and admin upload routes enabled. Original configuration: {backup}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
