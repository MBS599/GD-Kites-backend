import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Public, type AuthUser } from '../../common/auth.decorators';
import { userOut } from '../../common/serializers';
import { AppConfig } from '../../config/app-config.service';
import { AuthSessionDto, DevLoginDto, GoogleSignInDto, OtpRequestDto, OtpVerifyDto, RefreshDto } from './auth.dto';
import { PhoneOtpService } from './phone-otp.service';
import { AuthService } from './auth.service';

type Session = Awaited<ReturnType<AuthService['refresh']>>;
const strip = ({ refreshTokenId: _, ...rest }: Session) => rest;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly phoneOtp: PhoneOtpService,
  ) {}

  /** Exchange a Google ID token for an access + refresh token pair. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthSessionDto })
  async google(@Body() dto: GoogleSignInDto, @Headers('user-agent') ua?: string) {
    return strip(await this.auth.signInWithGoogle(dto.idToken, ua));
  }

  /** Send a 6-digit sign-in code by SMS. Rate-limited per number and per IP. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(200)
  async otpRequest(@Body() dto: OtpRequestDto) {
    return this.phoneOtp.request(dto.phone);
  }

  /**
   * Exchange the SMS code for a session. New numbers become customer accounts
   * (send `name`; without it the API answers 422 `name_required` and the code stays valid).
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthSessionDto })
  async otpVerify(@Body() dto: OtpVerifyDto, @Headers('user-agent') ua?: string) {
    const user = await this.phoneOtp.verify(dto.phone, dto.code, dto.name);
    return strip(await this.auth.startSession(user, ua));
  }

  /** Rotate the refresh token. The old refresh token becomes invalid. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthSessionDto })
  async refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua?: string) {
    return strip(await this.auth.refresh(dto.refreshToken, ua));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Body() dto: Partial<RefreshDto>) {
    await this.auth.logout(dto?.refreshToken, user.id);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { user: userOut(user) };
  }

  /** Public flags the app uses to decide which sign-in options to show. */
  @Public()
  @Get('config')
  authConfig() {
    return {
      devLogin: this.config.devLoginEnabled,
      googleConfigured: this.config.get('GOOGLE_CLIENT_ID').length > 0,
      otpLogin: this.phoneOtp.enabled,
      otpChannel: this.phoneOtp.channel,
    };
  }

  /** Development only (ALLOW_DEV_LOGIN=true, never in production): sign in as a seeded account. */
  @Public()
  @Post('dev-login')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthSessionDto })
  async devLogin(@Body() dto: DevLoginDto, @Headers('user-agent') ua?: string) {
    if (!this.config.devLoginEnabled) throw new NotFoundException('Route not found.');
    return strip(await this.auth.devLogin(dto.email, ua));
  }
}
