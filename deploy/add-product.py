#!/usr/bin/env python3
"""Adds one product to the live catalogue from a JSON file (run on the server as root).

    sudo python3 add-product.py product.json [photo.jpg]

product.json:
  {"name": "Fighter Kite", "category": "fighterKites", "price": 25, "unit": "piece",
   "size": "Medium", "inStock": true, "isDamaged": false, "damageNote": null,
   "material": "Kite paper + bamboo", "description": "...", "slabQty": 500, "slabPrice": 23}

category: fighterKites | designerKites | manjha | accessories. size: a name from the size
master, or omitted. The photo is copied into the uploads folder under a random name.
Values go to psql as variables, never pasted into SQL.
"""
import json
import os
import shutil
import subprocess
import sys
import uuid

ENV = '/etc/gdkites/api.env'
UPLOADS = '/srv/gdkites/data/uploads'


def env():
    out = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k] = v
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    p = json.load(open(sys.argv[1], encoding='utf-8'))
    cfg = env()
    db = cfg['DATABASE_URL'].split('?', 1)[0]
    base = cfg.get('PUBLIC_BASE_URL', 'https://api.gdkites.in').rstrip('/')

    for field in ('name', 'category', 'price'):
        if p.get(field) in (None, ''):
            sys.exit(f'Missing "{field}".')
    slab_qty, slab_price = p.get('slabQty'), p.get('slabPrice')
    if (slab_qty is None) != (slab_price is None):
        sys.exit('slabQty and slabPrice go together.')
    if slab_price is not None and slab_price >= p['price']:
        sys.exit('slabPrice must be below price.')

    image_url = None
    if len(sys.argv) > 2:
        src = sys.argv[2]
        ext = os.path.splitext(src)[1].lower()
        if ext not in ('.jpg', '.jpeg', '.png', '.webp'):
            sys.exit('Photo must be .jpg, .png or .webp')
        name = f'{uuid.uuid4()}{".jpg" if ext == ".jpeg" else ext}'
        shutil.copyfile(src, os.path.join(UPLOADS, name))
        shutil.chown(os.path.join(UPLOADS, name), 'gdkites', 'gdkites')
        os.chmod(os.path.join(UPLOADS, name), 0o644)
        image_url = f'{base}/uploads/{name}'

    is_damaged = bool(p.get('isDamaged', False))
    values = {
        'name': p['name'].strip(),
        'category': p['category'],
        'size': p.get('size') or '',
        'price': str(p['price']),
        'unit': (p.get('unit') or 'piece').strip(),
        'in_stock': 'true' if p.get('inStock', True) else 'false',
        'is_damaged': 'true' if is_damaged else 'false',
        'damage_note': (p.get('damageNote') or '') if is_damaged else '',
        'material': p.get('material') or '',
        'description': (p.get('description') or '').strip(),
        'slab_qty': '' if slab_qty is None else str(slab_qty),
        'slab_price': '' if slab_price is None else str(slab_price),
        'image_url': image_url or '',
    }
    sql = """
INSERT INTO "Product" (id, name, "categoryId", "sizeId", price, unit, "inStock", "isDamaged", "damageNote",
                       description, material, "slabQty", "slabPrice", "imageUrl", "updatedAt")
SELECT gen_random_uuid()::text, :'name', c.id,
       (SELECT s.id FROM "Size" s WHERE s.name = NULLIF(:'size', '') AND s."isActive"),
       :'price'::numeric, :'unit', :'in_stock'::boolean, :'is_damaged'::boolean, NULLIF(:'damage_note', ''),
       :'description', NULLIF(:'material', ''), NULLIF(:'slab_qty', '')::int, NULLIF(:'slab_price', '')::numeric,
       NULLIF(:'image_url', ''), now()
FROM "Category" c WHERE c.slug = :'category' AND c."isActive"
RETURNING id, name, (SELECT name FROM "Size" WHERE id = "sizeId") AS size, price, "inStock", "isDamaged", "imageUrl";
"""
    args = ['psql', db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', ' | ']
    for k, v in values.items():
        args += ['-v', f'{k}={v}']
    res = subprocess.run(args, input=sql, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(res.stderr.strip())
    rows = [r for r in res.stdout.strip().splitlines() if '|' in r]
    if not rows:
        sys.exit(f'Not added: unknown category "{values["category"]}".')
    if values['size'] and rows[0].split(' | ')[2] == '':
        print(f'Warning: size "{values["size"]}" not found; product saved without a size.')
    print(rows[0])


if __name__ == '__main__':
    main()
