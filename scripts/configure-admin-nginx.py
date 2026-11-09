#!/usr/bin/env python3
"""Add bounded admin photo uploads to the existing GarageShare Nginx site.
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
    if re.search(r'\blocation\s+/api/staff/garages/\s*\{', contents):
        raise ValueError('An admin upload location already exists. Review its client_max_body_size (8m); no changes made.')
    locations = list(re.finditer(r'(?m)^([ \t]*)location\s+/\s*\{', contents))
    if len(locations) != 1:
        raise ValueError('Expected exactly one location / block. Review the site manually; no changes made.')
    found = locations[0]
    indent = found.group(1)
    block = '''location /api/staff/garages/ {
    client_max_body_size 8m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 30s;
}
'''
    block = '\n'.join(indent + line if line else line for line in block.split('\n'))
    return contents[:found.start()] + block + contents[found.start():]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', nargs='?', default='/etc/nginx/sites-available/garageshare')
    parser.add_argument('--check', action='store_true', help='Print the proposed site without writing or reloading')
    args = parser.parse_args()
    site = Path(args.site).resolve(strict=True)
    updated = configured_site(site.read_text())
    if args.check:
        print(updated)
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
    print(f'Admin upload route enabled. Original configuration: {backup}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
