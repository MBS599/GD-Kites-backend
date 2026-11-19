import { renderQrPoster } from './qr-poster';

describe('shop QR poster', () => {
  it('is a one-page PDF', async () => {
    const pdf = await renderQrPoster('https://gdkites.in/shop/');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});
