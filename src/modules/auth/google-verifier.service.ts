import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { AppConfig } from '../../config/app-config.service';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  photoUrl?: string;
}

@Injectable()
export class GoogleVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly config: AppConfig) {}

  /** Verifies signature, expiry, audience and that the email is verified. */
  async verify(idToken: string): Promise<GoogleIdentity> {
    const audience = this.config.get('GOOGLE_CLIENT_ID');
    if (audience.length === 0) throw new UnauthorizedException('Google Sign-In is not configured on the server.');
    let payload;
    try {
      payload = (await this.client.verifyIdToken({ idToken, audience })).getPayload();
    } catch {
      throw new UnauthorizedException('Google sign-in failed. Please try again.');
    }
    if (!payload?.email || !payload.email_verified) {
      throw new UnauthorizedException('Your Google account email is not verified.');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email.split('@')[0],
      photoUrl: payload.picture,
    };
  }
}
