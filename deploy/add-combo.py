#!/usr/bin/env python3
"""Adds one combo (several products sold together at one price) to the live catalogue.
Run on the server as root:

    sudo python3 add-combo.py combo.json            # check only
    sudo python3 add-combo.py combo.json --save     # add it

combo.json:
  {"name": "Retailer Combo - 12 Jhalar Kites + 6 Plastic Charkha", "category": "designerKites",
   "price": 199, "description": "...", "highlights": ["..."],
   "items": [{"name": "Jhalar 27.5 inch", "price": 5.5, "qty": 12},
             {"name": "Plastic Charkha", "price": 25, "qty": 6}]}

Each item is matched by name + price (products that share a name, like the three Plastic
Charkhas, differ by price) and must match exactly one active, ordinary product. Nothing is
written unless every item matches and no active product already has the combo's name.
The combo is then like one made in the admin app: it can be edited or hidden there
(Products → the combo → switch off "In stock", or delete it). Values go to psql as
variables, never pasted into SQL.
"""
import json
import os
import subprocess
import sys

ENV = os.environ.get('GDK_ENV_FILE', '/etc/gdkites/api.env')


def env():
    out = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k] = v
    return out


def psql(db, sql, variables):
    args = os.environ.get('GDK_PSQL', 'psql').split() + [db, '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-F', '|']
    for k, v in variables.items():
        args += ['-v', f'{k}={v}']
    res = subprocess.run(args, input=sql, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(res.stderr.strip())
    return res.stdout.strip()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    c = json.load(open(sys.argv[1], encoding='utf-8'))
    save = '--save' in sys.argv[2:]
    for field in ('name', 'category', 'price', 'items'):
        if c.get(field) in (None, '', []):
            sys.exit(f'Missing "{field}".')
    items = c['items']
    if len({(i['name'], float(i['price'])) for i in items}) != len(items):
        sys.exit('Each product can be in a combo only once; change its qty instead.')
    if sum(int(i['qty']) for i in items) < 2 or any(int(i['qty']) < 1 for i in items):
        sys.exit('A combo needs at least two pieces, and every qty must be at least 1.')
    db = env()['DATABASE_URL'].split('?', 1)[0]

    variables = {'name': c['name'].strip(), 'cat': c['category'], 'price': str(c['price'])}
    for i, it in enumerate(items):
        variables[f'n{i}'] = it['name']
        variables[f'p{i}'] = str(it['price'])
        variables[f'q{i}'] = str(int(it['qty']))

    # 1. Every item: exactly one active, ordinary product. The combo's name is free. Category exists.
    found = psql(db, '\n'.join(
        [f'SELECT {i}, count(*), min(id), min(price::text) FROM "Product" WHERE name = :\'n{i}\' AND price = :\'p{i}\'::numeric '
         f'AND "isActive" AND NOT "isCombo";' for i in range(len(items))]
        + ['SELECT \'dup\', count(*) FROM "Product" WHERE name = :\'name\' AND "isActive";',
           'SELECT \'cat\', count(*) FROM "Category" WHERE slug = :\'cat\' AND "isActive";']), variables)
    worth, bad = 0.0, []
    for line in found.splitlines():
        parts = line.split('|')
        if parts[0] == 'dup':
            if int(parts[1]):
                bad.append(f'  an active product is already called "{c["name"]}"')
            continue
        if parts[0] == 'cat':
            if not int(parts[1]):
                bad.append(f'  unknown category "{c["category"]}"')
            continue
        i, n = int(parts[0]), int(parts[1])
        if n != 1:
            bad.append(f'  {items[i]["name"]} (price {items[i]["price"]}): {n} matches')
        else:
            variables[f'id{i}'] = parts[2]
            worth += float(parts[3]) * int(items[i]['qty'])
    if bad:
        sys.exit('Nothing added:\n' + '\n'.join(bad))
    for it in items:
        print(f'  {it["qty"]} x {it["name"]} @ Rs {it["price"]}')
    print(f'Worth Rs {worth:g} separately; combo price Rs {c["price"]}'
          + (f' (customers save Rs {worth - float(c["price"]):g})' if worth > float(c['price']) else ' (no saving shown)'))
    if not save:
        print('Check only. Run again with --save to add it.')
        return

    # 2. The combo and its lines, in one statement (all or nothing).
    variables['desc'] = (c.get('description') or '').strip()
    variables['hl'] = json.dumps(c.get('highlights') or [], ensure_ascii=False)
    values = ', '.join(f"(:'id{i}', :'q{i}'::int, {i})" for i in range(len(items)))
    row = psql(db, f'''
WITH combo AS (
  INSERT INTO "Product" (id, name, "categoryId", price, unit, "isCombo", "inStock", description, highlights, "updatedAt")
  SELECT gen_random_uuid()::text, :'name', id, :'price'::numeric, 'combo', true, true, :'desc',
         ARRAY(SELECT jsonb_array_elements_text(:'hl'::jsonb)), now()
  FROM "Category" WHERE slug = :'cat'
  RETURNING id, name, price
), lines AS (
  INSERT INTO "ComboItem" (id, "comboId", "productId", qty, "sortOrder")
  SELECT gen_random_uuid()::text, combo.id, v.pid, v.qty, v.ord FROM combo, (VALUES {values}) AS v(pid, qty, ord)
  RETURNING 1
)
SELECT combo.id, combo.name, combo.price, (SELECT count(*) FROM lines) FROM combo;''', variables)
    print('Added:', row)


if __name__ == '__main__':
    main()
