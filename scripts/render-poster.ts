import { writeFileSync } from 'node:fs';
import { renderQrPoster } from '../src/modules/orders/qr-poster';

renderQrPoster('https://gdkites.in/shop/').then((b) => writeFileSync(process.argv[2] ?? 'qr-poster.pdf', b));
