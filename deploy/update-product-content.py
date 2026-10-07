#!/usr/bin/env python3
"""Fills in product descriptions, highlights and specifications in the live catalogue
from a JSON file (run on the server as root). Prices, photos, stock and sizes are not touched.

    sudo python3 update-product-content.py product-content.json            # check only
    sudo python3 update-product-content.py product-content.json --save     # write

Each entry is matched by category slug + name + price, so products that share a name
(e.g. three "Plastic Charkha" sizes) are told apart. Every entry must match exactly one
product, otherwise nothing is written. Before writing, the current values of the matched
products are saved to /var/backups/gdkites/product-content-<time>.json.
Values go to psql as variables, never pasted into SQL.
"""
import datetime
import json
import os
import subprocess
import sys

ENV = os.environ.get('GDK_ENV_FILE', '/etc/gdkites/api.env')
BACKUPS = os.environ.get('GDK_BACKUPS', '/var/backups/gdkites')


def env():
    out = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k] = v
    return out


def psql(db, sql, variables):
    args = os.environ.get('GDK_PSQL', 'psql').split() + [db, '-v', 'ON_ERROR_STOP=1', '-At', '-q']
    for k, v in variables.items():
        args += ['-v', f'{k}={v}']
    res = subprocess.run(args, input=sql, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(res.stderr.strip())
    return res.stdout.strip()


def validate(items):
    for i, p in enumerate(items):
        where = f'entry {i + 1} ({p.get("name")})'
        for field in ('name', 'category', 'price', 'description'):
            if p.get(field) in (None, ''):
                sys.exit(f'{where}: missing "{field}".')
        if len(p['description']) > 5000:
            sys.exit(f'{where}: description is over 5000 characters.')
        hl = p.get('highlights', [])
        if len(hl) > 10 or any(not h or len(h) > 160 for h in hl):
            sys.exit(f'{where}: up to 10 highlights of 1–160 characters.')
        for s in p.get('specs', []):
            if not (1 <= len(s.get('label', '')) <= 40 and 1 <= len(s.get('value', '')) <= 160):
                sys.exit(f'{where}: spec labels are 1–40 characters, values 1–160.')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    items = json.load(open(sys.argv[1], encoding='utf-8'))
    save = '--save' in sys.argv[2:]
    validate(items)
    db = env()['DATABASE_URL'].split('?', 1)[0]

    # One variable set per entry: n0, c0, p0, d0, h0, s0, n1, ...
    variables = {}
    for i, p in enumerate(items):
        variables[f'n{i}'] = p['name']
        variables[f'c{i}'] = p['category']
        variables[f'p{i}'] = str(p['price'])
        variables[f'd{i}'] = p['description'].strip()
        variables[f'h{i}'] = json.dumps(p.get('highlights', []), ensure_ascii=False)
        variables[f's{i}'] = json.dumps(p.get('specs', []), ensure_ascii=False)

    match = lambda i: (f'p."categoryId" = (SELECT id FROM "Category" WHERE slug = :\'c{i}\') '
                       f'AND p.name = :\'n{i}\' AND p.price = :\'p{i}\'::numeric')

    # 1. Every entry must match exactly one product.
    counts = psql(db, '\n'.join(
        f'SELECT {i}, count(*) FROM "Product" p WHERE {match(i)};' for i in range(len(items))), variables)
    bad = []
    for line in counts.splitlines():
        i, n = (int(x) for x in line.split('|'))
        if n != 1:
            p = items[i]
            bad.append(f'  {p["name"]} ({p["category"]}, price {p["price"]}): {n} matches')
    if bad:
        sys.exit('Nothing written. These entries must match exactly one product:\n' + '\n'.join(bad))
    print(f'All {len(items)} entries match one product each.')
    if not save:
        print('Check only. Run again with --save to write.')
        return

    # 2. Back up what is there now.
    backup = psql(db, 'SELECT coalesce(json_agg(x), \'[]\') FROM (' + ' UNION ALL '.join(
        f'SELECT p.id, p.name, p.price, p.description, p.highlights, p.specs FROM "Product" p WHERE {match(i)}'
        for i in range(len(items))) + ') x;', variables)
    os.makedirs(BACKUPS, exist_ok=True)
    path = os.path.join(BACKUPS, 'product-content-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(backup)
    print(f'Previous values saved to {path}')

    # 3. Write everything in one transaction.
    sql = ['BEGIN;']
    for i in range(len(items)):
        sql.append(
            f'UPDATE "Product" p SET description = :\'d{i}\', '
            f'highlights = ARRAY(SELECT jsonb_array_elements_text(:\'h{i}\'::jsonb)), '
            f'specs = :\'s{i}\'::jsonb, "updatedAt" = now() WHERE {match(i)};')
    sql.append('COMMIT;')
    psql(db, '\n'.join(sql), variables)
    print(f'Saved descriptions, highlights and specifications for {len(items)} products.')


if __name__ == '__main__':
    main()
